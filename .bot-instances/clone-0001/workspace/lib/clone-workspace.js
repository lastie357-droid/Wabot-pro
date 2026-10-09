const fs = require('fs');
const path = require('path');

const EXCLUDED_ENTRIES = new Set([
    '.git', '.cache', '.local', '.agents', '.bot-instances',
    'node_modules', 'session', 'tmp', 'temp', 'package-lock.json'
]);

const SYNCED_CODE_ENTRIES = [
    'assets',
    'commands',
    'lib',
    'config.js',
    'index.js',
    'main.js',
    'manager.js',
    'mongo-auth-state.js',
    'package.json',
    'webui.js',
    'yarn.lock'
];

const FRESH_DATA = {
    'banned.json': [],
    'messageCount.json': { isPublic: true, messageCount: {} },
    'premium.json': [],
    'warnings.json': {},
    'userGroupData.json': {
        users: [], groups: [], antilink: {}, antibadword: {}, warnings: {},
        sudo: [], welcome: {}, goodbye: {}, chatbot: {}, autoReaction: false
    }
};

function shouldCopy(root, source) {
    const relative = path.relative(root, source);
    if (!relative || relative === '.') return true;
    const parts = relative.split(path.sep);
    return !parts.some((part) => EXCLUDED_ENTRIES.has(part) || part === '.env')
        && relative !== 'baileys_store.json';
}

function syncCloneCode(root, workspace) {
    for (const entry of SYNCED_CODE_ENTRIES) {
        const source = path.join(root, entry);
        if (!fs.existsSync(source)) continue;
        fs.cpSync(source, path.join(workspace, entry), {
            recursive: true,
            force: true,
            filter: (sourcePath) => shouldCopy(root, sourcePath)
        });
    }
}

function createCloneWorkspace(root, id) {
    if (!/^clone-\d{4,}$/.test(id)) throw new Error('Invalid instance identifier.');

    const instanceRoot = path.join(root, '.bot-instances', id);
    const workspace = path.join(instanceRoot, 'workspace');
    fs.mkdirSync(instanceRoot, { recursive: true, mode: 0o700 });

    if (!fs.existsSync(path.join(workspace, 'index.js'))) {
        if (fs.existsSync(workspace)) fs.rmSync(workspace, { recursive: true, force: true });
        fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });

        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (EXCLUDED_ENTRIES.has(entry.name) || entry.name === '.env'
                || entry.name === 'baileys_store.json') continue;

            const source = path.join(root, entry.name);
            const destination = path.join(workspace, entry.name);
            fs.cpSync(source, destination, {
                recursive: true,
                filter: (sourcePath) => shouldCopy(root, sourcePath)
            });
        }

        const seedData = path.join(workspace, 'data');
        fs.mkdirSync(seedData, { recursive: true });
        for (const [file, contents] of Object.entries(FRESH_DATA)) {
            fs.writeFileSync(path.join(seedData, file), JSON.stringify(contents, null, 2));
        }

        const rootModules = path.join(root, 'node_modules');
        if (!fs.existsSync(rootModules)) throw new Error('Project dependencies are not installed.');
        fs.symlinkSync(rootModules, path.join(workspace, 'node_modules'), 'dir');
    }

    // Refresh code on every manager start while leaving per-bot settings and auth data untouched.
    syncCloneCode(root, workspace);
    return workspace;
}

module.exports = { createCloneWorkspace };
