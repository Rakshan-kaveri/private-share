import { Signal } from './signal.js';
import { Call, canShareScreen, MAX_FILE } from './call.js';
import * as C from './crypto.js';

// ---------------------------------------------------------------- helpers
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name, cls = '') => `<svg class="ic ${cls}"><use href="#i-${name}"/></svg>`;
const initials = n => (String(n || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2) || '?').toUpperCase();
const bytes = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
const clock = ms => { const s = Math.floor(ms / 1000); const h = Math.floor(s / 3600); const m = Math.floor(s / 60) % 60; const ss = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`; };
const shortId = id => String(id).slice(-6);

const S = {
  config: { googleClientId: '', devLogin: false },
  token: '', user: null, signal: null,
  people: [], selected: null,
  call: null, incoming: null,
  received: [],
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], turn: false,
  online: false, fileMode: null,
  view: { rot: 0, fill: null, key: null },
};

async function api(path, { method = 'GET', body, token } = {}) {
  const r = await fetch(path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.message || `Request failed (${r.status})`); e.status = r.status; throw e; }
  return data;
}

function toast(message, level = 'info', ms = 6000) {
  const t = document.createElement('div');
  t.className = `toast ${level}`;
  t.innerHTML = `<p>${esc(message)}</p><button type="button" aria-label="Dismiss">${icon('x', 'sm')}</button>`;
  t.querySelector('button').onclick = () => t.remove();
  $('toasts').appendChild(t);
  while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
  if (ms) setTimeout(() => t.remove(), ms);
}

function show(view) {
  for (const v of ['view-login', 'view-home', 'view-call']) $(v).hidden = v !== view;
}

// ---------------------------------------------------------------- the dial (decorative SVG)
function dialSvg({ text = '', ticks = true } = {}) {
  let t = '';
  if (ticks) for (let i = 0; i < 60; i++) {
    const major = i % 5 === 0, a = (i / 60) * Math.PI * 2;
    const r1 = major ? 80 : 83, r2 = 88;
    t += `<line class="tick${major ? ' major' : ''}" x1="${(100 + r1 * Math.sin(a)).toFixed(2)}" y1="${(100 - r1 * Math.cos(a)).toFixed(2)}" x2="${(100 + r2 * Math.sin(a)).toFixed(2)}" y2="${(100 - r2 * Math.cos(a)).toFixed(2)}"/>`;
  }
  return `<svg class="dial" viewBox="0 0 200 200" aria-hidden="true">
    <circle class="glow" cx="100" cy="100" r="95"/>
    <circle class="ring bold" cx="100" cy="100" r="92"/>
    <g class="ticks">${t}<line class="tick major" x1="100" y1="6" x2="100" y2="14"/></g>
    <circle class="ring" cx="100" cy="100" r="74"/>
    <circle class="face" cx="100" cy="100" r="66"/>
    <circle class="ring bold" cx="100" cy="100" r="66"/>
    ${text ? `<text class="initials" x="100" y="111" text-anchor="middle">${esc(text)}</text>` : '<circle class="ring" cx="100" cy="100" r="40"/><circle class="ring bold" cx="100" cy="100" r="6"/>'}
  </svg>`;
}

// ---------------------------------------------------------------- modals
function modal(html, { wide = false, dismissable = true, onClose } = {}) {
  const root = document.createElement('div');
  root.className = 'backdrop';
  root.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${dismissable ? `<button class="icon-btn x" type="button" data-close aria-label="Close">${icon('x')}</button>` : ''}${html}</div>`;
  const close = () => { root.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(); };
  const onKey = e => { if (e.key === 'Escape' && dismissable) close(); };
  document.addEventListener('keydown', onKey);
  root.addEventListener('click', e => { if (dismissable && (e.target === root || e.target.closest('[data-close]'))) close(); });
  $('modal-root').appendChild(root);
  const focusable = root.querySelector('input, .btn-gold, button');
  if (focusable) setTimeout(() => focusable.focus(), 30);
  return { root, close };
}

function confirmModal({ title, body, yes, no = 'Cancel', danger = false }) {
  return new Promise(resolve => {
    let answered = false;
    const m = modal(`<h2>${esc(title)}</h2>${body}<div class="modal-actions"><button class="btn btn-line" type="button" data-no>${esc(no)}</button><button class="btn ${danger ? 'btn-red' : 'btn-gold'}" type="button" data-yes>${esc(yes)}</button></div>`, { onClose: () => { if (!answered) resolve(false); } });
    m.root.querySelector('[data-no]').onclick = () => { answered = true; m.close(); resolve(false); };
    m.root.querySelector('[data-yes]').onclick = () => { answered = true; m.close(); resolve(true); };
  });
}

function aboutModal() {
  modal(`<h2>How it stays private</h2>
    <p>This server signs you in and introduces two browsers to each other. Calls, screens and files then travel directly between the two devices.</p>
    <ol class="steps">
      <li><div><strong>You sign in</strong><span>Google confirms who you are. The server learns your name and that you're online, nothing more.</span></div></li>
      <li><div><strong>Your browsers exchange keys</strong><span>Each call creates fresh ECDH P-256 keys. Every key and every connection description is signed by a device key that never leaves your browser, so the server can't swap them.</span></div></li>
      <li><div><strong>The connection opens</strong><span>WebRTC connects the devices directly when it can. Audio, video and screen are encrypted with DTLS-SRTP; if a TURN relay is needed it only ever sees encrypted packets.</span></div></li>
      <li><div><strong>Files are sealed before sending</strong><span>Each file gets its own AES-256-GCM key. Every chunk is authenticated, and the sender signs a fingerprint of the whole file. Anything that doesn't check out is discarded.</span></div></li>
    </ol>
    <div class="limits"><h3>Worth knowing</h3><ul>
      <li>The first call with someone trusts the key it sees. Compare the safety code out loud once; if it matches on both screens, nobody is in the middle.</li>
      <li>Using a new browser or clearing site data creates a new device key, and the other person will see a warning.</li>
      <li>Some mobile networks block direct connections. A TURN relay (see the setup guide) makes those calls work.</li>
      <li>Received files live in the tab's memory until you save them. Files up to 1 GB each.</li>
      <li>Screen sound is shared from Chrome or Edge on a computer when you tick "Share audio" in the picker. Safari and Firefox share the picture only.</li>
      <li>Most phone browsers can watch a shared screen but can't share their own.</li>
    </ul></div>
    ${S.user ? `<div class="limits relay-check"><h3>Relay server</h3>
      <p id="relay-status">${S.turn ? 'A TURN relay is configured. Check that this device can reach it.' : 'No TURN relay is configured on this server, so calls only connect where a direct path exists.'}</p>
      ${S.turn ? '<button class="btn btn-line btn-sm" type="button" id="relay-btn">Check relay</button>' : ''}</div>` : ''}`, { wide: true });
  const btn = $('relay-btn');
  if (btn) btn.onclick = async () => {
    btn.disabled = true;
    $('relay-status').textContent = 'Checking…';
    const r = await checkRelay();
    $('relay-status').textContent = r === 'ok'
      ? 'Relay works. Calls from mobile data and strict Wi-Fi can connect through it.'
      : "This device couldn't reach the relay. Check the firewall rule for UDP/TCP 3478 and UDP 49160-49200, and that coturn is running.";
    btn.disabled = false;
  };
}

// Ask the browser for a relay-only candidate. Getting one proves the TURN server is reachable
// and accepted this app's short-lived credentials.
async function checkRelay() {
  const hasTurn = S.iceServers.some(s => [].concat(s.urls).some(u => /^turns?:/.test(u)));
  if (!hasTurn) return 'none';
  let pc;
  try {
    pc = new RTCPeerConnection({ iceServers: S.iceServers, iceTransportPolicy: 'relay' });
    pc.createDataChannel('probe');
    const found = new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 8000);
      pc.onicecandidate = e => {
        if (!e.candidate) { clearTimeout(timer); resolve(false); }
        else if (/ typ relay /.test(e.candidate.candidate)) { clearTimeout(timer); resolve(true); }
      };
    });
    await pc.setLocalDescription(await pc.createOffer());
    return (await found) ? 'ok' : 'fail';
  } catch { return 'fail'; }
  finally { try { pc && pc.close(); } catch { /* ignore */ } }
}

function renameModal() {
  const m = modal(`<h2>Your display name</h2><p>People see this name in their list when you're online.</p>
    <form id="rename-form"><input id="rename-input" maxlength="32" value="${esc(S.user.displayName)}" aria-label="Display name">
    <div class="modal-actions"><button class="btn btn-line" type="button" data-close>Cancel</button><button class="btn btn-gold" type="submit">Save name</button></div></form>`);
  m.root.querySelector('form').onsubmit = e => {
    e.preventDefault();
    const name = $('rename-input').value.trim().replace(/\s+/g, ' ').slice(0, 32);
    if (!name) return;
    try { localStorage.setItem('ps-display-name', name); } catch { /* private mode */ }
    S.user.displayName = name;
    S.signal && S.signal.send({ type: 'profile', displayName: name });
    renderHeader(); m.close(); toast('Name saved.');
  };
}

function safetyModal() {
  const call = S.call;
  if (!call || !call.safety) return;
  const m = modal(`<h2>Safety code</h2>
    <p>Read this code to ${esc(call.peer.displayName)} and ask them to read theirs. If the twelve digits match, your call and files are going straight to them and nobody is in between.</p>
    <div class="code-big">${esc(call.safety)}</div>
    <p class="fine">${call.verified ? 'You have already marked this contact as verified on this browser.' : 'Mark it as verified once it matches. You only need to do this once per device.'}</p>
    <div class="modal-actions"><button class="btn btn-line" type="button" data-close>Close</button>${call.verified ? '' : '<button class="btn btn-gold" type="button" data-verify>It matches</button>'}</div>`);
  const v = m.root.querySelector('[data-verify]');
  if (v) v.onclick = async () => {
    if (await C.markVerified(call.peer.id, call.peerIdentity)) { call.verified = true; toast(`${call.peer.displayName} is marked as verified on this browser.`); }
    m.close(); renderCall();
  };
}

// ---------------------------------------------------------------- sign in
async function boot() {
  if (!window.isSecureContext) {
    $('banner').textContent = 'This page is not on a secure connection, so calls and encryption are switched off. Open it with https:// (or on localhost).';
    $('banner').hidden = false;
  }
  $('login-dial').innerHTML = dialSvg();
  try { S.config = await api('/api/config'); } catch { /* server unreachable: show login anyway */ }

  let saved = '';
  try { saved = sessionStorage.getItem('ps-token') || ''; } catch { /* ignore */ }
  if (saved) {
    try { const s = await api('/api/auth/session', { method: 'POST', body: {}, token: saved }); return startSession({ ...s, token: saved }); }
    catch { try { sessionStorage.removeItem('ps-token'); } catch { /* ignore */ } }
  }
  showLogin();
}

function showLogin(message) {
  show('view-login');
  $('login-error').hidden = !message;
  $('login-error').textContent = message || '';
  $('dev-form').hidden = !S.config.devLogin;
  $('login-empty').hidden = !!(S.config.googleClientId || S.config.devLogin);
  if (S.config.googleClientId) loadGoogle();
}

let googleLoaded = false;
function loadGoogle() {
  const render = () => {
    window.google.accounts.id.initialize({
      client_id: S.config.googleClientId,
      callback: async resp => {
        try { const s = await api('/api/auth/google', { method: 'POST', body: { credential: resp.credential } }); startSession(s); }
        catch (e) { showLogin(e.message); }
      },
    });
    $('google-btn').innerHTML = '';
    window.google.accounts.id.renderButton($('google-btn'), { theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', logo_alignment: 'left', width: Math.min(300, $('google-btn').clientWidth || 300) });
  };
  if (googleLoaded && window.google?.accounts?.id) return render();
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
  s.onload = () => { googleLoaded = true; render(); };
  s.onerror = () => { $('login-error').textContent = "Couldn't load Google sign-in. Check your connection and reload."; $('login-error').hidden = false; };
  document.head.appendChild(s);
}

$('dev-form').addEventListener('submit', async e => {
  e.preventDefault();
  try { startSession(await api('/api/auth/dev', { method: 'POST', body: { name: $('dev-name').value } })); }
  catch (err) { showLogin(err.message); }
});

async function startSession(s) {
  S.token = s.token;
  try { sessionStorage.setItem('ps-token', s.token); } catch { /* ignore */ }
  let name = '';
  try { name = localStorage.getItem('ps-display-name') || ''; } catch { /* ignore */ }
  S.user = { id: s.id, displayName: name || s.displayName || 'Guest' };
  C.identity().catch(e => toast(`Encryption keys unavailable: ${e.message}`, 'error', 0));
  await refreshIce();
  connectSignal();
  show('view-home');
  renderHeader(); renderPeople(); renderLine(); renderReceived();
}

// Fresh TURN credentials for every call, so a relay set up (or a secret changed) after sign-in is used.
async function refreshIce() {
  try {
    const ice = await api('/api/ice-config', { token: S.token });
    if (Array.isArray(ice.iceServers)) S.iceServers = ice.iceServers;
    S.turn = !!ice.turn;
  } catch { /* keep the previous list; STUN still works */ }
  return S.iceServers;
}

async function signOut(message) {
  if (S.call) S.call.hangup();
  if (S.incoming) S.incoming.decline();
  if (S.token) api('/api/auth/logout', { method: 'POST', body: {}, token: S.token }).catch(() => {});
  S.signal && S.signal.close();
  S.signal = null; S.token = ''; S.user = null; S.people = []; S.selected = null;
  try { sessionStorage.removeItem('ps-token'); } catch { /* ignore */ }
  showLogin(message);
}

// ---------------------------------------------------------------- signalling
function connectSignal() {
  const sig = new Signal({ token: S.token, getDisplayName: () => S.user.displayName, getActiveSid: () => S.call && S.call.state !== 'ended' ? S.call.sid : '' });
  S.signal = sig;
  const on = (type, fn) => sig.addEventListener(type, e => fn(e.detail));
  on('status', d => { S.online = d.online; renderHeader(); });
  on('presence', d => { S.people = (d.users || []).filter(u => u.id !== S.user.id); renderPeople(); renderLine(); });
  on('auth-failed', () => signOut('Your session expired. Sign in again.'));
  on('replaced', () => { if (S.call) S.call.end('replaced'); S.signal = null; try { sessionStorage.removeItem('ps-token'); } catch { /* ignore */ } showLogin('You signed in on another tab or device, so this one was signed out.'); });
  on('invite', m => onInvite(m));
  const route = (m, fn) => {
    const c = S.call && S.call.sid === m.sid ? S.call : S.incoming && S.incoming.sid === m.sid ? S.incoming : null;
    if (c && m.from === c.peer.id) c.enqueue(() => fn(c));
  };
  on('accept', m => route(m, c => c.onAccept(m.payload, keyChangedPrompt)));
  on('reject', m => route(m, c => c.end(m.payload && m.payload.reason === 'busy' ? 'busy' : 'declined')));
  on('sdp', m => route(m, c => c.onSdp(m.payload)));
  on('ice', m => route(m, c => c.onIce(m.payload)));
  on('hangup', m => route(m, c => c.end(m.payload && m.payload.reason === 'timeout' ? 'no-answer' : 'peer-hangup')));
  on('unavailable', m => { if (S.call && S.call.sid === m.sid) S.call.end('unavailable'); });
  on('error', m => toast(m.message || 'Signalling error', 'error'));
  sig.connect();
}

async function keyChangedPrompt(call) {
  return confirmModal({
    title: 'Security key changed',
    body: `<p>${esc(call.peer.displayName)} is using a different device key than last time.</p><p class="warn-box">This is expected if they changed browser, device or cleared their data. If not, someone may be trying to listen in. After connecting, compare the safety code out loud.</p>`,
    yes: 'Trust and connect', no: 'End call', danger: true,
  });
}

// ---------------------------------------------------------------- people + the line
function renderHeader() {
  if (!S.user) return;
  $('me-name').textContent = S.user.displayName;
  $('conn-dot').className = `dot ${S.online ? 'on' : ''}`;
  $('conn-dot').title = S.online ? 'Connected' : 'Reconnecting…';
}

function renderPeople() {
  const list = $('people');
  $('people-empty').hidden = S.people.length > 0;
  list.innerHTML = S.people.map(p => `<li><button class="person" type="button" data-person="${esc(p.id)}" aria-current="${S.selected === p.id}">
      <span class="avatar">${esc(initials(p.displayName))}</span>
      <span class="person-text"><span class="person-name">${esc(p.displayName)}</span><span class="person-sub">Online · ID ${esc(shortId(p.id))}</span></span>
    </button></li>`).join('');
}

function renderLine() {
  const line = $('line');
  const p = S.people.find(x => x.id === S.selected);
  document.querySelector('.line-scrim')?.remove();
  if (!p) {
    line.classList.remove('open');
    line.innerHTML = `<div class="line-empty"><div><div class="dial-sm">${dialSvg()}</div><p>Choose someone from the list to call them, share your screen or send files.</p></div></div>`;
    return;
  }
  const screenOk = canShareScreen();
  line.innerHTML = `
    <div class="line-head">
      <button class="icon-btn line-back" type="button" data-action="close-line" aria-label="Back">${icon('back')}</button>
      <span class="avatar">${esc(initials(p.displayName))}</span>
      <div><div class="line-name">${esc(p.displayName)}</div><div class="line-sub">Online now · ID ${esc(shortId(p.id))}</div></div>
    </div>
    <div class="actions">
      <button class="action" type="button" data-start="voice">${icon('phone')}<strong>Voice call</strong><small>Microphone only</small></button>
      <button class="action" type="button" data-start="video">${icon('cam')}<strong>Video call</strong><small>Camera and microphone</small></button>
      <button class="action" type="button" data-start="screen" ${screenOk ? '' : 'disabled'}>${icon('screen')}<strong>Share screen</strong><small>${screenOk ? 'They see your screen' : "This browser can't share"}</small></button>
      <button class="action" type="button" data-start="file">${icon('file')}<strong>Send files</strong><small>Up to 1 GB each</small></button>
    </div>
    <p class="fine line-note">${screenOk ? 'Everything is encrypted between your two browsers. You can switch the camera, screen and files on or off once the call starts.' : 'Phone browsers can watch a shared screen but not share their own. Calls and files work as normal.'}</p>`;
  if (matchMedia('(max-width: 820px)').matches) {
    line.classList.add('open');
    const scrim = document.createElement('div');
    scrim.className = 'line-scrim';
    scrim.onclick = () => { S.selected = null; renderPeople(); renderLine(); };
    line.before(scrim);
  }
}

function renderReceived() {
  const done = S.received.filter(t => t.status === 'done' && t.url);
  $('received').hidden = done.length === 0;
  $('received-list').innerHTML = done.map(t => xferHtml(t, true)).join('');
}

// ---------------------------------------------------------------- starting and answering
async function startCall(intent, files = []) {
  const peer = S.people.find(x => x.id === S.selected);
  if (!peer || S.call || S.incoming) return;
  if (!window.isSecureContext) return toast('Calls need a secure connection. Open this site with https://.', 'error');
  if (!S.online) return toast('Reconnecting to the server. Try again in a moment.', 'error');
  unlockAudio();
  const call = new Call({ sid: C.randomHex(16), me: S.user, peer: { ...peer }, role: 'caller', intent, signal: S.signal, iceServers: S.iceServers });
  S.call = call;
  bindCall(call);
  try { await call.prepareLocal(); } catch (e) { S.call = null; call.end('declined-local'); return toast(e.message, 'error'); }
  if (call.intent === 'screen' && call.local.screen && !call.local.screenAudio && screenAudioPossible()) toast('Sharing without sound. To include sound, tick "Share audio" in the picker next time.');
  openCallView();
  call.iceServers = await refreshIce();
  try { await call.invite(files); } catch (e) { toast(e.message, 'error'); call.end('local'); }
}

async function onInvite(m) {
  const p = m.payload || {};
  const busy = (S.call && S.call.state !== 'ended') || S.incoming;
  if (busy) { S.signal.send({ type: 'reject', to: m.from, sid: m.sid, payload: { reason: 'busy' } }); return; }
  const call = new Call({ sid: m.sid, me: S.user, peer: { id: m.from, displayName: m.fromName || 'Someone' }, role: 'callee', intent: p.intent, signal: S.signal, iceServers: S.iceServers });
  S.incoming = call;
  let key;
  try { key = await call.receiveInvite(p.bundle); }
  catch (e) { S.incoming = null; call.decline('invalid'); toast(`Blocked a call from ${call.peer.displayName}: ${e.message}`, 'error'); return; }
  if (S.incoming !== call) return;
  showIncoming(call, key);
}

function showIncoming(call, key) {
  const name = esc(call.peer.displayName);
  const files = call.peerBundle.files;
  const what = {
    voice: `${name} is calling you`,
    video: `${name} wants a video call`,
    screen: `${name} wants to share their screen`,
    file: `${name} wants to send you ${files.length === 1 ? 'a file' : `${files.length} files`}`,
  }[call.intent];
  const list = call.intent === 'file' && files.length ? `<ul class="file-preview">${files.slice(0, 6).map(f => `<li><span>${esc(f.name)}</span><span>${bytes(f.size)}</span></li>`).join('')}${files.length > 6 ? `<li><span>and ${files.length - 6} more</span><span></span></li>` : ''}</ul>` : '';
  const warn = key.status === 'changed'
    ? `<p class="warn-box">${name}'s device key has changed since your last call. That's expected after a new browser or device. If you weren't expecting it, decline.</p>` : '';
  const answerLabel = call.intent === 'file' ? 'Accept files' : call.intent === 'screen' ? 'Watch' : 'Answer';
  const m = modal(`<div class="ring-modal"><div class="call-dial spin">${dialSvg({ text: initials(call.peer.displayName) })}</div>
      <h2>${what}</h2>${list}${warn}
      <div class="modal-actions"><button class="btn btn-red" type="button" data-decline>Decline</button><button class="btn btn-gold" type="button" data-answer>${key.status === 'changed' ? 'Trust and answer' : answerLabel}</button></div></div>`, { dismissable: false });
  ring(call.intent === 'file' ? 'file' : 'incoming');
  const prevTitle = document.title;
  document.title = `Incoming · ${call.peer.displayName}`;
  const done = () => { stopRing(); m.close(); document.title = prevTitle; };
  call.addEventListener('ended', () => {
    if (S.incoming === call) { S.incoming = null; done(); if (call.endReason !== 'declined-local') toast(`Missed ${call.intent === 'file' ? 'files' : 'call'} from ${call.peer.displayName}.`); }
  }, { once: true });
  m.root.querySelector('[data-decline]').onclick = () => { S.incoming = null; done(); call.decline(); };
  m.root.querySelector('[data-answer]').onclick = async () => {
    unlockAudio();
    S.incoming = null; done();
    S.call = call;
    bindCall(call);
    openCallView();
    call.iceServers = await refreshIce();
    try { const warnings = await call.answer(); warnings.forEach(w => toast(w, 'error')); }
    catch (e) { toast(e.message, 'error'); call.hangup('error'); }
  };
}

// ---------------------------------------------------------------- call view
let tick = null;
function bindCall(call) {
  const rerender = () => renderCall();
  call.addEventListener('state', rerender);
  call.addEventListener('local', rerender);
  call.addEventListener('remote', rerender);
  call.addEventListener('transfers', () => {
    for (const t of call.transfers.values()) if (t.dir === 'in' && t.status === 'done' && t.url && !S.received.includes(t)) S.received.unshift(t);
    renderTransfers();
  });
  call.addEventListener('notice', e => toast(e.detail.message, e.detail.level));
  call.addEventListener('ended', e => onCallEnded(call, e.detail.reason));
}

function openCallView() {
  const call = S.call;
  const vc = $('view-call');
  vc.classList.toggle('mode-file', call.isFile);
  vc.classList.toggle('show-files', call.isFile || (matchMedia('(min-width: 821px)').matches && call.transfers.size > 0));
  $('call-dial').innerHTML = dialSvg({ text: initials(call.peer.displayName) });
  S.view = { rot: 0, fill: null, key: null };
  show('view-call');
  if (call.role === 'caller' && !call.isFile) ring('outgoing');
  clearInterval(tick);
  tick = setInterval(() => { renderMeta(); renderSteps(); }, 1000);
  renderCall(); renderTransfers();
}

function attach(video, stream) {
  if (video.srcObject !== stream) {
    video.srcObject = stream;
    if (stream) video.play().catch(() => {});
  }
}

function renderMeta() {
  const call = S.call;
  if (!call) return;
  const parts = [];
  const st = call.state;
  if (st === 'calling') parts.push(`<span>${call.isFile ? 'Waiting for them to accept…' : 'Ringing…'}</span>`);
  else if (st === 'connecting') parts.push('<span>Connecting…</span>');
  else if (st === 'reconnecting') parts.push('<span class="warn">Reconnecting…</span>');
  else if (st === 'connected') {
    parts.push(`<span class="ok">${icon('lock', 'sm')} End-to-end encrypted</span>`);
    if (call.route) parts.push(`<span>${call.route === 'Direct' ? 'Direct' : 'Relayed'}</span>`);
    if (!call.isFile) parts.push(`<span>${clock(Date.now() - call.connectedAt)}</span>`);
  }
  $('call-meta').innerHTML = parts.join('');
}

// The connection steps are a real sequence, shown while a session is being set up.
function renderSteps() {
  const call = S.call;
  const box = call && call.isFile ? $('file-steps') : $('call-steps');
  const other = call && call.isFile ? $('call-steps') : $('file-steps');
  other.hidden = true;
  if (!call || call.state === 'connected' || call.state === 'ended') { box.hidden = true; return; }
  const name = esc(call.peer.displayName);
  const steps = [];
  if (call.role === 'caller') steps.push(['ringing', `${name} accepted`, `Waiting for ${name} to accept`]);
  else if (!call.isFile) steps.push(['permission', 'Microphone and camera ready', 'Waiting for microphone and camera']);
  steps.push(['keys', 'Keys exchanged and verified', 'Exchanging and verifying keys'], ['route', 'Network route found', 'Finding a network route'], ['connected', 'Connected', 'Connected']);
  const order = ['incoming', 'ringing', 'permission', 'keys', 'route', 'connected'];
  const at = order.indexOf(call.phase === 'incoming' ? 'permission' : call.phase);
  const slow = call.phase === 'route' && call.routeStarted && Date.now() - call.routeStarted > 12000;
  box.hidden = false;
  box.innerHTML = steps.map(([k, doneLabel, nowLabel]) => {
    const i = order.indexOf(k);
    const cls = i < at ? 'done' : i === at ? 'now' : '';
    return `<li class="${cls}">${cls === 'done' ? icon('check', 'sm') : '<i></i>'}<span>${cls === 'done' ? doneLabel : cls === 'now' ? `${nowLabel}…` : doneLabel}</span></li>`;
  }).join('') + (slow ? `<li class="hint">${S.turn ? 'Taking longer than usual. Trying the relay server…' : 'Taking longer than usual. One of the networks may block direct connections, and no relay server is set up.'}</li>` : '');
}

function applyView() {
  const v = $('v-main'), st = $('stage');
  const r = S.view.rot;
  const mobile = matchMedia('(max-width: 820px)').matches;
  const call = S.call;
  const isCam = call && !(call.remoteState.screen && call.remote.screen);
  const fill = S.view.fill === null ? (isCam && mobile) : S.view.fill;
  v.classList.toggle('cover', !!fill);
  if (r % 180 === 0) {
    v.classList.remove('rot');
    for (const p of ['width', 'height', 'left', 'top']) v.style.removeProperty(p);
    v.style.setProperty('transform', r ? 'rotate(180deg)' : 'none');
  } else {
    v.classList.add('rot');
    v.style.setProperty('width', `${st.clientHeight}px`);
    v.style.setProperty('height', `${st.clientWidth}px`);
    v.style.setProperty('left', '50%');
    v.style.setProperty('top', '50%');
    v.style.setProperty('transform', `translate(-50%, -50%) rotate(${r}deg)`);
  }
  $('t-fit').querySelector('span').textContent = fill ? 'Fit' : 'Fill';
  $('t-fit').title = fill ? 'Show the whole picture' : 'Fill the screen';
}

function renderCall() {
  const call = S.call;
  if (!call || $('view-call').hidden) return;
  if (call.state !== 'calling') stopRing();
  if (call.phase === 'route' && !call.routeStarted) call.routeStarted = Date.now();
  $('call-name').textContent = call.isFile ? `Files with ${call.peer.displayName}` : call.peer.displayName;
  renderMeta();
  renderSteps();
  $('btn-done').hidden = !call.isFile;

  const sb = $('btn-safety');
  sb.hidden = !call.safety;
  if (call.safety) { sb.innerHTML = `<span>${call.verified ? 'Verified' : 'Safety code'}</span><b>${esc(call.safety)}</b>`; sb.classList.toggle('verified', !!call.verified); }
  if (call.isFile) return;

  // stage: remote screen > remote camera > dial
  const rs = call.remoteState, rem = call.remote;
  const screenOn = rs.screen && rem.screen, camOn = rs.cam && rem.camera;
  const main = screenOn ? rem.screen : camOn ? rem.camera : null;
  const key = screenOn ? 'screen' : camOn ? 'camera' : null;
  if (key !== S.view.key) { S.view = { rot: 0, fill: null, key }; }
  const v = $('v-main');
  attach(v, main);
  v.hidden = !main;
  $('stage-idle').hidden = !!main;
  $('stage-tools').hidden = !main;
  if (main) applyView();
  const small = $('v-remote-cam');
  attach(small, screenOn && camOn ? rem.camera : null);
  small.hidden = !(screenOn && camOn);
  $('call-dial').classList.toggle('spin', call.state === 'calling' || call.state === 'connecting');

  const status = {
    calling: `Calling ${call.peer.displayName}…`,
    connecting: '',
    reconnecting: 'Connection dropped. Trying to reconnect…',
    connected: rs.mic ? `${call.peer.displayName}'s microphone is on.` : `${call.peer.displayName} is muted.`,
  }[call.state] || '';
  $('stage-status').textContent = status;
  $('stage-status').hidden = !status;

  // self preview
  const L = call.local;
  const selfTrack = L.cam || L.screen || null;
  const sv = $('v-self');
  if ((sv.srcObject && sv.srcObject.getVideoTracks()[0]) !== selfTrack) attach(sv, selfTrack ? new MediaStream([selfTrack]) : null);
  $('tile-self').hidden = !selfTrack;
  $('tile-self').classList.toggle('mirror', !!L.cam && call.facing === 'user');
  $('self-label').textContent = L.cam ? (L.screen ? 'You · sharing screen' : 'You') : (L.screenAudio ? 'Your screen · with sound' : 'Your screen');

  // remote audio: voice and the shared screen's sound play through separate elements
  const a = $('remote-audio');
  if (a.srcObject !== rem.audio) { a.srcObject = rem.audio; if (rem.audio) a.play().catch(() => toast('Tap anywhere to turn on call audio.')); }
  const sa = $('remote-screen-audio');
  if (sa.srcObject !== rem.screenAudio) { sa.srcObject = rem.screenAudio; if (rem.screenAudio) sa.play().catch(() => {}); }
  meterFor(rem.audio);

  // controls
  const setCtl = (id, { on, off, label, ico, disabled, hidden }) => {
    const b = $(id);
    b.hidden = !!hidden; b.disabled = !!disabled;
    b.classList.toggle('on', !!on); b.classList.toggle('off', !!off);
    b.querySelector('use').setAttribute('href', `#i-${ico}`);
    b.querySelector('span').textContent = label;
    b.setAttribute('aria-pressed', on || off ? 'true' : 'false');
  };
  const live = call.state !== 'ended';
  const micLive = !!L.mic && !call.micMuted;
  setCtl('c-mic', { off: !micLive, label: L.mic ? (call.micMuted ? 'Unmute' : 'Mute') : 'Mic off', ico: micLive ? 'mic' : 'mic-off', disabled: !live });
  setCtl('c-cam', { on: !!L.cam, label: L.cam ? 'Camera on' : 'Camera', ico: L.cam ? 'cam' : 'cam-off', disabled: !live });
  setCtl('c-flip', { label: 'Flip', ico: 'flip', hidden: !(L.cam && call.canFlip) });
  setCtl('c-screen', { on: !!L.screen, label: L.screen ? 'Stop share' : 'Share', ico: L.screen ? 'screen-off' : 'screen', hidden: !canShareScreen(), disabled: !live });
}

// remote voice level → dial glow
let meter = null;
let audioCtx = null;
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* no audio context */ }
}
function meterFor(stream) {
  if (meter && meter.stream === stream) return;
  if (meter) { cancelAnimationFrame(meter.raf); try { meter.src.disconnect(); } catch { /* ignore */ } meter = null; }
  $('stage-idle').style.setProperty('--level', '0');
  if (!stream || !audioCtx) return;
  try {
    const src = audioCtx.createMediaStreamSource(stream);
    const an = audioCtx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    meter = { stream, src, raf: 0 };
    let smooth = 0;
    const loop = () => {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const x = (buf[i] - 128) / 128; sum += x * x; }
      const level = Math.min(1, Math.sqrt(sum / buf.length) * 6);
      smooth = smooth * 0.7 + level * 0.3;
      $('stage-idle').style.setProperty('--level', smooth.toFixed(3));
      meter.raf = requestAnimationFrame(loop);
    };
    loop();
  } catch { meter = null; }
}

// ---------------------------------------------------------------- transfers
const STATUS_TEXT = {
  offered: t => t.dir === 'out' ? 'Waiting for them to accept' : 'Wants to send you this file',
  accepted: () => 'Starting…', sending: () => 'Encrypting and sending', receiving: () => 'Receiving and decrypting',
  verifying: () => 'Sent · waiting for their check', done: t => t.dir === 'out' ? 'Delivered and verified' : 'Verified · ready to save',
  declined: t => t.dir === 'out' ? 'They declined' : 'You declined', cancelled: t => t.error || 'Cancelled', failed: t => t.error || 'Failed',
};
function xferHtml(t, compact = false) {
  const pct = t.size ? Math.round(t.done / t.size * 100) : 100;
  const active = ['sending', 'receiving', 'accepted'].includes(t.status);
  const rate = active && t.startedAt && t.done ? ` · ${bytes(Math.round(t.done / Math.max(0.5, (Date.now() - t.startedAt) / 1000)))}/s` : '';
  const metaCls = ['failed', 'cancelled', 'declined'].includes(t.status) ? 'bad' : t.status === 'done' ? 'good' : '';
  const thumb = t.url && /^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(t.mime) ? `<img class="xfer-thumb" src="${esc(t.url)}" alt="">` : `<span class="xfer-ic">${icon(t.dir === 'out' ? 'file' : 'down')}</span>`;
  let actions = '';
  if (t.dir === 'in' && t.status === 'offered') actions = `<button class="btn btn-line btn-sm" type="button" data-decline-file="${t.id}">Decline</button><button class="btn btn-gold btn-sm" type="button" data-accept-file="${t.id}">Accept</button>`;
  else if (t.dir === 'in' && t.status === 'done' && t.url) actions = `<a class="btn btn-gold btn-sm" href="${esc(t.url)}" download="${esc(t.name)}">Save</a>`;
  else if (!compact && (active || t.status === 'offered')) actions = `<button class="icon-btn" type="button" data-cancel-file="${t.id}" title="Cancel">${icon('x')}</button>`;
  return `<li class="xfer"><div class="xfer-top">${thumb}<div class="xfer-text"><span class="xfer-name" title="${esc(t.name)}">${esc(t.name)}</span>
    <span class="xfer-meta ${metaCls}">${bytes(t.size)} · ${esc(STATUS_TEXT[t.status](t))}${active ? ` · ${pct}%${rate}` : ''}</span></div><div class="xfer-actions">${actions}</div></div>
    ${active ? `<div class="bar-track"><div class="bar-fill" data-pct="${pct}"></div></div>` : ''}</li>`;
}
function paintBars(root) { root.querySelectorAll('.bar-fill').forEach(b => b.style.setProperty('width', `${b.dataset.pct}%`)); }

function renderTransfers() {
  const call = S.call;
  if (!call) return;
  const list = [...call.transfers.values()].reverse();
  $('call-files').innerHTML = list.map(t => xferHtml(t)).join('');
  paintBars($('call-files'));
  $('files-empty').hidden = list.length > 0;
  const waiting = list.filter(t => t.dir === 'in' && (t.status === 'offered' || (t.status === 'done' && !t.seen))).length;
  const open = $('view-call').classList.contains('show-files') || call.isFile;
  if (open) list.forEach(t => { if (t.status === 'done') t.seen = true; });
  $('files-badge').hidden = open || waiting === 0;
  $('files-badge').textContent = waiting;
  if (!open && list.some(t => t.dir === 'in' && t.status === 'offered' && !t.notified)) {
    list.forEach(t => { if (t.dir === 'in' && t.status === 'offered') t.notified = true; });
    if (matchMedia('(min-width: 821px)').matches) { $('view-call').classList.add('show-files'); renderTransfers(); }
    else toast(`${call.peer.displayName} wants to send you a file. Open Files to accept it.`);
  }
  renderReceived();
}

function sendFiles(files) {
  const call = S.call;
  if (!call || call.state === 'ended') return;
  for (const f of files) {
    try { call.addOutgoing(f); } catch (e) { toast(e.message, 'error'); }
  }
  $('view-call').classList.add('show-files');
  renderTransfers();
}

// ---------------------------------------------------------------- ending
const END_TEXT = {
  'peer-hangup': n => `${n} ended the call.`, local: () => 'Call ended.', declined: n => `${n} declined.`,
  busy: n => `${n} is busy on another call.`, 'no-answer': n => `No answer from ${n}.`, unavailable: n => `${n} is no longer online.`,
  'declined-local': () => '', replaced: () => '',
};
function onCallEnded(call, reason) {
  if (S.call !== call) return;
  S.call = null;
  stopRing();
  clearInterval(tick);
  meterFor(null);
  for (const id of ['v-main', 'v-remote-cam', 'v-self', 'remote-audio']) { try { $(id).srcObject = null; } catch { /* ignore */ } }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (S.user) { show('view-home'); renderPeople(); renderLine(); renderReceived(); }
  const n = call.peer.displayName;
  let text = END_TEXT[reason] ? END_TEXT[reason](n) : '';
  if (call.isFile && reason === 'local') text = 'File transfer closed.';
  if (call.isFile && reason === 'peer-hangup') text = `${n} closed the file transfer.`;
  if (reason === 'failed') {
    text = {
      keys: `Couldn't finish the key exchange with ${n}. Ask them to reload the page and try again.`,
      dropped: `Lost the connection to ${n}. Check both internet connections and try again.`,
      'no-remote': `${n}'s device never sent its network details. They may have closed the tab, lost signal, or be on an old version of the page (ask them to reload).`,
      'no-relay': `Keys were exchanged, but this device couldn't reach the relay server, so there was no route to ${n}. Open the lock menu and use "Check relay".`,
      'no-turn': `Keys were exchanged, but your two networks block a direct connection and this server has no relay set up. A TURN relay fixes this (see deploy/GOOGLE-CLOUD.md).`,
      blocked: `This browser isn't allowed to make direct connections. A VPN, privacy extension or browser setting is blocking WebRTC. Turn it off for this site and try again.`,
      'relay-only': `This browser only allows relayed connections (a VPN, privacy extension or browser setting), and it couldn't reach the relay server. Open the lock menu and use "Check relay", or turn that setting off for this site.`,
      'peer-no-relay': `Keys were exchanged, but ${n}'s device couldn't reach the relay server. Their network may block it; ask them to try mobile data or another Wi-Fi.`,
      'no-route': `Keys were exchanged, but no network route to ${n} worked, not even the relay. Ask ${n} to open the lock menu and use "Check relay" on their device.`,
    }[call.failure] || `Couldn't connect to ${n}.`;
  }
  if (text) toast(text, reason === 'failed' ? 'error' : 'info', reason === 'failed' ? 12000 : 5000);
}

// ---------------------------------------------------------------- ringing tones
let ringTimer = null;
function ring(kind) {
  stopRing();
  const play = () => {
    if (kind === 'incoming' && navigator.vibrate) navigator.vibrate([250, 150, 250]);
    if (!audioCtx || audioCtx.state !== 'running') return;
    const t0 = audioCtx.currentTime;
    const freqs = kind === 'incoming' ? [[660, 0], [880, 0.18], [660, 0.6], [880, 0.78]] : kind === 'file' ? [[880, 0], [1175, 0.14]] : [[440, 0], [480, 0]];
    for (const [f, at] of freqs) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f; o.type = 'sine';
      const len = kind === 'outgoing' ? 1.2 : 0.16;
      g.gain.setValueAtTime(0, t0 + at);
      g.gain.linearRampToValueAtTime(kind === 'outgoing' ? 0.035 : 0.07, t0 + at + 0.02);
      g.gain.linearRampToValueAtTime(0, t0 + at + len);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0 + at); o.stop(t0 + at + len + 0.05);
    }
  };
  unlockAudio();
  play();
  if (kind === 'file') return;
  ringTimer = setInterval(play, kind === 'incoming' ? 2400 : 4000);
}
function stopRing() { clearInterval(ringTimer); ringTimer = null; }

// ---------------------------------------------------------------- events
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action],[data-person],[data-start],[data-accept-file],[data-decline-file],[data-cancel-file]');
  if (!el) return;
  const call = S.call;
  if (el.dataset.person) { S.selected = el.dataset.person; renderPeople(); renderLine(); return; }
  if (el.dataset.start) {
    const intent = el.dataset.start;
    if (intent === 'file') { S.fileMode = 'invite'; $('file-input').value = ''; $('file-input').click(); return; }
    return startCall(intent);
  }
  if (el.dataset.acceptFile) return call && call.acceptFile(el.dataset.acceptFile);
  if (el.dataset.declineFile) return call && call.declineFile(el.dataset.declineFile);
  if (el.dataset.cancelFile) return call && call.cancelFile(el.dataset.cancelFile);
  const run = async fn => { try { await fn(); } catch (err) { toast(err.message, 'error'); } };
  switch (el.dataset.action) {
    case 'about': return aboutModal();
    case 'rename': return renameModal();
    case 'signout': return signOut();
    case 'close-line': S.selected = null; renderPeople(); renderLine(); return;
    case 'safety': return safetyModal();
    case 'mic': return call && run(() => call.toggleMic());
    case 'cam': return call && run(() => call.toggleCam());
    case 'flip': return call && run(() => call.flipCam());
    case 'screen': return call && run(async () => {
      const r = await call.toggleScreen();
      if (r && !r.audio && screenAudioPossible()) toast('Sharing without sound. To include sound, stop and share again with "Share audio" ticked.');
    });
    case 'hangup': case 'hangup-back': return call && call.hangup();
    case 'toggle-files': $('view-call').classList.toggle('show-files'); renderTransfers(); return;
    case 'pick-files': S.fileMode = 'call'; $('file-input').value = ''; $('file-input').click(); return;
    case 'fullscreen': return toggleFullscreen();
    case 'rotate': S.view.rot = (S.view.rot + 90) % 360; applyView(); return;
    case 'fit': {
      const mobile = matchMedia('(max-width: 820px)').matches;
      const cur = S.view.fill === null ? (call && !(call.remoteState.screen && call.remote.screen) && mobile) : S.view.fill;
      S.view.fill = !cur; applyView(); return;
    }
    case 'done': return call && call.hangup();
    case 'copy-link':
      try { await navigator.clipboard.writeText(location.origin); toast('Link copied. Send it to the person you want to reach.'); }
      catch { toast(`Share this address: ${location.origin}`); }
      return;
  }
});

function toggleFullscreen() {
  const stage = $('stage'), v = $('v-main');
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    try { screen.orientation && screen.orientation.unlock && screen.orientation.unlock(); } catch { /* ignore */ }
    return (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  }
  const lock = () => {
    // Phones: turn a landscape screen share sideways automatically (Android; iOS ignores this).
    const landscape = v.videoWidth >= v.videoHeight;
    try { screen.orientation && screen.orientation.lock && screen.orientation.lock(landscape ? 'landscape' : 'portrait').catch(() => {}); } catch { /* ignore */ }
  };
  if (stage.requestFullscreen) return stage.requestFullscreen({ navigationUI: 'hide' }).then(lock).catch(() => v.webkitEnterFullscreen && v.webkitEnterFullscreen());
  if (stage.webkitRequestFullscreen) { stage.webkitRequestFullscreen(); return lock(); }
  if (v.webkitEnterFullscreen) return v.webkitEnterFullscreen();
}

function screenAudioPossible() {
  return /Chrome|Edg\//.test(navigator.userAgent) && !/Android|Mobile/.test(navigator.userAgent);
}

addEventListener('resize', () => { if (S.call && S.view.rot % 180) applyView(); });
document.addEventListener('fullscreenchange', () => { if (S.call) setTimeout(applyView, 50); });

$('stage').addEventListener('dblclick', () => { if (!$('v-main').hidden) toggleFullscreen(); });
document.addEventListener('pointerdown', () => { unlockAudio(); const a = $('remote-audio'); if (a.srcObject && a.paused) a.play().catch(() => {}); }, { passive: true });

$('file-input').addEventListener('change', e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const tooBig = files.filter(f => f.size > MAX_FILE);
  if (tooBig.length) toast(`${tooBig.map(f => f.name).join(', ')} ${tooBig.length === 1 ? 'is' : 'are'} over 1 GB and won't be sent.`, 'error');
  const ok = files.filter(f => f.size <= MAX_FILE).slice(0, 50);
  if (!ok.length) return;
  if (S.fileMode === 'invite') startCall('file', ok);
  else sendFiles(ok);
});

// drag and drop files onto the call
let dragDepth = 0;
const vc = $('view-call');
vc.addEventListener('dragenter', e => { if (S.call && e.dataTransfer.types.includes('Files')) { dragDepth++; $('drop-hint').hidden = false; } });
vc.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop-hint').hidden = true; } });
vc.addEventListener('dragover', e => { if (S.call) e.preventDefault(); });
vc.addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; $('drop-hint').hidden = true;
  const call = S.call;
  if (!call) return;
  if (call.state !== 'connected' && call.state !== 'reconnecting') return toast('Wait until the call connects, then drop the files again.');
  sendFiles([...e.dataTransfer.files].filter(f => f.size <= MAX_FILE));
});

window.addEventListener('pagehide', () => { if (S.call) S.call.hangup(); else if (S.incoming) S.incoming.decline(); });
matchMedia('(max-width: 820px)').addEventListener('change', () => { if (S.user && !$('view-home').hidden) renderLine(); });

boot();
