const fs = require('fs');
const path = require('path');

const PAIRING_ARTIFACTS = [
    'session',
    'sessions',
    'temp',
    'tmp',
    'auth_info_baileys',
    '.wwebjs_auth',
    '.wwebjs_cache',
    'baileys_store.json'
];

const SETTING_FILES = new Set([
    'owner.json',
    'antidelete.json',
    'autoStatus.json',
    'autoread.json',
    'autotyping.json',
    'anticall.json',
    'pmblocker.json'
]);

const KNOWN_DATA_FILES = new Set([
    ...SETTING_FILES,
    'userGroupData.json',
    'messageCount.json',
    'banned.json',
    'premium.json',
    'warnings.json'
]);

const GROUP_SETTING_KEYS = [
    'antilink',
    'antibadword',
    'welcome',
    'goodbye',
    'chatbot',
    'antitag'
];

function readJson(file, fallback) {
    if (!fs.existsSync(file)) return fallback;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        throw new Error(`Cannot safely reset bot data because ${path.basename(file)} is invalid JSON.`);
    }
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function writeJsonAtomically(file, value) {
    const temporary = `${file}.reset-${process.pid}`;
    try {
        fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
        fs.renameSync(temporary, file);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

function prepareBotDataReset(dataDirectory) {
    const mode = readJson(path.join(dataDirectory, 'messageCount.json'), {});
    const savedPreferences = readJson(path.join(dataDirectory, 'userGroupData.json'), {});
    if (!isRecord(mode) || !isRecord(savedPreferences)) {
        throw new Error('Cannot safely reset bot data because a settings file has an unexpected format.');
    }

    const groupSettings = {};
    for (const key of GROUP_SETTING_KEYS) {
        if (isRecord(savedPreferences[key])) groupSettings[key] = savedPreferences[key];
    }

    const userGroupSettings = {
        users: [],
        groups: [],
        antilink: {},
        antibadword: {},
        warnings: {},
        sudo: [],
        welcome: {},
        goodbye: {},
        chatbot: {},
        antitag: {},
        autoReaction: typeof savedPreferences.autoReaction === 'boolean'
            ? savedPreferences.autoReaction
            : false,
        ...groupSettings
    };

    return {
        userGroupSettings,
        messageCount: {
            isPublic: typeof mode.isPublic === 'boolean' ? mode.isPublic : true,
            messageCount: {}
        }
    };
}

function clearBotData(dataDirectory, reset) {
    fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(dataDirectory, { withFileTypes: true })) {
        if (!KNOWN_DATA_FILES.has(entry.name)) {
            fs.rmSync(path.join(dataDirectory, entry.name), { recursive: true, force: true });
        }
    }

    writeJsonAtomically(path.join(dataDirectory, 'userGroupData.json'), reset.userGroupSettings);
    writeJsonAtomically(path.join(dataDirectory, 'messageCount.json'), reset.messageCount);
    writeJsonAtomically(path.join(dataDirectory, 'banned.json'), []);
    writeJsonAtomically(path.join(dataDirectory, 'premium.json'), []);
    writeJsonAtomically(path.join(dataDirectory, 'warnings.json'), {});
}

function resetBotWorkspace(workspace, { clearBotData: shouldClearBotData = false } = {}) {
    const root = path.resolve(workspace);
    const dataDirectory = path.join(root, 'data');
    const dataReset = shouldClearBotData ? prepareBotDataReset(dataDirectory) : null;

    for (const relative of PAIRING_ARTIFACTS) {
        fs.rmSync(path.join(root, relative), { recursive: true, force: true });
    }

    fs.mkdirSync(path.join(root, 'temp'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true, mode: 0o700 });

    if (dataReset) clearBotData(dataDirectory, dataReset);
}

module.exports = { resetBotWorkspace };
