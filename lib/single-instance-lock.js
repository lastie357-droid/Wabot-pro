const fs = require('fs');

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function acquireSingleInstanceLock(lockPath, { waitMs = 10000, retryMs = 200 } = {}) {
    const deadline = Date.now() + waitMs;

    while (true) {
        let descriptor;
        try {
            descriptor = fs.openSync(lockPath, 'wx', 0o600);
            fs.writeFileSync(descriptor, `${process.pid}\n`);
            return descriptor;
        } catch (error) {
            if (descriptor !== undefined) {
                try { fs.closeSync(descriptor); } catch {}
                try { fs.rmSync(lockPath, { force: true }); } catch {}
            }
            if (error.code !== 'EEXIST') throw error;
        }

        let ownerPid = null;
        try {
            const parsedPid = Number(fs.readFileSync(lockPath, 'utf8').trim());
            if (Number.isSafeInteger(parsedPid) && parsedPid > 0) ownerPid = parsedPid;
        } catch {}

        if (ownerPid !== null) {
            try {
                process.kill(ownerPid, 0);
            } catch (error) {
                if (error.code === 'ESRCH') {
                    fs.rmSync(lockPath, { force: true });
                    continue;
                }
                if (error.code !== 'EPERM') throw error;
            }
        } else {
            let ageMs;
            try {
                ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
            } catch {
                continue;
            }
            // Allow a new process time to write its PID after creating the file.
            if (ageMs >= 1000) {
                fs.rmSync(lockPath, { force: true });
                continue;
            }
        }

        if (Date.now() >= deadline) {
            throw new Error('Another Knight Bot manager is already running; refusing to start duplicate bot workers.');
        }
        await wait(Math.min(retryMs, Math.max(0, deadline - Date.now())));
    }
}

function releaseSingleInstanceLock(lockPath, descriptor) {
    if (!Number.isInteger(descriptor)) return;

    let ownsLock = false;
    try {
        ownsLock = fs.readFileSync(lockPath, 'utf8').trim() === String(process.pid);
    } catch {}

    try { fs.closeSync(descriptor); } catch {}
    if (ownsLock) {
        try { fs.unlinkSync(lockPath); } catch {}
    }
}

module.exports = { acquireSingleInstanceLock, releaseSingleInstanceLock };
