/**
 * Knight Bot - A WhatsApp Bot
 * Copyright (c) 2024 Professor
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the MIT License.
 * 
 * Credits:
 * - Baileys Library by @adiwajshing
 * - Pair Code implementation inspired by TechGod143 & DGXEON
 */
for (const method of ['info', 'warn']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
        const sessionLog = args[0] === 'Closing session:' || args[0] === 'Session already closed';
        if (sessionLog && args[1] && typeof args[1] === 'object') return;
        return original(...args);
    };
}

require('./settings')
const { Boom } = require('@hapi/boom')
const fs = require('fs')
const chalk = require('chalk')
const FileType = require('file-type')
const path = require('path')
const axios = require('axios')
const { handleMessages, handleGroupParticipantUpdate, handleStatus } = require('./main');
const PhoneNumber = require('awesome-phonenumber')
const { waitForPhoneNumber, setStatus } = require('./webui')
const { useMongoAuthState, clearMongoAuthState } = require('./mongo-auth-state')
const { imageToWebp, videoToWebp, writeExifImg, writeExifVid } = require('./lib/exif')
const { smsg, isUrl, generateMessageTag, getBuffer, getSizeMedia, fetch, await, sleep, reSize } = require('./lib/myfunc')
const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    generateForwardMessageContent,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    generateMessageID,
    downloadContentFromMessage,
    jidDecode,
    proto,
    jidNormalizedUser,
    makeCacheableSignalKeyStore,
    delay
} = require("@whiskeysockets/baileys")
const NodeCache = require("node-cache")
// Using a lightweight persisted store instead of makeInMemoryStore (compat across versions)
const pino = require("pino")
const readline = require("readline")
const { parsePhoneNumber } = require("libphonenumber-js")
const { PHONENUMBER_MCC } = require('@whiskeysockets/baileys/lib/Utils/generics')
const { join } = require('path')

// Import lightweight store
const store = require('./lib/lightweight_store')

// Initialize store
store.readFromFile()
const settings = require('./settings')
setInterval(() => store.writeToFile(), settings.storeWriteInterval || 10000)
let activeSocket = null
let reconnectPending = false

// Memory optimization - Force garbage collection if available
setInterval(() => {
    if (global.gc) {
        global.gc()
        console.log('🧹 Garbage collection completed')
    }
}, 60_000) // every 1 minute

// Memory monitoring - Restart if RAM gets too high
setInterval(() => {
    const used = process.memoryUsage().rss / 1024 / 1024
    if (used > 650) {
        console.log(`⚠️ RAM too high (${Math.round(used)}MB > 650MB), restarting bot...`)
        process.exit(0) // exit(0) so the restart loop brings it back cleanly
    } else if (used > 500) {
        console.log(`⚠️ RAM warning: ${Math.round(used)}MB used`)
    }
}, 30_000) // check every 30 seconds

let phoneNumber = "911234567890"
let owner = JSON.parse(fs.readFileSync('./data/owner.json'))

global.botname = "KNIGHT BOT"
global.themeemoji = "•"
const pairingCode = !!phoneNumber || process.argv.includes("--pairing-code")
const useMobile = process.argv.includes("--mobile")

// Use ownerNumber from settings automatically (non-interactive Replit environment)
const rl = null
const question = (text) => {
    // Always use ownerNumber from settings in Replit environment
    return Promise.resolve(settings.ownerNumber || phoneNumber)
}


async function startXeonBotInc() {
    try {
        setStatus('starting')
        let { version, isLatest } = await fetchLatestBaileysVersion()
        const instanceId = process.env.KNIGHT_BOT_INSTANCE_ID || 'main'
        const { state, saveCreds } = await useMongoAuthState(instanceId)
        const msgRetryCounterCache = new NodeCache()

        // Collect phone number BEFORE creating the socket so it is ready when qr fires
        let pairingPhoneNumber = null
        if (!state.creds.registered) {
            if (global.phoneNumber) {
                pairingPhoneNumber = String(global.phoneNumber).replace(/[^0-9]/g, '')
            } else {
                setStatus('waiting_for_number')
                console.log(chalk.cyan('🌐 Sign in to the private bot manager to link this WhatsApp account.'))
                pairingPhoneNumber = (await waitForPhoneNumber()).replace(/[^0-9]/g, '')
            }
            const pn = require('awesome-phonenumber')
            if (!pn('+' + pairingPhoneNumber).isValid()) {
                const errMsg = 'Invalid phone number. Use full international format without + or spaces (e.g. 14155552671).'
                console.log(chalk.red(errMsg))
                setStatus('error', { error: errMsg })
                await delay(3000)
                return startXeonBotInc()
            }
            setStatus('requesting_code')
        }

        const XeonBotInc = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
            },
            markOnlineOnConnect: true,
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            getMessage: async (key) => {
                let jid = jidNormalizedUser(key.remoteJid)
                let msg = await store.loadMessage(jid, key.id)
                return msg?.message || ""
            },
            msgRetryCounterCache,
            defaultQueryTimeoutMs: 260000,
            connectTimeoutMs: 260000,
            keepAliveIntervalMs: 90000,
        })
        activeSocket = XeonBotInc

        // Serialize credential writes so an older update cannot finish after a newer one.
        let credentialsSaveQueue = Promise.resolve()
        let credentialSaveError = null
        XeonBotInc.ev.on('creds.update', () => {
            credentialsSaveQueue = credentialsSaveQueue
                .then(() => saveCreds())
                .then(() => {
                    const hadSaveError = credentialSaveError
                    credentialSaveError = null
                    if (hadSaveError && activeSocket === XeonBotInc && XeonBotInc.user) {
                        setStatus('connected')
                    }
                })
                .catch((error) => {
                    credentialSaveError = error
                    console.error('Could not save WhatsApp credentials to MongoDB:', error.message)
                    setStatus('error', {
                        error: 'WhatsApp connected, but its session could not be saved to MongoDB. It may not reconnect after a restart.'
                    })
                })
            return credentialsSaveQueue
        })

    store.bind(XeonBotInc.ev)

    // Message handling
    XeonBotInc.ev.on('messages.upsert', async chatUpdate => {
        for (const mek of chatUpdate.messages || []) {
            if (activeSocket !== XeonBotInc) return
            try {
                if (!mek?.message) continue
                mek.message = (Object.keys(mek.message)[0] === 'ephemeralMessage')
                    ? mek.message.ephemeralMessage.message
                    : mek.message
                if (mek.key?.remoteJid === 'status@broadcast') {
                    await handleStatus(XeonBotInc, { ...chatUpdate, messages: [mek] })
                    continue
                }
                // In private mode, only block non-group messages (allow groups for moderation).
                if (!XeonBotInc.public && !mek.key?.fromMe && chatUpdate.type === 'notify') {
                    const isGroup = mek.key?.remoteJid?.endsWith('@g.us')
                    if (!isGroup) continue
                }
                if (mek.key?.id?.startsWith('BAE5') && mek.key.id.length === 16) continue

                if (XeonBotInc.msgRetryCounterCache) {
                    XeonBotInc.msgRetryCounterCache.clear()
                }

                await handleMessages(XeonBotInc, { ...chatUpdate, messages: [mek] }, true)
            } catch (err) {
                console.error('Error handling incoming WhatsApp message:', err)
                const chatId = mek.key?.remoteJid
                if (chatId) {
                    await XeonBotInc.sendMessage(chatId, {
                        text: '❌ An error occurred while processing your message.',
                        contextInfo: {
                            forwardingScore: 1,
                            isForwarded: true,
                            forwardedNewsletterMessageInfo: {
                                newsletterJid: '120363161513685998@newsletter',
                                newsletterName: 'KnightBot MD',
                                serverMessageId: -1
                            }
                        }
                    }).catch(console.error)
                }
            }
        }
    })

    // Add these event handlers for better functionality
    XeonBotInc.decodeJid = (jid) => {
        if (!jid) return jid
        if (/:\d+@/gi.test(jid)) {
            let decode = jidDecode(jid) || {}
            return decode.user && decode.server && decode.user + '@' + decode.server || jid
        } else return jid
    }

    XeonBotInc.ev.on('contacts.update', update => {
        for (let contact of update) {
            let id = XeonBotInc.decodeJid(contact.id)
            if (store && store.contacts) store.contacts[id] = { id, name: contact.notify }
        }
    })

    XeonBotInc.getName = (jid, withoutContact = false) => {
        id = XeonBotInc.decodeJid(jid)
        withoutContact = XeonBotInc.withoutContact || withoutContact
        let v
        if (id.endsWith("@g.us")) return new Promise(async (resolve) => {
            v = store.contacts[id] || {}
            if (!(v.name || v.subject)) v = XeonBotInc.groupMetadata(id) || {}
            resolve(v.name || v.subject || PhoneNumber('+' + id.replace('@s.whatsapp.net', '')).getNumber('international'))
        })
        else v = id === '0@s.whatsapp.net' ? {
            id,
            name: 'WhatsApp'
        } : id === XeonBotInc.decodeJid(XeonBotInc.user.id) ?
            XeonBotInc.user :
            (store.contacts[id] || {})
        return (withoutContact ? '' : v.name) || v.subject || v.verifiedName || PhoneNumber('+' + jid.replace('@s.whatsapp.net', '')).getNumber('international')
    }

    XeonBotInc.public = true

    XeonBotInc.serializeM = (m) => smsg(XeonBotInc, m, store)

    // Connection handling
    XeonBotInc.ev.on('connection.update', async (s) => {
        if (activeSocket !== XeonBotInc) return
        const { connection, lastDisconnect, qr } = s

        // qr firing means the WhatsApp server is ready for auth —
        // request pairing code here instead of scanning the QR
        if (qr && pairingPhoneNumber && !XeonBotInc.authState.creds.registered) {
            try {
                let code = await XeonBotInc.requestPairingCode(pairingPhoneNumber)
                code = code?.match(/.{1,4}/g)?.join("-") || code
                console.log(chalk.black(chalk.bgGreen(`Your Pairing Code : `)), chalk.black(chalk.white(code)))
                console.log(chalk.yellow(`\nEnter this code in WhatsApp → Settings → Linked Devices → Link a Device`))
                setStatus('waiting_for_pairing', { pairingCode: code })
            } catch (error) {
                console.error('Error requesting pairing code:', error)
                setStatus('error', { error: 'Failed to get pairing code: ' + error.message })
            }
        }
        
        if (connection === 'connecting') {
            console.log(chalk.yellow('🔄 Connecting to WhatsApp...'))
        }
        
        if (connection == "open") {
            await credentialsSaveQueue
            if (activeSocket !== XeonBotInc) return
            if (credentialSaveError) {
                setStatus('error', {
                    error: 'WhatsApp connected, but its session could not be saved to MongoDB. It may not reconnect after a restart.'
                })
            } else {
                setStatus('connected')
            }
            console.log(chalk.magenta(` `))
            console.log(chalk.yellow(`🌿Connected to => ` + JSON.stringify(XeonBotInc.user, null, 2)))

            try {
                const botNumber = XeonBotInc.user.id.split(':')[0] + '@s.whatsapp.net';
                await XeonBotInc.sendMessage(botNumber, {
                    text: `🤖 Bot Connected Successfully!\n\n⏰ Time: ${new Date().toLocaleString()}\n✅ Status: Online and Ready!\n\n✅Make sure to join below channel`,
                    contextInfo: {
                        forwardingScore: 1,
                        isForwarded: true,
                        forwardedNewsletterMessageInfo: {
                            newsletterJid: '120363161513685998@newsletter',
                            newsletterName: 'KnightBot MD',
                            serverMessageId: -1
                        }
                    }
                });
            } catch (error) {
                console.error('Error sending connection message:', error.message)
            }

            await delay(1999)
            console.log(chalk.yellow(`\n\n                  ${chalk.bold.blue(`[ ${global.botname || 'KNIGHT BOT'} ]`)}\n\n`))
            console.log(chalk.cyan(`< ================================================== >`))
            console.log(chalk.magenta(`\n${global.themeemoji || '•'} YT CHANNEL: MR UNIQUE HACKER`))
            console.log(chalk.magenta(`${global.themeemoji || '•'} GITHUB: mrunqiuehacker`))
            console.log(chalk.magenta(`${global.themeemoji || '•'} WA NUMBER: ${owner}`))
            console.log(chalk.magenta(`${global.themeemoji || '•'} CREDIT: MR UNIQUE HACKER`))
            console.log(chalk.green(`${global.themeemoji || '•'} 🤖 Bot Connected Successfully! ✅`))
            console.log(chalk.blue(`Bot Version: ${settings.version}`))
        }
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== DisconnectReason.forbidden
            
            console.log(chalk.red(`Connection closed due to ${lastDisconnect?.error}, reconnecting ${shouldReconnect}`))
            activeSocket = null
            
            if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.forbidden) {
                try {
                    await clearMongoAuthState(instanceId)
                    console.log(chalk.yellow('Saved WhatsApp session cleared. Please re-authenticate.'))
                } catch (error) {
                    console.error('Error deleting session:', error)
                }
                console.log(chalk.red('Session logged out. Please re-authenticate.'))
                setStatus('waiting_for_number')
            }
            
            if (shouldReconnect && !reconnectPending) {
                reconnectPending = true
                setStatus('restarting', {
                    error: `WhatsApp disconnected (${statusCode || 'unknown reason'}); reconnecting.`
                })
                console.log(chalk.yellow('Reconnecting...'))
                await delay(5000)
                reconnectPending = false
                startXeonBotInc()
            }
        }
    })

    // Track recently-notified callers to avoid spamming messages
    const antiCallNotified = new Set();

    // Anticall handler: block callers when enabled
    XeonBotInc.ev.on('call', async (calls) => {
        try {
            const { readState: readAnticallState } = require('./commands/anticall');
            const state = readAnticallState();
            if (!state.enabled) return;
            for (const call of calls) {
                const callerJid = call.from || call.peerJid || call.chatId;
                if (!callerJid) continue;
                try {
                    // First: attempt to reject the call if supported
                    try {
                        if (typeof XeonBotInc.rejectCall === 'function' && call.id) {
                            await XeonBotInc.rejectCall(call.id, callerJid);
                        } else if (typeof XeonBotInc.sendCallOfferAck === 'function' && call.id) {
                            await XeonBotInc.sendCallOfferAck(call.id, callerJid, 'reject');
                        }
                    } catch {}

                    // Notify the caller only once within a short window
                    if (!antiCallNotified.has(callerJid)) {
                        antiCallNotified.add(callerJid);
                        setTimeout(() => antiCallNotified.delete(callerJid), 60000);
                        await XeonBotInc.sendMessage(callerJid, { text: '📵 Anticall is enabled. Your call was rejected and you will be blocked.' });
                    }
                } catch {}
                // Then: block after a short delay to ensure rejection and message are processed
                setTimeout(async () => {
                    try { await XeonBotInc.updateBlockStatus(callerJid, 'block'); } catch {}
                }, 800);
            }
        } catch (e) {
            // ignore
        }
    });

    XeonBotInc.ev.on('group-participants.update', async (update) => {
        await handleGroupParticipantUpdate(XeonBotInc, update);
    });

    XeonBotInc.ev.on('status.update', async (status) => {
        await handleStatus(XeonBotInc, status);
    });

    XeonBotInc.ev.on('messages.reaction', async (status) => {
        await handleStatus(XeonBotInc, status);
    });

    return XeonBotInc
    } catch (error) {
        console.error('Error in startXeonBotInc:', error)
        setStatus('error', { error: error.message })
        if (error.code === 'AUTH_STATE_DECRYPTION_FAILED') {
            return;
        }
        await delay(5000)
        startXeonBotInc()
    }
}


startXeonBotInc().catch(error => {
    console.error('Fatal error:', error)
    process.exit(1)
})
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err)
})

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err)
    if (err?.code === 'AUTH_STATE_DECRYPTION_FAILED') {
        setStatus('error', { error: err.message })
    }
})

