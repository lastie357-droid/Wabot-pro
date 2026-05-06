const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

const MAX_GROUP_MEMBERS = 1000;
const SESSION_TIMEOUT = 5 * 60 * 1000;

const pendingSessions = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [key, val] of pendingSessions.entries()) {
        if (now - val.timestamp > SESSION_TIMEOUT) {
            pendingSessions.delete(key);
        }
    }
}, 60_000);

function parseVCF(vcfContent) {
    const numbers = [];
    const lines = vcfContent.split(/\r?\n/);
    let inVCard = false;

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.toUpperCase() === 'BEGIN:VCARD') {
            inVCard = true;
        } else if (trimmed.toUpperCase() === 'END:VCARD') {
            inVCard = false;
        } else if (inVCard && /^TEL/i.test(trimmed)) {
            const match = trimmed.match(/TEL[^:]*:(.*)/i);
            if (match) {
                const num = match[1].replace(/[^0-9]/g, '').trim();
                if (num.length >= 7 && num.length <= 15) {
                    numbers.push(num);
                }
            }
        }
    }

    return [...new Set(numbers)];
}

async function massGroupsCommand(sock, chatId, senderId, message) {
    pendingSessions.set(senderId, {
        chatId,
        step: 'awaiting_vcf',
        timestamp: Date.now()
    });

    await sock.sendMessage(chatId, {
        text: `📋 *Mass Group Creator*\n\nPlease send the *VCF (contacts) file* now.\n\n_What I will do:_\n• ✅ Keep only numbers registered on WhatsApp\n• ❌ Discard numbers not on WhatsApp\n• ⏭️ Skip contacts already in existing groups\n• 👥 Create groups of up to ${MAX_GROUP_MEMBERS} members each\n• 🔄 Auto-create next group when limit is reached\n\n_⏳ Session expires in 5 minutes._`
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

    const docMsg = message.message?.documentMessage;
    if (!docMsg) return false;

    const mime = (docMsg.mimetype || '').toLowerCase();
    const fileName = (docMsg.fileName || '').toLowerCase();
    const isVcf = mime.includes('vcard') || mime.includes('vcf') || fileName.endsWith('.vcf');

    if (!isVcf) {
        await sock.sendMessage(session.chatId, {
            text: '❌ That does not look like a VCF file. Please send a valid *.vcf* contacts file.'
        }, { quoted: message });
        return true;
    }

    pendingSessions.delete(senderId);

    await sock.sendMessage(session.chatId, {
        text: '⏳ VCF received! Parsing contacts...'
    }, { quoted: message });

    try {
        const stream = await downloadContentFromMessage(docMsg, 'document');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        const vcfContent = buffer.toString('utf8');

        const rawNumbers = parseVCF(vcfContent);

        if (rawNumbers.length === 0) {
            await sock.sendMessage(session.chatId, {
                text: '❌ No phone numbers found in the VCF file. Make sure the file has TEL fields.'
            });
            return true;
        }

        await sock.sendMessage(session.chatId, {
            text: `📊 Found *${rawNumbers.length}* contact(s) in the VCF.\n⏳ Checking WhatsApp registration... this may take a while.`
        });

        const validJids = [];
        for (let i = 0; i < rawNumbers.length; i++) {
            const num = rawNumbers[i];
            try {
                const jid = num + '@s.whatsapp.net';
                const result = await sock.onWhatsApp(jid);
                if (result && result[0]?.exists) {
                    validJids.push(result[0].jid || jid);
                }
            } catch (e) {
                // skip unverifiable numbers
            }
            await new Promise(r => setTimeout(r, 300));

            if ((i + 1) % 50 === 0) {
                await sock.sendMessage(session.chatId, {
                    text: `🔍 Checked ${i + 1}/${rawNumbers.length} numbers... (${validJids.length} valid so far)`
                });
            }
        }

        if (validJids.length === 0) {
            await sock.sendMessage(session.chatId, {
                text: '❌ None of the contacts are registered on WhatsApp.'
            });
            return true;
        }

        await sock.sendMessage(session.chatId, {
            text: `✅ *${validJids.length}* WhatsApp contact(s) verified.\n🔄 Starting group creation...`
        });

        const MAX_ADDITIONS = MAX_GROUP_MEMBERS - 1;
        const createdGroups = [];
        let groupIndex = 1;

        for (let i = 0; i < validJids.length; i += MAX_ADDITIONS) {
            const chunk = validJids.slice(i, i + MAX_ADDITIONS);
            const groupName = `Mass Group ${groupIndex}`;

            try {
                const result = await sock.groupCreate(groupName, chunk);
                const groupJid = result.id;

                let added = 0;
                let skipped = 0;
                if (result.participants) {
                    for (const p of result.participants) {
                        if (p.error) {
                            skipped++;
                        } else {
                            added++;
                        }
                    }
                    added = Math.max(0, added - 1);
                }

                createdGroups.push({ name: groupName, jid: groupJid, added, skipped });

                await sock.sendMessage(session.chatId, {
                    text: `✅ *${groupName}* created!\n👥 Members added: ${added}\n⚠️ Skipped: ${skipped}`
                });

                groupIndex++;
                if (i + MAX_ADDITIONS < validJids.length) {
                    await new Promise(r => setTimeout(r, 3000));
                }
            } catch (e) {
                await sock.sendMessage(session.chatId, {
                    text: `❌ Failed to create *${groupName}*: ${e.message}`
                });
                groupIndex++;
            }
        }

        const totalAdded = createdGroups.reduce((s, g) => s + g.added, 0);
        const totalSkipped = createdGroups.reduce((s, g) => s + g.skipped, 0);

        await sock.sendMessage(session.chatId, {
            text: `🎉 *Mass Group Creation Complete!*\n\n📦 Groups Created: *${createdGroups.length}*\n✅ Total Members Added: *${totalAdded}*\n⚠️ Total Skipped: *${totalSkipped}*\n\n_Skipped contacts may have privacy settings that prevent being added, or were already in one of the groups._`
        });

    } catch (err) {
        console.error('massgroups error:', err);
        await sock.sendMessage(session.chatId, {
            text: '❌ Error processing VCF file: ' + err.message
        });
    }

    return true;
}

module.exports = { massGroupsCommand, handleMassGroupsVCF };
