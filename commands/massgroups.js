const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const mongoose = require('mongoose');

const MAX_GROUP_MEMBERS = 1000;
const MAX_ADDITIONS = MAX_GROUP_MEMBERS - 1;
const SESSION_TIMEOUT = 10 * 60 * 1000;

const VERIFY_CONCURRENCY = 5;         // Reduced from 20 to avoid rate-limit bans
const VERIFY_BATCH_DELAY = 1500;      // Increased from 600ms to 1500ms (safer)
const PROGRESS_INTERVAL = 1000;
const GROUP_CREATE_DELAY = 10000;     // Increased from 5000ms to 10000ms (10s, safer)
const BATCH_SIZE_FOR_GROUP = 254;     // Start group creation every 254 verified contacts

// ── MongoDB connection ─────────────────────────────────────────────────────────

let dbConnected = false;

async function getDb() {
    if (dbConnected) return;
    const uri = process.env.MONGODB_URL;
    if (!uri) throw new Error('MONGODB_URL secret is not set.');
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
    dbConnected = true;
}

// ── Schemas ────────────────────────────────────────────────────────────────────

const SessionSchema = new mongoose.Schema({
    senderId:      { type: String, required: true, unique: true },
    chatId:        { type: String, required: true },
    groupBaseName: { type: String, default: 'Mass Group' },
    step:          { type: String, default: 'awaiting_vcf' },
    timestamp:     { type: Number, required: true }
});

const JobSchema = new mongoose.Schema({
    chatId:        { type: String, required: true },
    senderId:      { type: String, required: true },
    baseName:      { type: String, required: true },
    validJids:     { type: [String], required: true },
    totalJids:     { type: Number, required: true },
    rawTotal:      { type: Number, required: true },
    nextGroupIndex:{ type: Number, default: 1 },
    createdGroups: { type: Array, default: [] },
    status:        { type: String, default: 'in_progress' },
    startedAt:     { type: Date, default: Date.now },
    updatedAt:     { type: Date, default: Date.now }
});

const MassSession = mongoose.models.MassSession || mongoose.model('MassSession', SessionSchema);
const MassJob     = mongoose.models.MassJob     || mongoose.model('MassJob',     JobSchema);

// ── Session helpers ────────────────────────────────────────────────────────────

async function saveSession(senderId, data) {
    await getDb();
    await MassSession.findOneAndUpdate(
        { senderId },
        { ...data, senderId },
        { upsert: true, new: true }
    );
}

async function getSession(senderId) {
    await getDb();
    return MassSession.findOne({ senderId }).lean();
}

async function deleteSession(senderId) {
    await getDb();
    await MassSession.deleteOne({ senderId });
}

// ── Job helpers ────────────────────────────────────────────────────────────────

async function createJob(data) {
    await getDb();
    const job = new MassJob(data);
    await job.save();
    return job;
}

async function updateJob(jobId, update) {
    await getDb();
    await MassJob.findByIdAndUpdate(jobId, { ...update, updatedAt: new Date() });
}

async function getLatestJob(chatId) {
    await getDb();
    return MassJob.findOne({ chatId, status: { $in: ['in_progress', 'paused'] } })
        .sort({ updatedAt: -1 })
        .lean();
}

async function completeJob(jobId) {
    await getDb();
    await MassJob.findByIdAndUpdate(jobId, { status: 'completed', updatedAt: new Date() });
}

// ── VCF helpers ────────────────────────────────────────────────────────────────

function isVcfDoc(docMsg) {
    if (!docMsg) return false;
    const mime = (docMsg.mimetype || '').toLowerCase();
    const fileName = (docMsg.fileName || '').toLowerCase();
    return mime.includes('vcard') || mime.includes('vcf') || fileName.endsWith('.vcf');
}

function parseVCF(vcfContent) {
    const seen = new Set();
    const numbers = [];
    const lines = vcfContent.split(/\r?\n/);
    let inVCard = false;

    for (const line of lines) {
        const trimmed = line.trim();
        const upper = trimmed.toUpperCase();

        if (upper === 'BEGIN:VCARD') {
            inVCard = true;
        } else if (upper === 'END:VCARD') {
            inVCard = false;
        } else if (inVCard && /^TEL/i.test(trimmed)) {
            const match = trimmed.match(/TEL[^:]*:(.*)/i);
            if (match) {
                let num = match[1].replace(/[^0-9]/g, '').trim();
                // Auto-prefix country code 254 if number starts with 0 (e.g., 0704897825 -> 254704897825)
                if (num.startsWith('0')) {
                    num = '254' + num.substring(1);
                }
                if (num.length >= 7 && num.length <= 15 && !seen.has(num)) {
                    seen.add(num);
                    numbers.push(num);
                }
            }
        }
    }

    return numbers;
}

// ── Core group-creation loop (shared by new runs and resume) ──────────────────

async function runGroupCreation(sock, chatId, jobId, validJids, baseName, startGroupIndex, existingCreated, rawTotal) {
    const groupsNeeded = Math.ceil(validJids.length / MAX_ADDITIONS);
    const totalGroupsOverall = startGroupIndex - 1 + groupsNeeded;

    const createdGroups = [...existingCreated];
    let groupIndex = startGroupIndex;

    for (let i = 0; i < validJids.length; i += MAX_ADDITIONS) {
        const chunk = validJids.slice(i, i + MAX_ADDITIONS);
        const groupName = `${baseName}${groupIndex}`;

        try {
            const result = await sock.groupCreate(groupName, chunk);
            const groupJid = result.id;

            let added = 0;
            let skipped = 0;
            if (result.participants) {
                for (const p of result.participants) {
                    if (p.error) skipped++;
                    else added++;
                }
                added = Math.max(0, added - 1);
            }

            createdGroups.push({ name: groupName, jid: groupJid, added, skipped });

            await updateJob(jobId, {
                nextGroupIndex: groupIndex + 1,
                createdGroups,
                status: 'in_progress'
            });

            await sock.sendMessage(chatId, {
                text: `✅ *${groupName}* created! (${groupIndex}/${totalGroupsOverall})\n👥 Members added: *${added}*  ⚠️ Skipped: *${skipped}*`
            });

            groupIndex++;

            if (i + MAX_ADDITIONS < validJids.length) {
                await new Promise(r => setTimeout(r, GROUP_CREATE_DELAY));
            }
        } catch (e) {
            await updateJob(jobId, {
                nextGroupIndex: groupIndex + 1,
                createdGroups,
                status: 'paused'
            });

            await sock.sendMessage(chatId, {
                text: `❌ Failed to create *${groupName}*: ${e.message}\n\n_Progress saved. Use *.massgroups resume* to continue._`
            });

            groupIndex++;
            await new Promise(r => setTimeout(r, GROUP_CREATE_DELAY));
        }
    }

    const totalAdded   = createdGroups.reduce((s, g) => s + g.added, 0);
    const totalSkipped = createdGroups.reduce((s, g) => s + g.skipped, 0);

    await completeJob(jobId);

    await sock.sendMessage(chatId, {
        text: `🎉 *Mass Group Creation Complete!*\n\n📋 Contacts in VCF: *${rawTotal.toLocaleString()}*\n✅ On WhatsApp: *${validJids.length.toLocaleString()}*\n📦 Groups Created: *${createdGroups.length.toLocaleString()}*\n👥 Total Members Added: *${totalAdded.toLocaleString()}*\n⚠️ Total Skipped: *${totalSkipped.toLocaleString()}*\n\n_Skipped contacts may have privacy settings preventing being added to groups._`
    });
}

// ── Concurrent verification & group creation ──────────────────────────────────

async function processVCFConcurrent(sock, chatId, senderId, docMsg, baseName, triggerMessage, rawNumbers) {
    const validJids = [];
    let verificationComplete = false;
    let checked = 0;
    let lastProgressAt = 0;
    let groupCreationStarted = false;
    let jobId = null;

    // Start verification process
    const verifyPromise = (async () => {
        for (let i = 0; i < rawNumbers.length; i += VERIFY_CONCURRENCY) {
            const batch = rawNumbers.slice(i, i + VERIFY_CONCURRENCY);

            const results = await Promise.allSettled(
                batch.map(async (num) => {
                    const jid = num + '@s.whatsapp.net';
                    const res = await sock.onWhatsApp(jid);
                    if (res && res[0]?.exists) return res[0].jid || jid;
                    return null;
                })
            );

            for (const r of results) {
                if (r.status === 'fulfilled' && r.value) validJids.push(r.value);
            }

            checked += batch.length;

            // Send progress update
            if (checked - lastProgressAt >= PROGRESS_INTERVAL || checked === rawNumbers.length) {
                lastProgressAt = checked;
                const pct = Math.round((checked / rawNumbers.length) * 100);
                await sock.sendMessage(chatId, {
                    text: `🔍 Checked *${checked.toLocaleString()}/${rawNumbers.length.toLocaleString()}* (${pct}%) — *${validJids.length.toLocaleString()}* valid so far`
                });
            }

            // **START GROUP CREATION once we have 254+ verified and haven't started yet**
            if (validJids.length >= BATCH_SIZE_FOR_GROUP && !groupCreationStarted) {
                groupCreationStarted = true;
                const groupsNeeded = Math.ceil(rawNumbers.length / MAX_ADDITIONS);
                await sock.sendMessage(chatId, {
                    text: `✅ *${validJids.length.toLocaleString()}* contacts verified! 🚀 Starting group creation...\n📦 Will create ~*${groupsNeeded}* groups.\n\n_Verification continues in background..._`
                });

                // Create job and start group creation in background (don't await - let verification continue)
                jobId = await initiateConcurrentGroupCreation(sock, chatId, senderId, baseName, validJids, rawNumbers.length);
            }

            if (i + VERIFY_CONCURRENCY < rawNumbers.length) {
                await new Promise(r => setTimeout(r, VERIFY_BATCH_DELAY));
            }
        }

        verificationComplete = true;
    })();

    // Wait for verification to complete
    await verifyPromise;

    if (validJids.length === 0) {
        await sock.sendMessage(chatId, {
            text: '❌ None of the contacts are registered on WhatsApp.'
        });
        return;
    }

    // If group creation wasn't started (< 254 contacts), start it now
    if (!groupCreationStarted && validJids.length > 0) {
        const groupsNeeded = Math.ceil(validJids.length / MAX_ADDITIONS);
        await sock.sendMessage(chatId, {
            text: `✅ All *${validJids.length.toLocaleString()}* verified contacts.\n📦 Creating *${groupsNeeded}* group(s)...`
        });
        jobId = await initiateConcurrentGroupCreation(sock, chatId, senderId, baseName, validJids, rawNumbers.length);
    }
}

// ── Initialize concurrent group creation ───────────────────────────────────────

async function initiateConcurrentGroupCreation(sock, chatId, senderId, baseName, validJids, rawTotal) {
    const job = await createJob({
        chatId,
        senderId,
        baseName,
        validJids,
        totalJids: validJids.length,
        rawTotal,
        nextGroupIndex: 1,
        createdGroups: [],
        status: 'in_progress'
    });

    // Run group creation in background (don't wait for it to complete)
    runGroupCreation(sock, chatId, job._id, validJids, baseName, 1, [], rawTotal).catch(err => {
        console.error('Group creation error:', err);
    });

    return job._id;
}

// ── processVCF ────────────────────────────────────────────────────────────────

async function processVCF(sock, chatId, senderId, docMsg, baseName, triggerMessage) {
    await sock.sendMessage(chatId, {
        text: '⏳ VCF received! Downloading and parsing contacts...'
    }, { quoted: triggerMessage });

    try {
        const stream = await downloadContentFromMessage(docMsg, 'document');
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const vcfContent = Buffer.concat(chunks).toString('utf8');

        const rawNumbers = parseVCF(vcfContent);

        if (rawNumbers.length === 0) {
            await sock.sendMessage(chatId, {
                text: '❌ No phone numbers found in the VCF file. Make sure the file has TEL fields.'
            });
            return;
        }

        await sock.sendMessage(chatId, {
            text: `📊 Parsed *${rawNumbers.length.toLocaleString()}* unique contact(s).\n🌍 Auto-prefixed country code 254 to numbers starting with 0.\n⏳ Verifying WhatsApp registration (starting group creation at 254 verified)...\n\n_Verification runs in parallel with group creation for speed!_`
        });

        // Use concurrent verification & group creation
        await processVCFConcurrent(sock, chatId, senderId, docMsg, baseName, triggerMessage, rawNumbers);

    } catch (err) {
        console.error('massgroups error:', err);
        await sock.sendMessage(chatId, {
            text: '❌ Error processing VCF file: ' + err.message
        });
    }
}

// ── massGroupsCommand ─────────────────────────────────────────────────────────

async function massGroupsCommand(sock, chatId, senderId, message, groupBaseName) {
    const baseName = groupBaseName && groupBaseName.trim() ? groupBaseName.trim() : 'Mass Group';

    // Mode 1: reply to a VCF message
    const quotedDoc = message.message?.extendedTextMessage?.contextInfo?.quotedMessage?.documentMessage;
    if (quotedDoc && isVcfDoc(quotedDoc)) {
        await sock.sendMessage(chatId, {
            text: `📋 *Mass Group Creator*\n\n📝 Group prefix: *${baseName}*\nGroups: *${baseName}1*, *${baseName}2*, ...\n\n✅ VCF detected from your reply — starting now!`
        }, { quoted: message });
        await processVCF(sock, chatId, senderId, quotedDoc, baseName, message);
        return;
    }

    // Mode 2: no reply — ask user to send the VCF
    await saveSession(senderId, {
        chatId,
        groupBaseName: baseName,
        step: 'awaiting_vcf',
        timestamp: Date.now()
    });

    await sock.sendMessage(chatId, {
        text: `📋 *Mass Group Creator*\n\n📝 Group prefix: *${baseName}*\nGroups will be named: *${baseName}1*, *${baseName}2*, ...\n\nNow *send* or *reply to* a *VCF (contacts) file*.\n\n_What I will do:_\n• 🌍 Auto-prefix country code 254 to numbers starting with 0\n• ✅ Keep only numbers registered on WhatsApp\n• ❌ Auto-skip numbers not on WhatsApp or invalid\n• ⏭️ Skip contacts that fail to add\n• 👥 Create groups of up to ${MAX_GROUP_MEMBERS} members each\n• 🔄 Auto-create next group when limit is reached\n\n_Supports large contact lists (30 000+)._\n_Progress is saved — use *.massgroups resume* if the bot restarts._\n_⏳ Session expires in 10 minutes._`
    }, { quoted: message });
}

// ── massGroupsResumeCommand ───────────────────────────────────────────────────

async function massGroupsResumeCommand(sock, chatId, senderId) {
    let job;
    try {
        job = await getLatestJob(chatId);
    } catch (err) {
        await sock.sendMessage(chatId, {
            text: '❌ Could not reach the database: ' + err.message
        });
        return;
    }

    if (!job) {
        await sock.sendMessage(chatId, {
            text: '⚠️ No paused or in-progress mass group job found for this chat.\n\nUse *.massgroups <name>* to start a new one.'
        });
        return;
    }

    const remaining = job.validJids.slice((job.nextGroupIndex - 1) * MAX_ADDITIONS);
    const groupsLeft = Math.ceil(remaining.length / MAX_ADDITIONS);
    const groupsDone = job.createdGroups.length;

    await sock.sendMessage(chatId, {
        text: `▶️ *Resuming Mass Group Job*\n\n📝 Prefix: *${job.baseName}*\n✅ Valid contacts: *${job.validJids.length.toLocaleString()}*\n📦 Groups already created: *${groupsDone}*\n🔄 Groups remaining: *${groupsLeft}*\n\nContinuing from *${job.baseName}${job.nextGroupIndex}*...`
    });

    const remainingJids = job.validJids.slice((job.nextGroupIndex - 1) * MAX_ADDITIONS);

    await runGroupCreation(
        sock,
        chatId,
        job._id,
        remainingJids,
        job.baseName,
        job.nextGroupIndex,
        job.createdGroups,
        job.rawTotal
    );
}

// ── handleMassGroupsVCF ───────────────────────────────────────────────────────

async function handleMassGroupsVCF(sock, message) {
    const senderId = message.key.participant || message.key.remoteJid;

    let session;
    try {
        session = await getSession(senderId);
    } catch (err) {
        console.error('massgroups session fetch error:', err);
        return false;
    }

    if (!session) return false;

    if (Date.now() - session.timestamp > SESSION_TIMEOUT) {
        await deleteSession(senderId);
        return false;
    }

    const docMsg = message.message?.documentMessage;
    if (!docMsg) return false;

    if (!isVcfDoc(docMsg)) {
        await sock.sendMessage(session.chatId, {
            text: '❌ That does not look like a VCF file. Please send a valid *.vcf* contacts file.'
        }, { quoted: message });
        return true;
    }

    await deleteSession(senderId);
    await processVCF(sock, session.chatId, senderId, docMsg, session.groupBaseName || 'Mass Group', message);
    return true;
}

module.exports = { massGroupsCommand, massGroupsResumeCommand, handleMassGroupsVCF };
