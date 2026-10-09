const crypto = require('crypto');
const mongoose = require('mongoose');
const { initAuthCreds } = require('@whiskeysockets/baileys');

function getEncryptionKey() {
    const secret = process.env.SESSION_SECRET;
    if (!secret) throw new Error('SESSION_SECRET is required to protect WhatsApp sessions in MongoDB.');
    return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
    const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(value), 'utf8'),
        cipher.final()
    ]);

    return {
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        value: ciphertext.toString('base64')
    };
}

function decrypt(envelope) {
    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        getEncryptionKey(),
        Buffer.from(envelope.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const json = Buffer.concat([
        decipher.update(Buffer.from(envelope.value, 'base64')),
        decipher.final()
    ]).toString('utf8');

    return JSON.parse(json, (_key, value) => {
        if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
            return Buffer.from(value.data);
        }
        return value;
    });
}

async function ensureMongoConnection() {
    if (!process.env.MONGODB_URL) throw new Error('MONGODB_URL is required to store bot sessions.');
    if (mongoose.connection.readyState !== 1) {
        await mongoose.connect(process.env.MONGODB_URL, { serverSelectionTimeoutMS: 15000 });
    }
}

async function useMongoAuthState(instanceId) {
    await ensureMongoConnection();
    const collection = mongoose.connection.db.collection('knight_bot_auth');
    const prefix = `${instanceId}:`;

    async function read(key) {
        const document = await collection.findOne({ _id: prefix + key });
        return document?.encrypted ? decrypt(document.encrypted) : null;
    }

    async function write(key, value) {
        await collection.updateOne(
            { _id: prefix + key },
            { $set: { instanceId, encrypted: encrypt(value), updatedAt: new Date() } },
            { upsert: true }
        );
    }

    const creds = await read('creds') || initAuthCreds();
    const keys = {
        async get(type, ids) {
            const names = ids.map((id) => `${type}-${id}`);
            if (!names.length) return {};
            const documents = await collection.find({
                _id: { $in: names.map((name) => prefix + name) }
            }).toArray();
            const values = new Map(documents.map((document) => [
                document._id.slice(prefix.length),
                document.encrypted ? decrypt(document.encrypted) : null
            ]));
            return Object.fromEntries(names.map((name) => [name.slice(type.length + 1), values.get(name)]));
        },
        async set(data) {
            const operations = [];
            for (const [type, entries] of Object.entries(data)) {
                for (const [id, value] of Object.entries(entries || {})) {
                    const key = `${type}-${id}`;
                    if (value === null || value === undefined) {
                        operations.push(collection.deleteOne({ _id: prefix + key }));
                    } else {
                        operations.push(collection.updateOne(
                            { _id: prefix + key },
                            { $set: { instanceId, encrypted: encrypt(value), updatedAt: new Date() } },
                            { upsert: true }
                        ));
                    }
                }
            }
            await Promise.all(operations);
        }
    };

    return { state: { creds, keys }, saveCreds: () => write('creds', creds) };
}

async function clearMongoAuthState(instanceId) {
    await ensureMongoConnection();
    await mongoose.connection.db.collection('knight_bot_auth').deleteMany({ instanceId });
}

module.exports = { useMongoAuthState, clearMongoAuthState };
