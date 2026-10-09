let pendingPhoneResolve = null;
let queuedPhoneNumber = null;

function waitForPhoneNumber() {
    if (queuedPhoneNumber) {
        const phone = queuedPhoneNumber;
        queuedPhoneNumber = null;
        return Promise.resolve(phone);
    }

    return new Promise((resolve) => {
        pendingPhoneResolve = resolve;
    });
}

function setStatus(status, data = {}) {
    if (typeof process.send === 'function' && process.connected) {
        process.send({
            type: 'status',
            status,
            pairingCode: data.pairingCode || null,
            error: data.error ? String(data.error).slice(0, 500) : null
        });
    }
}

process.on('message', (message) => {
    if (message?.type !== 'phone' || typeof message.phone !== 'string') return;
    if (pendingPhoneResolve) {
        const resolve = pendingPhoneResolve;
        pendingPhoneResolve = null;
        resolve(message.phone);
    } else {
        queuedPhoneNumber = message.phone;
    }
});

module.exports = { waitForPhoneNumber, setStatus };
