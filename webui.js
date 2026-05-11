const express = require('express');
const app = express();
app.use(express.json());

let botState = {
    status: 'starting',
    pairingCode: null,
    phoneNumber: null,
    error: null,
    botName: 'Knight Bot'
};

let pendingPhoneResolve = null;

function waitForPhoneNumber() {
    return new Promise((resolve) => {
        pendingPhoneResolve = resolve;
    });
}

function setStatus(status, data = {}) {
    botState = { ...botState, status, ...data };
}

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Knight Bot — Setup</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',system-ui,sans-serif;background:#0a0a0f;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
  .card{background:#13131a;border:1px solid #1e293b;border-radius:20px;padding:36px 32px;width:100%;max-width:440px;box-shadow:0 25px 60px rgba(0,0,0,.5)}
  .logo{display:flex;align-items:center;gap:12px;margin-bottom:28px}
  .logo-icon{width:48px;height:48px;background:linear-gradient(135deg,#25d366,#128c7e);border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:26px}
  .logo-text h1{font-size:1.3rem;font-weight:700;color:#fff}
  .logo-text p{font-size:.8rem;color:#64748b;margin-top:2px}
  .status-badge{display:inline-flex;align-items:center;gap:7px;padding:6px 14px;border-radius:999px;font-size:.8rem;font-weight:600;margin-bottom:24px}
  .status-badge .dot{width:8px;height:8px;border-radius:50%}
  .badge-starting{background:#1e293b;color:#94a3b8}.badge-starting .dot{background:#94a3b8;animation:pulse 1.5s infinite}
  .badge-waiting{background:#1c1a07;color:#facc15}.badge-waiting .dot{background:#facc15;animation:pulse 1.5s infinite}
  .badge-requesting{background:#0f1f3d;color:#60a5fa}.badge-requesting .dot{background:#60a5fa;animation:pulse 1s infinite}
  .badge-pairing{background:#0f1f3d;color:#60a5fa}.badge-pairing .dot{background:#60a5fa}
  .badge-connected{background:#052e16;color:#4ade80}.badge-connected .dot{background:#4ade80}
  .badge-error{background:#2d0a0a;color:#f87171}.badge-error .dot{background:#f87171}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
  h2{font-size:1.15rem;font-weight:700;color:#f1f5f9;margin-bottom:8px}
  p.sub{font-size:.875rem;color:#94a3b8;line-height:1.55;margin-bottom:20px}
  label{display:block;font-size:.8rem;color:#94a3b8;margin-bottom:6px;font-weight:500}
  input[type=tel]{width:100%;background:#0d0d14;border:1.5px solid #1e293b;border-radius:10px;padding:12px 16px;color:#f1f5f9;font-size:1rem;outline:none;transition:border-color .2s}
  input[type=tel]:focus{border-color:#25d366}
  input[type=tel]::placeholder{color:#334155}
  .btn{width:100%;margin-top:14px;padding:13px;border:none;border-radius:10px;background:linear-gradient(135deg,#25d366,#128c7e);color:#fff;font-size:.95rem;font-weight:700;cursor:pointer;transition:opacity .2s,transform .1s}
  .btn:hover{opacity:.9}
  .btn:active{transform:scale(.98)}
  .btn:disabled{opacity:.45;cursor:not-allowed}
  .code-box{background:#0d0d14;border:1.5px solid #1e293b;border-radius:14px;padding:24px;text-align:center;margin:16px 0}
  .code-val{font-size:2.2rem;font-weight:800;letter-spacing:.3em;color:#25d366;font-variant-numeric:tabular-nums}
  .code-hint{font-size:.78rem;color:#64748b;margin-top:10px;line-height:1.5}
  .steps{list-style:none;margin:16px 0;display:flex;flex-direction:column;gap:8px}
  .steps li{display:flex;align-items:flex-start;gap:10px;font-size:.83rem;color:#94a3b8}
  .steps li .num{min-width:22px;height:22px;border-radius:50%;background:#1e293b;display:flex;align-items:center;justify-content:center;font-size:.72rem;font-weight:700;color:#60a5fa;flex-shrink:0}
  .spinner{width:40px;height:40px;border:3px solid #1e293b;border-top-color:#25d366;border-radius:50%;animation:spin .8s linear infinite;margin:20px auto}
  @keyframes spin{to{transform:rotate(360deg)}}
  .success-icon{font-size:3rem;text-align:center;margin:10px 0 16px}
  .err-box{background:#2d0a0a;border:1px solid #7f1d1d;border-radius:10px;padding:14px;font-size:.83rem;color:#fca5a5;margin:12px 0}
  .copy-btn{background:none;border:1px solid #1e293b;color:#94a3b8;border-radius:6px;padding:4px 12px;font-size:.75rem;cursor:pointer;margin-top:8px;transition:all .2s}
  .copy-btn:hover{border-color:#25d366;color:#25d366}
  #screen{display:none}
  #screen.active{display:block}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <div class="logo-icon">🤖</div>
    <div class="logo-text">
      <h1>Knight Bot</h1>
      <p>WhatsApp Bot Setup</p>
    </div>
  </div>

  <div id="statusBadge" class="status-badge badge-starting">
    <span class="dot"></span><span id="statusText">Starting…</span>
  </div>

  <!-- Starting screen -->
  <div id="screen-starting" class="screen">
    <div class="spinner"></div>
    <p class="sub" style="text-align:center">Bot is initializing, please wait…</p>
  </div>

  <!-- Phone number entry -->
  <div id="screen-waiting_for_number" class="screen">
    <h2>Link Your WhatsApp</h2>
    <p class="sub">Enter your WhatsApp number to get a pairing code. You will enter this code in the WhatsApp app.</p>
    <label>Phone Number (with country code, no + or spaces)</label>
    <input type="tel" id="phoneInput" placeholder="e.g. 14155552671" maxlength="15"/>
    <button class="btn" id="pairBtn" onclick="submitPhone()">Get Pairing Code</button>
  </div>

  <!-- Requesting code -->
  <div id="screen-requesting_code" class="screen">
    <div class="spinner"></div>
    <p class="sub" style="text-align:center">Requesting pairing code from WhatsApp…</p>
  </div>

  <!-- Show pairing code -->
  <div id="screen-waiting_for_pairing" class="screen">
    <h2>Enter This Code in WhatsApp</h2>
    <div class="code-box">
      <div class="code-val" id="codeDisplay">----</div>
      <button class="copy-btn" onclick="copyCode()">Copy</button>
      <p class="code-hint">Code expires in a few minutes</p>
    </div>
    <ul class="steps">
      <li><span class="num">1</span>Open WhatsApp on your phone</li>
      <li><span class="num">2</span>Go to <strong style="color:#f1f5f9">Settings → Linked Devices</strong></li>
      <li><span class="num">3</span>Tap <strong style="color:#f1f5f9">"Link a Device"</strong></li>
      <li><span class="num">4</span>Choose <strong style="color:#f1f5f9">"Link with phone number instead"</strong> and enter the code above</li>
    </ul>
  </div>

  <!-- Connected -->
  <div id="screen-connected" class="screen">
    <div class="success-icon">✅</div>
    <h2 style="text-align:center">Bot Connected!</h2>
    <p class="sub" style="text-align:center;margin-top:8px">Knight Bot is online and ready. You can close this page — the bot runs in the background.</p>
  </div>

  <!-- Error -->
  <div id="screen-error" class="screen">
    <h2>Something went wrong</h2>
    <div class="err-box" id="errMsg">Unknown error</div>
    <button class="btn" onclick="location.reload()">Retry</button>
  </div>
</div>

<script>
let lastStatus = null;

async function submitPhone() {
  const phone = document.getElementById('phoneInput').value.replace(/\\D/g,'');
  if (!phone || phone.length < 7) { alert('Please enter a valid phone number.'); return; }
  const btn = document.getElementById('pairBtn');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const res = await fetch('/api/pair', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ phone }) });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Failed to request pairing code'); btn.disabled=false; btn.textContent='Get Pairing Code'; }
  } catch(e) { alert('Network error: ' + e.message); btn.disabled=false; btn.textContent='Get Pairing Code'; }
}

function copyCode() {
  const code = document.getElementById('codeDisplay').textContent;
  navigator.clipboard.writeText(code.replace(/-/g,'')).then(() => {
    const btn = document.querySelector('.copy-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = 'Copy', 2000);
  });
}

const BADGE = {
  starting:           ['badge-starting',  'Starting…'],
  waiting_for_number: ['badge-waiting',   'Waiting for number'],
  requesting_code:    ['badge-requesting','Requesting code…'],
  waiting_for_pairing:['badge-pairing',   'Awaiting pairing'],
  connected:          ['badge-connected', 'Connected ✓'],
  error:              ['badge-error',     'Error'],
};

function applyStatus(state) {
  if (state.status === lastStatus) {
    if (state.status === 'waiting_for_pairing' && state.pairingCode) {
      document.getElementById('codeDisplay').textContent = state.pairingCode;
    }
    return;
  }
  lastStatus = state.status;

  document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
  const target = document.getElementById('screen-' + state.status);
  if (target) target.style.display = 'block';

  const badge = document.getElementById('statusBadge');
  badge.className = 'status-badge ' + (BADGE[state.status]?.[0] || 'badge-starting');
  document.getElementById('statusText').textContent = BADGE[state.status]?.[1] || state.status;

  if (state.status === 'waiting_for_pairing' && state.pairingCode) {
    document.getElementById('codeDisplay').textContent = state.pairingCode;
  }
  if (state.status === 'error' && state.error) {
    document.getElementById('errMsg').textContent = state.error;
  }
}

async function poll() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    applyStatus(data);
  } catch(e) { /* ignore transient errors */ }
  setTimeout(poll, 2000);
}

poll();
</script>
</body>
</html>`;

app.get('/', (_req, res) => res.send(PAGE));
app.get('/api/status', (_req, res) => res.json(botState));

app.post('/api/pair', (req, res) => {
    const phone = (req.body.phone || '').replace(/[^0-9]/g, '');
    if (!phone) return res.status(400).json({ error: 'Phone number is required.' });
    if (botState.status !== 'waiting_for_number') {
        return res.status(400).json({ error: 'Bot is not waiting for a phone number right now.' });
    }
    if (pendingPhoneResolve) {
        pendingPhoneResolve(phone);
        pendingPhoneResolve = null;
    }
    botState.status = 'requesting_code';
    res.json({ ok: true });
});

function startWebServer(port) {
    const p = port || process.env.PORT || 3000;
    return new Promise((resolve) => {
        app.listen(p, '0.0.0.0', () => {
            console.log(`🌐 Web UI available on port ${p} — open it in a browser to set up the bot`);
            resolve();
        });
    });
}

module.exports = { startWebServer, waitForPhoneNumber, setStatus };
