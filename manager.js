const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const express = require('express');
const mongoose = require('mongoose');
const { createCloneWorkspace } = require('./lib/clone-workspace');
const { resetBotWorkspace } = require('./lib/reset-bot-workspace');
const { acquireSingleInstanceLock, releaseSingleInstanceLock } = require('./lib/single-instance-lock');

const ROOT = __dirname;
const MANAGER_LOCK_PATH = path.join(
    os.tmpdir(),
    `knightbot-manager-${crypto.createHash('sha256').update(ROOT).digest('hex')}.lock`
);
const PORT = Number(process.env.PORT || 5000);
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_COOKIE = 'knight_admin_session';
const instances = new Map();
const loginAttempts = new Map();
let shuttingDown = false;
let managerLockFd = null;

function releaseManagerLock() {
    if (managerLockFd === null) return;
    releaseSingleInstanceLock(MANAGER_LOCK_PATH, managerLockFd);
    managerLockFd = null;
}

function requireConfiguration() {
    const required = ['ADMIN_USERNAME', 'ADMIN_PASSWORD', 'MONGODB_URL', 'SESSION_SECRET'];
    const missing = required.filter((name) => !process.env[name]);
    if (missing.length) throw new Error(`Missing required Replit Secrets: ${missing.join(', ')}`);
}

function sessionCollection() {
    return mongoose.connection.db.collection('knight_admin_sessions');
}

function instanceCollection() {
    return mongoose.connection.db.collection('knight_bot_instances');
}

function safeEqual(actual, expected) {
    const left = crypto.createHash('sha256').update(String(actual)).digest();
    const right = crypto.createHash('sha256').update(String(expected)).digest();
    return crypto.timingSafeEqual(left, right) && String(actual) === String(expected);
}

function signToken(token) {
    return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(token).digest('base64url');
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function getCookie(req, name) {
    const cookies = String(req.headers.cookie || '').split(';');
    const entry = cookies.map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith(`${name}=`));
    return entry ? decodeURIComponent(entry.slice(name.length + 1)) : null;
}

function setSessionCookie(req, res, value, maxAgeSeconds) {
    const flags = [
        `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${maxAgeSeconds}`
    ];
    if (req.secure) flags.push('Secure');
    res.setHeader('Set-Cookie', flags.join('; '));
}

async function loadSession(req) {
    const cookie = getCookie(req, SESSION_COOKIE);
    if (!cookie) return null;
    const separator = cookie.lastIndexOf('.');
    if (separator <= 0) return null;
    const token = cookie.slice(0, separator);
    const providedSignature = Buffer.from(cookie.slice(separator + 1), 'base64url');
    const expectedSignature = Buffer.from(signToken(token), 'base64url');
    if (
        providedSignature.length !== expectedSignature.length ||
        !crypto.timingSafeEqual(providedSignature, expectedSignature)
    ) return null;

    const session = await sessionCollection().findOne({
        _id: hashToken(token),
        expiresAt: { $gt: new Date() }
    });
    if (!session) return null;

    if (Date.now() - new Date(session.lastSeenAt || session.createdAt).getTime() > 5 * 60 * 1000) {
        await sessionCollection().updateOne(
            { _id: session._id },
            { $set: { lastSeenAt: new Date() } }
        );
    }
    return session;
}

function loginRateLimit(req, res, next) {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const current = Date.now();
    const existing = loginAttempts.get(ip);
    if (!existing || current - existing.startedAt > 15 * 60 * 1000) {
        loginAttempts.set(ip, { startedAt: current, count: 0 });
    }
    const attempt = loginAttempts.get(ip);
    if (attempt.count >= 10) {
        return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    }
    attempt.count += 1;
    next();
}

function requireAdmin(req, res, next) {
    loadSession(req).then((session) => {
        if (!session) return res.status(401).json({ error: 'Please sign in again.' });
        req.adminSession = session;
        next();
    }).catch((error) => {
        console.error('Could not verify admin session:', error.message);
        res.status(503).json({ error: 'Session service is temporarily unavailable.' });
    });
}

function enforceSameOrigin(req, res, next) {
    const origin = req.get('origin');
    if (!origin) return next();
    // Replit's proxy can rewrite the request host; browsers still classify same-origin fetches.
    if (req.get('sec-fetch-site') === 'same-origin') return next();

    try {
        const requestOrigin = new URL(origin);
        if (!['http:', 'https:'].includes(requestOrigin.protocol)) {
            return res.status(403).json({ error: 'Request origin is not allowed.' });
        }

        const firstHeaderValue = (value) => String(value || '').split(',')[0].trim();
        const protocols = new Set([
            req.protocol,
            firstHeaderValue(req.get('x-forwarded-proto')).replace(/:$/, '').toLowerCase()
        ].filter((value) => value === 'http' || value === 'https'));
        const hosts = new Set([
            firstHeaderValue(req.get('x-forwarded-host')),
            req.get('host'),
            req.hostname
        ].filter(Boolean));
        const allowedOrigins = new Set();

        for (const protocol of protocols) {
            for (const host of hosts) {
                allowedOrigins.add(new URL(`${protocol}://${host}`).origin);
            }
        }

        const configuredDomains = [
            process.env.REPLIT_DEV_DOMAIN,
            ...(process.env.REPLIT_DOMAINS || '').split(',')
        ].map((domain) => domain.trim()).filter(Boolean);
        for (const domain of configuredDomains) {
            const configuredOrigin = new URL(`https://${domain}`);
            allowedOrigins.add(configuredOrigin.origin);
            if (domain === process.env.REPLIT_DEV_DOMAIN && PORT > 0 && PORT < 65536) {
                configuredOrigin.port = String(PORT);
                allowedOrigins.add(configuredOrigin.origin);
            }
        }

        if (!allowedOrigins.has(requestOrigin.origin)) {
            return res.status(403).json({ error: 'Request origin is not allowed.' });
        }
    } catch {
        return res.status(403).json({ error: 'Request origin is not allowed.' });
    }
    next();
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
});
app.use('/api', enforceSameOrigin);
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const LOGIN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><title>Sign in · Knight Bot</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#edf2f1;background:#0b1110;font-synthesis:none}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(ellipse at 50% 0%,#12352b 0,transparent 45%),#0b1110}
.card{width:min(100%,420px);padding:36px;background:#111a17;border:1px solid #26332e;border-radius:18px;box-shadow:0 28px 90px #0008}
.brand{display:flex;align-items:center;gap:13px;margin-bottom:34px}.mark{display:grid;place-items:center;width:46px;height:46px;border-radius:13px;background:#163b2d;color:#62dfa0;font-size:21px;font-weight:800}
.brand strong{display:block;font-size:16px;letter-spacing:.01em}.brand span{display:block;margin-top:4px;color:#7f9188;font-size:12px}
h1{font-size:27px;letter-spacing:-.04em;margin:0 0 8px}.intro{margin:0 0 27px;color:#91a199;font-size:14px;line-height:1.6}
label{display:block;margin:16px 0 7px;color:#cad4ce;font-size:13px;font-weight:550}input{width:100%;height:46px;padding:0 13px;border:1px solid #34443c;border-radius:9px;background:#0c1311;color:#f4f8f5;font-size:14px;outline:none}
input:focus{border-color:#54c789;box-shadow:0 0 0 3px #54c78925}button{width:100%;height:47px;margin-top:23px;border:0;border-radius:9px;background:#45c780;color:#07150d;font-size:14px;font-weight:750;cursor:pointer}button:hover{background:#5ad38f}button:disabled{opacity:.55;cursor:wait}
.error{min-height:20px;margin-top:14px;color:#ffa69e;font-size:13px}footer{margin-top:28px;padding-top:17px;border-top:1px solid #26332e;color:#708078;font-size:11px}
</style></head><body><main class="card"><div class="brand"><div class="mark">K</div><div><strong>Knight Bot</strong><span>Private instance manager</span></div></div>
<h1>Admin sign in</h1><p class="intro">Sign in to manage your connected WhatsApp bot instances.</p>
<form id="loginForm"><label for="username">Username</label><input id="username" name="username" autocomplete="username" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<button id="submit" type="submit">Sign in</button><p class="error" id="error" role="alert" aria-live="polite"></p></form>
<footer>Authorized administrators only</footer></main>
<script>
document.getElementById('loginForm').addEventListener('submit',async(event)=>{event.preventDefault();const button=document.getElementById('submit');const error=document.getElementById('error');button.disabled=true;button.textContent='Signing in…';error.textContent='';
try{const response=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:document.getElementById('username').value,password:document.getElementById('password').value})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Sign-in failed.');location.assign('/');}
catch(err){error.textContent=err.message;button.disabled=false;button.textContent='Sign in';}});
</script></body></html>`;

const DASHBOARD_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><title>Bot instances · Knight Bot</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#edf2f1;background:#0b1110;font-synthesis:none}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(ellipse at 85% -10%,#15372d 0,transparent 34%),#0b1110}
.shell{width:min(100% - 40px,1060px);margin:auto}.topbar{height:78px;border-bottom:1px solid #26332e;display:flex;align-items:center;justify-content:space-between}
.brand{display:flex;align-items:center;gap:11px}.mark{display:grid;place-items:center;width:38px;height:38px;border-radius:11px;background:#163b2d;color:#62dfa0;font-size:18px;font-weight:800}.brand strong{display:block;font-size:14px}.brand span{display:block;margin-top:3px;color:#829189;font-size:11px}
.outline{padding:9px 14px;border:1px solid #3a4942;border-radius:8px;background:transparent;color:#c3cec8;font-size:12px;font-weight:650;cursor:pointer}.outline:hover{border-color:#65c894;color:#fff}
main{padding:54px 0 80px}.heading{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:29px}.eyebrow{color:#63d397;text-transform:uppercase;letter-spacing:.14em;font-size:10px;font-weight:750}
h1{margin:8px 0 7px;font-size:clamp(27px,4vw,38px);letter-spacing:-.05em}.intro{margin:0;color:#94a29b;font-size:14px;line-height:1.6}
.primary{height:42px;padding:0 16px;border:0;border-radius:9px;background:#45c780;color:#07150d;font-weight:750;font-size:13px;white-space:nowrap;cursor:pointer}.primary:hover{background:#5ad38f}.primary:disabled{opacity:.55;cursor:wait}
.notice{display:none;margin:0 0 18px;padding:12px 14px;border:1px solid #544b2c;border-radius:9px;background:#211d12;color:#e9ce82;font-size:13px}.notice.error{border-color:#59302f;background:#201312;color:#ffa69e}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:15px}.instance{padding:21px;border:1px solid #293630;border-radius:14px;background:linear-gradient(160deg,#141e19,#101714);min-width:0}
.instance-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.instance h2{margin:0 0 5px;font-size:16px;letter-spacing:-.02em}.instance-id{font:11px ui-monospace,SFMono-Regular,monospace;color:#7e8d85}
.badge{display:inline-flex;align-items:center;gap:7px;padding:6px 9px;border-radius:99px;background:#202b26;color:#aebbb4;font-size:11px;font-weight:650;white-space:nowrap}.dot{width:7px;height:7px;border-radius:50%;background:#93a198}
.badge.connected{background:#123323;color:#76e1a4}.badge.connected .dot{background:#5bda91}.badge.waiting_for_number,.badge.waiting_for_pairing{background:#352d15;color:#f0d272}.badge.waiting_for_number .dot,.badge.waiting_for_pairing .dot{background:#e8c351}
.badge.requesting_code,.badge.starting,.badge.restarting{background:#172b3c;color:#91c8f7}.badge.requesting_code .dot,.badge.starting .dot,.badge.restarting .dot{background:#6cb5ee}.badge.error{background:#3a1d1b;color:#ffaaa0}.badge.error .dot{background:#f1766b}
.divider{height:1px;background:#26332e;margin:18px 0}.sub{color:#94a29b;font-size:12px;line-height:1.6;margin:0 0 12px}
label{display:block;margin:13px 0 6px;color:#c5d0c9;font-size:12px;font-weight:600}input{width:100%;height:42px;padding:0 11px;border:1px solid #34443c;border-radius:8px;background:#0c1311;color:#f4f8f5;font-size:13px;outline:none}
input:focus{border-color:#54c789;box-shadow:0 0 0 3px #54c78925}.pair{display:flex;gap:9px;align-items:center}.pair input{flex:1;min-width:0}.pair button{flex:0 0 auto;height:41px;padding:0 13px;border:0;border-radius:8px;background:#45c780;color:#07150d;font-size:12px;font-weight:750;cursor:pointer}.pair button:disabled{opacity:.5}
.retry{margin-top:10px;padding:9px 12px;border:1px solid #405247;border-radius:8px;background:#17211b;color:#cfe4d7;font-size:12px;font-weight:700;cursor:pointer}.retry:hover{border-color:#45c780;color:#fff}.retry:disabled{opacity:.55;cursor:wait}
.code{display:inline-block;margin:3px 0 8px;padding:12px 16px;border:1px solid #354439;border-radius:9px;background:#0b120e;color:#70e0a0;font:800 22px ui-monospace,SFMono-Regular,monospace;letter-spacing:.19em}.error-text{margin:0;color:#ffa69e;font-size:12px;line-height:1.5}.loading{padding:45px 15px;text-align:center;border:1px dashed #35443d;border-radius:12px;color:#84938b;font-size:13px}
@media(max-width:600px){.shell{width:min(100% - 28px,1060px)}.topbar{height:68px}main{padding:39px 0 60px}.heading{align-items:flex-start;flex-direction:column}.primary{width:100%}.instance{padding:17px}}
</style></head><body><div class="shell"><header class="topbar"><div class="brand"><div class="mark">K</div><div><strong>Knight Bot</strong><span>Private instance manager</span></div></div><button class="outline" id="logout">Sign out</button></header>
<main><div class="heading"><div><div class="eyebrow">Control panel</div><h1>Bot instances</h1><p class="intro">Each instance has its own WhatsApp connection and data.</p></div><button class="primary" id="clone">＋ &nbsp; Create a clone</button></div>
<div class="notice" id="notice" role="status"></div><section class="grid" id="instances"><div class="loading">Loading bot instances…</div></section></main></div>
<script>
const grid=document.getElementById('instances');const notice=document.getElementById('notice');const cloneButton=document.getElementById('clone');let renderedInstancesSnapshot=null;
function showNotice(message,isError=false){notice.textContent=message;notice.className='notice'+(isError?' error':'');notice.style.display='block';}
function hideNotice(){notice.style.display='none';}
async function api(url,options={}){const response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});const body=await response.json().catch(()=>({}));if(response.status===401){location.assign('/login');throw new Error('Your session expired.');}if(!response.ok)throw new Error(body.error||'Request failed.');return body;}
function hasActiveGridControl(){const active=document.activeElement;return Boolean(active&&grid.contains(active)&&active.matches('input,textarea,select,button'));}
function statusText(status){return ({connected:'Connected',waiting_for_number:'Needs WhatsApp link',requesting_code:'Requesting code',waiting_for_pairing:'Pairing code ready',starting:'Starting',restarting:'Restarting',error:'Needs attention',stopped:'Stopped'})[status]||status;}
function makeRetryButton(instance){const button=document.createElement('button');button.type='button';button.className='retry';button.textContent='Request code again';button.addEventListener('click',async()=>{if(!window.confirm('This deletes this bot’s WhatsApp auth/session files and temporary files, and clears user/group records, the sudo-user list, bans, warnings, premium lists, message counts, and other unclassified data files. Bot settings, owner configuration, feature toggles, and per-group feature settings will be kept. Continue?'))return;button.disabled=true;button.textContent='Resetting session…';try{const result=await api('/api/instances/'+encodeURIComponent(instance.id)+'/retry-pair',{method:'POST',body:'{}'});showNotice(result.message||'Bot data reset. Requesting a fresh code.');await refresh();}catch(error){showNotice(error.message,true);button.disabled=false;button.textContent='Request code again';}});return button;}
function render(instances){const snapshot=JSON.stringify(instances);if(snapshot===renderedInstancesSnapshot)return;grid.replaceChildren();if(!instances.length){const empty=document.createElement('div');empty.className='loading';empty.textContent='No bot instances found.';grid.append(empty);renderedInstancesSnapshot=snapshot;return;}
for(const instance of instances){const card=document.createElement('article');card.className='instance';
const head=document.createElement('div');head.className='instance-head';const title=document.createElement('div');const name=document.createElement('h2');name.textContent=instance.name;const id=document.createElement('div');id.className='instance-id';id.textContent=instance.id;title.append(name,id);
const badge=document.createElement('span');badge.className='badge '+instance.status;const dot=document.createElement('span');dot.className='dot';const label=document.createElement('span');label.textContent=statusText(instance.status);badge.append(dot,label);head.append(title,badge);card.append(head);
const divider=document.createElement('div');divider.className='divider';card.append(divider);
if(instance.status==='waiting_for_number'){const text=document.createElement('p');text.className='sub';text.textContent='Link a separate WhatsApp account to this bot instance.';const form=document.createElement('form');form.className='pair';const input=document.createElement('input');input.type='tel';input.inputMode='numeric';input.autocomplete='tel';input.placeholder='Country code + phone number';input.maxLength=15;input.required=true;input.setAttribute('aria-label','WhatsApp phone number');const button=document.createElement('button');button.type='submit';button.textContent='Get code';form.append(input,button);form.addEventListener('submit',async(event)=>{event.preventDefault();button.disabled=true;try{await api('/api/instances/'+encodeURIComponent(instance.id)+'/pair',{method:'POST',body:JSON.stringify({phone:input.value})});showNotice('Pairing code requested for '+instance.name+'.');await refresh();}catch(error){showNotice(error.message,true);button.disabled=false;}});card.append(text,form);}
else if(instance.status==='waiting_for_pairing'&&instance.pairingCode){const text=document.createElement('p');text.className='sub';text.textContent='Enter this code in WhatsApp → Settings → Linked Devices → Link a Device.';const code=document.createElement('div');code.className='code';code.textContent=instance.pairingCode;card.append(text,code);if(instance.canRetryPairing)card.append(makeRetryButton(instance));}
else if(instance.error){const text=document.createElement('p');text.className='error-text';text.textContent=instance.error;card.append(text);if(instance.canRetryPairing)card.append(makeRetryButton(instance));}
else{const text=document.createElement('p');text.className='sub';text.textContent=instance.status==='connected'?'This bot is online. Its WhatsApp session is saved and will reconnect after a server restart.':'This bot is starting. Its status will update automatically.';card.append(text);}
 grid.append(card);}renderedInstancesSnapshot=snapshot;}
async function refresh(){if(hasActiveGridControl())return;try{const data=await api('/api/instances');if(!hasActiveGridControl())render(data.instances||[]);}catch(error){if(error.message!=='Your session expired.')showNotice(error.message,true);}}
document.getElementById('clone').addEventListener('click',async()=>{cloneButton.disabled=true;cloneButton.textContent='Creating clone…';hideNotice();try{const data=await api('/api/instances',{method:'POST',body:'{}'});showNotice(data.message||'Clone created. Link it to a separate WhatsApp account.');await refresh();}catch(error){showNotice(error.message,true);}finally{cloneButton.disabled=false;cloneButton.innerHTML='＋ &nbsp; Create a clone';}});
document.getElementById('logout').addEventListener('click',async()=>{try{await api('/api/logout',{method:'POST',body:'{}'});}finally{location.assign('/login');}});
refresh();setInterval(refresh,2500);
</script></body></html>`;

app.get('/login', async (req, res) => {
    try {
        if (await loadSession(req)) return res.redirect('/');
        res.type('html').send(LOGIN_PAGE);
    } catch (error) {
        console.error('Could not load login session:', error.message);
        res.status(503).send('The session database is temporarily unavailable.');
    }
});

app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.get('/', async (req, res) => {
    try {
        if (!(await loadSession(req))) return res.redirect('/login');
        res.type('html').send(DASHBOARD_PAGE);
    } catch (error) {
        console.error('Could not load dashboard session:', error.message);
        res.status(503).send('The session database is temporarily unavailable.');
    }
});

app.post('/api/login', loginRateLimit, async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!safeEqual(username, process.env.ADMIN_USERNAME) || !safeEqual(password, process.env.ADMIN_PASSWORD)) {
        return res.status(401).json({ error: 'The username or password is incorrect.' });
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const now = new Date();
    await sessionCollection().insertOne({
        _id: hashToken(token),
        createdAt: now,
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS)
    });
    loginAttempts.delete(req.ip || req.socket.remoteAddress || 'unknown');
    setSessionCookie(req, res, `${token}.${signToken(token)}`, Math.floor(SESSION_TTL_MS / 1000));
    res.json({ ok: true });
});

app.post('/api/logout', requireAdmin, async (req, res) => {
    await sessionCollection().deleteOne({ _id: req.adminSession._id });
    setSessionCookie(req, res, '', 0);
    res.json({ ok: true });
});

app.get('/api/instances', requireAdmin, (_req, res) => {
    const result = [...instances.values()]
        .map((entry) => ({
            id: entry.id,
            name: entry.name,
            status: entry.state.status,
            pairingCode: entry.state.pairingCode,
            error: entry.state.error,
            canRetryPairing: Boolean(entry.phoneNumber)
                && ['waiting_for_pairing', 'error'].includes(entry.state.status)
                && !entry.pairingReset
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    res.json({ instances: result });
});

app.post('/api/instances', requireAdmin, async (_req, res) => {
    try {
        const all = await instanceCollection().find({}).toArray();
        const nextNumber = all.reduce((max, item) => {
            const match = String(item.id).match(/^clone-(\d+)$/);
            return match ? Math.max(max, Number(match[1])) : max;
        }, 0) + 1;
        const id = `clone-${String(nextNumber).padStart(4, '0')}`;
        const name = `Knight Bot ${nextNumber + 1}`;
        createCloneWorkspace(ROOT, id);
        const record = { _id: id, id, name, createdAt: new Date(), status: 'starting' };
        await instanceCollection().insertOne(record);
        startInstance(record);
        res.status(201).json({ ok: true, instance: { id, name }, message: `${name} started with a separate session and data workspace.` });
    } catch (error) {
        console.error('Could not create bot clone:', error.message);
        res.status(500).json({ error: 'Could not create a bot clone. Check the server logs and try again.' });
    }
});

app.post('/api/instances/:id/pair', requireAdmin, async (req, res) => {
    const entry = instances.get(req.params.id);
    const phone = typeof req.body?.phone === 'string' ? req.body.phone.replace(/\D/g, '') : '';
    if (!entry) return res.status(404).json({ error: 'Bot instance not found.' });
    if (phone.length < 7 || phone.length > 15) return res.status(400).json({ error: 'Enter a valid phone number with country code.' });
    if (entry.pairingReset) return res.status(409).json({ error: 'This bot is already resetting for a new code.' });
    if (entry.state.status !== 'waiting_for_number') {
        return res.status(409).json({ error: 'This bot is not ready for a phone number yet.' });
    }
    if (!entry.child?.connected) return res.status(503).json({ error: 'This bot process is restarting. Try again shortly.' });
    beginPairingReset(entry, entry.record, phone, { clearBotData: false });
    res.json({ ok: true, message: 'Clearing old WhatsApp authentication and temporary files before requesting a code.' });
});

app.post('/api/instances/:id/retry-pair', requireAdmin, (req, res) => {
    const entry = instances.get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Bot instance not found.' });
    if (!entry.phoneNumber) return res.status(409).json({ error: 'Enter the WhatsApp number again before requesting another code.' });
    if (entry.pairingReset) return res.status(409).json({ error: 'This bot is already resetting for a new code.' });
    if (!['waiting_for_pairing', 'error'].includes(entry.state.status)) {
        return res.status(409).json({ error: 'A new code can only be requested while pairing or after a pairing error.' });
    }

    beginPairingReset(entry, entry.record, entry.phoneNumber, { clearBotData: true });
    res.json({
        ok: true,
        message: 'WhatsApp authentication, temporary files, and bot activity data are being cleared. Bot settings and feature preferences will be kept.'
    });
});

function beginPairingReset(entry, record, phone, { clearBotData = false } = {}) {
    entry.phoneNumber = phone;
    entry.pairingReset = { phone, clearBotData };
    entry.pendingPairPhone = null;
    entry.state = { status: 'restarting', pairingCode: null, error: null };
    updateStoredStatus(entry.id, 'restarting');

    const child = entry.child;
    if (child && child.exitCode === null) {
        if (child.connected) {
            child.send({ type: 'reset_for_pairing' }, (error) => {
                if (error && entry.child === child) child.kill('SIGTERM');
            });
        } else {
            child.kill('SIGTERM');
        }
        const forceStop = setTimeout(() => {
            if (entry.child === child) child.kill('SIGKILL');
        }, 8000);
        forceStop.unref?.();
        return;
    }

    void finishPairingReset(entry, record);
}

async function finishPairingReset(entry, record) {
    const reset = entry.pairingReset;
    if (!reset) return;
    entry.pairingReset = null;

    try {
        await mongoose.connection.db.collection('knight_bot_auth').deleteMany({ instanceId: entry.id });
        clearPairingTemporaryFiles(entry.id, reset.clearBotData);
        if (shuttingDown) return;
        entry.pendingPairPhone = reset.phone;
        startInstance(record);
    } catch (error) {
        console.error(`Could not reset pairing data for ${entry.id}:`, error.message);
        entry.pendingPairPhone = null;
        entry.state = {
            status: 'error',
            pairingCode: null,
            error: 'Could not clear the previous WhatsApp session. Try requesting a new code again.'
        };
        updateStoredStatus(entry.id, 'error');
    }
}

function clearPairingTemporaryFiles(id, clearBotData = false) {
    const workspace = id === 'main' ? ROOT : createCloneWorkspace(ROOT, id);
    resetBotWorkspace(workspace, { clearBotData });
}

function workerEnvironment(id) {
    const env = { ...process.env };
    delete env.ADMIN_USERNAME;
    delete env.ADMIN_PASSWORD;
    delete env.PORT;
    env.KNIGHT_BOT_WORKER = '1';
    env.KNIGHT_BOT_INSTANCE_ID = id;
    return env;
}

function updateStoredStatus(id, status) {
    instanceCollection().updateOne(
        { _id: id },
        { $set: { status, lastStartedAt: new Date(), lastStatusAt: new Date() } }
    ).catch((error) => console.error(`Could not save status for ${id}:`, error.message));
}

function startInstance(record) {
    if (shuttingDown) return;
    const id = record.id;
    const existingChild = instances.get(id)?.child;
    if (!id || (existingChild && existingChild.exitCode === null)) return;
    let cwd = ROOT;
    if (id !== 'main') {
        try {
            cwd = createCloneWorkspace(ROOT, id);
        } catch (error) {
            instances.set(id, {
                id, name: record.name,
                state: { status: 'error', pairingCode: null, error: `Could not prepare this bot: ${error.message}` }
            });
            return;
        }
    }

    const entry = instances.get(id) || {
        id,
        name: record.name || (id === 'main' ? 'Knight Bot' : id),
        state: { status: 'starting', pairingCode: null, error: null }
    };
    entry.name = record.name || entry.name;
    entry.record = record;
    entry.state = { status: 'starting', pairingCode: null, error: null };
    instances.set(id, entry);

    const child = fork(path.join(cwd, 'index.js'), [], {
        cwd,
        env: workerEnvironment(id),
        execArgv: ['--max-old-space-size=512', '--optimize-for-size', '--gc-interval=100', '--expose-gc'],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    entry.child = child;
    updateStoredStatus(id, 'starting');
    child.stdout.on('data', (chunk) => process.stdout.write(`[${id}] ${chunk}`));
    child.stderr.on('data', (chunk) => process.stderr.write(`[${id}] ${chunk}`));
    child.on('message', (message) => {
        if (message?.type !== 'status' || typeof message.status !== 'string') return;
        entry.state = {
            status: message.status,
            pairingCode: typeof message.pairingCode === 'string' ? message.pairingCode : null,
            error: typeof message.error === 'string' ? message.error : null
        };
        updateStoredStatus(id, message.status);

        if (message.status === 'waiting_for_number' && entry.pendingPairPhone && child.connected) {
            const phone = entry.pendingPairPhone;
            entry.pendingPairPhone = null;
            child.send({ type: 'phone', phone }, (error) => {
                if (!error || entry.child !== child) return;
                entry.pendingPairPhone = phone;
                entry.state = {
                    status: 'error',
                    pairingCode: null,
                    error: 'Could not send the phone number to this bot. Request a fresh code.'
                };
                updateStoredStatus(id, 'error');
                console.error(`Could not send pairing phone to ${id}:`, error.message);
            });
        }
    });
    child.on('error', (error) => {
        console.error(`Bot process ${id} failed:`, error.message);
        entry.state = { status: 'error', pairingCode: null, error: 'Bot process failed to start.' };
    });
    child.on('exit', (code, signal) => {
        if (entry.child !== child) return;
        entry.child = null;
        if (entry.pairingReset) {
            void finishPairingReset(entry, entry.record || record);
            return;
        }
        entry.state = {
            status: 'restarting',
            pairingCode: null,
            error: code === 0 ? null : `Bot stopped unexpectedly (${signal || `exit ${code}`}); restarting.`
        };
        updateStoredStatus(id, 'restarting');
        if (!shuttingDown) setTimeout(() => startInstance(record), 3000);
    });
}

async function start() {
    managerLockFd = await acquireSingleInstanceLock(MANAGER_LOCK_PATH);
    requireConfiguration();
    await mongoose.connect(process.env.MONGODB_URL, { serverSelectionTimeoutMS: 15000 });
    const sessions = sessionCollection();
    const botInstances = instanceCollection();
    await Promise.all([
        sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        botInstances.createIndex({ createdAt: 1 })
    ]);

    const existingMain = await botInstances.findOne({ _id: 'main' });
    if (!existingMain) {
        await botInstances.insertOne({
            _id: 'main', id: 'main', name: 'Knight Bot',
            createdAt: new Date(), status: 'starting'
        });
    }

    const savedInstances = await botInstances.find({}).sort({ createdAt: 1 }).toArray();
    for (const record of savedInstances) startInstance(record);

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Knight Bot manager ready on port ${PORT}; restored ${savedInstances.length} bot instance(s).`);
    });
}

async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const entry of instances.values()) {
        if (entry.child?.connected) entry.child.kill('SIGTERM');
    }
    await Promise.all([
        ...[...instances.values()].map((entry) => new Promise((resolve) => {
            if (!entry.child || entry.child.exitCode !== null) return resolve();
            const timeout = setTimeout(() => {
                entry.child?.kill('SIGKILL');
                resolve();
            }, 5000);
            entry.child.once('exit', () => {
                clearTimeout(timeout);
                resolve();
            });
        }))
    ]);
    await mongoose.disconnect().catch(() => {});
    releaseManagerLock();
    process.exit(0);
}

process.once('exit', releaseManagerLock);
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

start().catch((error) => {
    console.error('Could not start Knight Bot manager:', error.message);
    process.exit(1);
});
