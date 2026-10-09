const isOwnerOrSudo = require('../lib/isOwner');
const { clearMongoSignalKeys } = require('../mongo-auth-state');

const channelInfo = {
    contextInfo: {
        forwardingScore: 999,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
            newsletterJid: '120363161513685998@newsletter',
            newsletterName: 'KnightBot MD',
            serverMessageId: -1
        }
    }
};

async function clearSessionCommand(sock, chatId, msg) {
    try {
        const senderId = msg.key.participant || msg.key.remoteJid;
        const isOwner = await isOwnerOrSudo(senderId, sock, chatId);
        
        if (!msg.key.fromMe && !isOwner) {
            await sock.sendMessage(chatId, { 
                text: '❌ This command can only be used by the owner!',
                ...channelInfo
            });
            return;
        }

        await sock.sendMessage(chatId, { 
            text: '🔍 Optimizing saved WhatsApp session data...',
            ...channelInfo
        });

        const instanceId = process.env.KNIGHT_BOT_INSTANCE_ID || 'main';
        const keysCleared = await clearMongoSignalKeys(instanceId);

        await sock.sendMessage(chatId, { 
            text: `✅ Session state optimized.\n\nSignal keys cleared: ${keysCleared}\nYour saved account credentials were retained.`,
            ...channelInfo
        });

    } catch (error) {
        console.error('Error in clearsession command:', error);
        await sock.sendMessage(chatId, { 
            text: '❌ Failed to optimize the saved WhatsApp session.',
            ...channelInfo
        });
    }
}

module.exports = clearSessionCommand; 