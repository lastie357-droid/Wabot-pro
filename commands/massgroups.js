const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

const MAX_GROUP_MEMBERS = 1000;
const MAX_ADDITIONS = MAX_GROUP_MEMBERS - 1; // bot occupies 1 slot
const SESSION_TIMEOUT = 10 * 60 * 1000;

const VERIFY_CONCURRENCY = 20;
const VERIFY_BATCH_DELAY = 600;
const PROGRESS_INTERVAL = 1000;
const GROUP_CREATE_DELAY = 5000;

const pendingSessions = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [key, val] of pendingSessions.entries()) {
        if (now - val.timestamp > SESSION_TIMEOUT) pendingSessions.delete(key);
    }
}, 60_000);

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
                const num = match[1].replace(/[^0-9]/g, '').trim();
                if (num.length >= 7 && num.length <= 15 && !seen.has(num)) {
                    seen.add(num);
                    numbers.push(num);
                }
            }
        }
    }

    return numbers;
}

async function processVCF(sock, chatId, docMsg, baseName, triggerMessage) {
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
            text: `📊 Parsed *${rawNumbers.length.toLocaleString()}* unique contact(s).\n⏳ Verifying WhatsApp registration in batches of ${VERIFY_CONCURRENCY}...\n\n_Estimated time: ~${Math.ceil(rawNumbers.length / VERIFY_CONCURRENCY * VERIFY_BATCH_DELAY / 60000)} minute(s)_`
        });

        const validJids = [];
        let checked = 0;
        let lastProgressAt = 0;

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

            if (checked - lastProgressAt >= PROGRESS_INTERVAL || checked === rawNumbers.length) {
                lastProgressAt = checked;
                const pct = Math.round((checked / rawNumbers.length) * 100);
                await sock.sendMessage(chatId, {
                    text: `🔍 Checked *${checked.toLocaleString()}/${rawNumbers.length.toLocaleString()}* (${pct}%) — *${validJids.length.toLocaleString()}* valid so far`
                });
            }

            if (i + VERIFY_CONCURRENCY < rawNumbers.length) {
                await new Promise(r => setTimeout(r, VERIFY_BATCH_DELAY));
            }
        }

        if (validJids.length === 0) {
            await sock.sendMessage(chatId, {
                text: '❌ None of the contacts are registered on WhatsApp.'
            });
            return;
        }

        const groupsNeeded = Math.ceil(validJids.length / MAX_ADDITIONS);
        await sock.sendMessage(chatId, {
            text: `✅ *${validJids.length.toLocaleString()}* WhatsApp contact(s) verified.\n📦 Will create *${groupsNeeded}* group(s) of up to ${MAX_GROUP_MEMBERS} members.\n🔄 Starting group creation...`
        });

        const createdGroups = [];
        let groupIndex = 1;

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

                await sock.sendMessage(chatId, {
                    text: `✅ *${groupName}* created! (${groupIndex}/${groupsNeeded})\n👥 Members added: *${added}*  ⚠️ Skipped: *${skipped}*`
                });

                groupIndex++;

                if (i + MAX_ADDITIONS < validJids.length) {
                    await new Promise(r => setTimeout(r, GROUP_CREATE_DELAY));
                }
            } catch (e) {
                await sock.sendMessage(chatId, {
                    text: `❌ Failed to create *${groupName}*: ${e.message}`
                });
                groupIndex++;
                await new Promise(r => setTimeout(r, GROUP_CREATE_DELAY));
            }
        }

        const totalAdded = createdGroups.reduce((s, g) => s + g.added, 0);
        const totalSkipped = createdGroups.reduce((s, g) => s + g.skipped, 0);

        await sock.sendMessage(chatId, {
            text: `🎉 *Mass Group Creation Complete!*\n\n📋 Contacts in VCF: *${rawNumbers.length.toLocaleString()}*\n✅ On WhatsApp: *${validJids.length.toLocaleString()}*\n📦 Groups Created: *${createdGroups.length}*\n👥 Total Members Added: *${totalAdded.toLocaleString()}*\n⚠️ Total Skipped: *${totalSkipped.toLocaleString()}*\n\n_Skipped contacts may have privacy settings preventing being added to groups._`
        });

    } catch (err) {
        console.error('massgroups error:', err);
        await sock.sendMessage(chatId, {
            text: '❌ Error processing VCF file: ' + err.message
        });
    }
}

async function massGroupsCommand(sock, chatId, senderId, message, groupBaseName) {
    const baseName = groupBaseName && groupBaseName.trim() ? groupBaseName.trim() : 'Mass Group';

    // ── Mode 1: reply to a VCF message ────────────────────────────────────
    const quotedDoc = message.message?.extendedTextMessage?.contextInfo?.quotedMessage?.documentMessage;
    if (quotedDoc && isVcfDoc(quotedDoc)) {
        await sock.sendMessage(chatId, {
            text: `📋 *Mass Group Creator*\n\n📝 Group prefix: *${baseName}*\nGroups: *${baseName}1*, *${baseName}2*, ...\n\n✅ VCF detected from your reply — starting now!`
        }, { quoted: message });
        await processVCF(sock, chatId, quotedDoc, baseName, message);
        return;
    }

    // ── Mode 2: no reply — ask user to send the VCF ───────────────────────
    pendingSessions.set(senderId, {
        chatId,
        groupBaseName: baseName,
        step: 'awaiting_vcf',
        timestamp: Date.now()
    });

    await sock.sendMessage(chatId, {
        text: `📋 *Mass Group Creator*\n\n📝 Group prefix: *${baseName}*\nGroups will be named: *${baseName}1*, *${baseName}2*, ...\n\nNow *send* or *reply to* a *VCF (contacts) file*.\n\n_What I will do:_\n• ✅ Keep only numbers registered on WhatsApp\n• ❌ Discard numbers not on WhatsApp\n• ⏭️ Skip contacts that fail to add\n• 👥 Create groups of up to ${MAX_GROUP_MEMBERS} members each\n• 🔄 Auto-create next group when limit is reached\n\n_Supports large contact lists (30 000+)._\n_⏳ Session expires in 10 minutes._`
    }, { quoted: message });
}

async function handleMassGroupsVCF(sock, message) {
    const senderId = message.key.participant || message.key.remoteJid;
    const session = pendingSessions.get(senderId);

    if (!session) return false;

    if (Date.now() - session.timestamp > SESSION_TIMEOUT) {
        pendingSessions.delete(senderId);
        return false;
    }

    // Accept a directly sent VCF document
    const docMsg = message.message?.documentMessage;
    if (!docMsg) return false;

    if (!isVcfDoc(docMsg)) {
        await sock.sendMessage(session.chatId, {
            text: '❌ That does not look like a VCF file. Please send a valid *.vcf* contacts file.'
        }, { quoted: message });
        return true;
    }

    pendingSessions.delete(senderId);
    await processVCF(sock, session.chatId, docMsg, session.groupBaseName || 'Mass Group', message);
    return true;
}

module.exports = { massGroupsCommand, handleMassGroupsVCF };
