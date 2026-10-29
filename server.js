'use strict';
/*
 * Private Share — signalling server.
 *
 * Zero runtime dependencies (Node.js >= 20). This process:
 *   - serves the static web app from ./public
 *   - verifies Google ID tokens and issues short-lived session tokens
 *   - issues short-lived TURN credentials (coturn REST / shared-secret scheme)
 *   - relays WebRTC signalling (invites, signed SDP, ICE candidates) over WebSocket
 *
 * It never receives file bytes, audio or video. Media and files travel
 * browser-to-browser over WebRTC (DTLS-SRTP / DTLS-SCTP); file chunks are
 * additionally AES-256-GCM encrypted in the browser.
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// ---------------------------------------------------------------- config
const env = process.env;
const PORT = Number(env.PORT || 8080);
const HOST = env.HOST || '0.0.0.0';
const placeholder = v => !v || /REPLACE|replace-with/i.test(v);
const GOOGLE_CLIENT_ID = placeholder(env.GOOGLE_CLIENT_ID) ? '' : env.GOOGLE_CLIENT_ID.trim();
const DEV_LOGIN = String(env.DEV_LOGIN || '').toLowerCase() === 'true';
const APP_ORIGINS = String(env.APP_ORIGIN || '')
  .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
const TURN_HOST = placeholder(env.TURN_HOST) ? '' : env.TURN_HOST.trim();
const TURN_PORT = Number(env.TURN_PORT || 3478);
const TURN_TLS_PORT = Number(env.TURN_TLS_PORT || 0);
const TURN_SECRET = placeholder(env.TURN_SHARED_SECRET) ? '' : env.TURN_SHARED_SECRET.trim();
const TURN_TTL = 12 * 3600; // TURN credentials outlive a long call
const PUBLIC_DIR = path.join(__dirname, 'public');

let EXTRA_ICE = [];
try {
  const parsed = JSON.parse(env.ICE_SERVERS_JSON || '[]');
  if (Array.isArray(parsed)) EXTRA_ICE = parsed.filter(s => s && (typeof s.urls === 'string' || Array.isArray(s.urls)));
} catch { console.warn('[config] ICE_SERVERS_JSON is not valid JSON; ignoring it'); }

const SESSION_IDLE = 2 * 3600;      // seconds of inactivity before a login expires
const SESSION_MAX = 24 * 3600;      // absolute login lifetime
const INVITE_TTL = 90;              // seconds a call can ring
const CALL_IDLE = 12 * 3600;        // seconds an active call record is kept
const MAX_WS_MESSAGE = 64 * 1024;
const MAX_PAYLOAD = 48 * 1024;
const now = () => Math.floor(Date.now() / 1000);
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- sessions
const sessions = new Map(); // token -> {id, displayName, email, created, seen}

function createSession(id, displayName, email) {
  const token = crypto.randomBytes(32).toString('base64url');
  const t = now();
  sessions.set(token, { id, displayName, email, created: t, seen: t });
  return token;
}
function getSession(token, touch = true) {
  if (typeof token !== 'string' || token.length > 100) return null;
  const s = sessions.get(token);
  if (!s) return null;
  const t = now();
  if (t - s.seen > SESSION_IDLE || t - s.created > SESSION_MAX) { sessions.delete(token); return null; }
  if (touch) s.seen = t;
  return s;
}
setInterval(() => { for (const [k] of sessions) getSession(k, false); }, 60_000).unref();

function safeName(input, fallback = 'Guest') {
  if (typeof input !== 'string') return fallback;
  const c = input.replace(/[\p{Cc}\p{Cf}<>]/gu, '').trim().replace(/\s+/g, ' ');
  return c ? c.slice(0, 32) : fallback;
}

// ---------------------------------------------------------------- rate limiting
const buckets = new Map();
function allow(key, limit, windowMs = 60_000) {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || t - b.start >= windowMs) { b = { start: t, n: 0 }; buckets.set(key, b); }
  return ++b.n <= limit;
}
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (t - b.start > 120_000) buckets.delete(k); }, 60_000).unref();

const clientIp = req => String(req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '').trim();

// ---------------------------------------------------------------- Google ID tokens
let jwks = { keys: null, exp: 0 };
async function googleKeys(force) {
  if (!force && jwks.keys && Date.now() < jwks.exp) return jwks.keys;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!r.ok) throw new Error('Could not load Google signing keys');
  const m = /max-age=(\d+)/.exec(r.headers.get('cache-control') || '');
  const data = await r.json();
  jwks = { keys: data.keys || [], exp: Date.now() + (m ? Number(m[1]) : 3600) * 1000 };
  return jwks.keys;
}
async function verifyGoogleIdToken(jwt) {
  if (typeof jwt !== 'string' || jwt.length > 4096) throw new Error('bad token');
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('bad token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('bad alg');
  let keys = await googleKeys(false);
  let jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) { keys = await googleKeys(true); jwk = keys.find(k => k.kid === header.kid); }
  if (!jwk) throw new Error('unknown key');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('bad signature');
  const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  const t = now();
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(p.iss)) throw new Error('bad issuer');
  const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
  if (!aud.includes(GOOGLE_CLIENT_ID)) throw new Error('bad audience');
  if (typeof p.exp !== 'number' || p.exp < t - 30) throw new Error('expired');
  if (p.email_verified !== true && p.email_verified !== 'true') throw new Error('email not verified');
  if (typeof p.sub !== 'string' || !p.sub) throw new Error('no subject');
  return p;
}

// ---------------------------------------------------------------- HTTP helpers
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};

function securityHeaders(req) {
  const host = String(req.headers.host || '').replace(/[^A-Za-z0-9.:\-\[\]]/g, '');
  const csp = [
    "default-src 'self'",
    "script-src 'self' https://accounts.google.com/gsi/client",
    "style-src 'self' https://fonts.googleapis.com https://accounts.google.com/gsi/style",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://*.googleusercontent.com",
    "media-src 'self' blob:",
    `connect-src 'self' wss://${host} ws://${host} https://accounts.google.com/gsi/`,
    'frame-src https://accounts.google.com/gsi/',
    "worker-src 'self' blob:",
    "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; ');
  const h = {
    'Content-Security-Policy': csp,
    'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self), fullscreen=(self), screen-wake-lock=(self), geolocation=(), payment=(), usb=()',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Permitted-Cross-Domain-Policies': 'none',
  };
  if (String(req.headers['x-forwarded-proto'] || '').includes('https')) h['Strict-Transport-Security'] = 'max-age=31536000';
  return h;
}

function sendJson(req, res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { ...securityHeaders(req), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

function bearer(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel.includes('\0')) { res.writeHead(400); return res.end(); }
  if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // single-page app fallback
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { ...securityHeaders(req), 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = { ...securityHeaders(req), 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: etag };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------- HTTP routes
async function handleHttp(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  try {
    if (p === '/api/health') return sendJson(req, res, 200, { ok: true });

    if (p === '/api/config' && req.method === 'GET') {
      return sendJson(req, res, 200, { googleClientId: GOOGLE_CLIENT_ID, devLogin: DEV_LOGIN });
    }

    if (p.startsWith('/api/auth/')) {
      if (req.method !== 'POST') return sendJson(req, res, 405, { message: 'Method not allowed' });
      if (!allow('auth:' + clientIp(req), 30)) return sendJson(req, res, 429, { message: 'Too many sign-in attempts. Wait a minute and try again.' });
      const body = await readJson(req).catch(() => null);
      if (!body) return sendJson(req, res, 400, { message: 'Invalid request' });

      if (p === '/api/auth/google') {
        if (!GOOGLE_CLIENT_ID) return sendJson(req, res, 503, { message: 'Google sign-in is not configured on this server.' });
        let claims;
        try { claims = await verifyGoogleIdToken(body.credential); }
        catch (e) { log('[auth] google sign-in rejected:', e.message); return sendJson(req, res, 401, { message: 'Google sign-in failed. Try again.' }); }
        const name = safeName(claims.name || claims.given_name, 'Google user');
        const token = createSession('g' + claims.sub, name, claims.email || '');
        return sendJson(req, res, 200, { token, id: 'g' + claims.sub, displayName: name, email: claims.email || '' });
      }
      if (p === '/api/auth/dev') {
        if (!DEV_LOGIN) return sendJson(req, res, 404, { message: 'Not found' });
        const name = safeName(body.name, '');
        if (!name) return sendJson(req, res, 400, { message: 'Enter a name.' });
        const id = 'd' + crypto.randomBytes(8).toString('hex');
        const token = createSession(id, name, '');
        return sendJson(req, res, 200, { token, id, displayName: name, email: '' });
      }
      if (p === '/api/auth/session') {
        const s = getSession(bearer(req));
        if (!s) return sendJson(req, res, 401, { message: 'Session expired' });
        return sendJson(req, res, 200, { id: s.id, displayName: s.displayName, email: s.email });
      }
      if (p === '/api/auth/logout') {
        const t = bearer(req);
        if (t) { sessions.delete(t); hub.dropToken(t); }
        return sendJson(req, res, 200, { ok: true });
      }
      return sendJson(req, res, 404, { message: 'Not found' });
    }

    if (p === '/api/ice-config' && req.method === 'GET') {
      const s = getSession(bearer(req));
      if (!s) return sendJson(req, res, 401, { message: 'Sign in first' });
      const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }, ...EXTRA_ICE];
      let turn = false;
      if (TURN_HOST && TURN_SECRET.length >= 32) {
        const username = `${now() + TURN_TTL}:${s.id}`;
        const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
        const urls = [`turn:${TURN_HOST}:${TURN_PORT}?transport=udp`, `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`];
        if (TURN_TLS_PORT) urls.push(`turns:${TURN_HOST}:${TURN_TLS_PORT}?transport=tcp`);
        iceServers.push({ urls, username, credential });
        turn = true;
      }
      return sendJson(req, res, 200, { iceServers, turn });
    }

    if (p.startsWith('/api/')) return sendJson(req, res, 404, { message: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, p);
  } catch (e) {
    log('[http] error', e && e.message);
    if (!res.headersSent) sendJson(req, res, 500, { message: 'Server error' });
    else res.destroy();
  }
}

// ---------------------------------------------------------------- minimal RFC 6455 WebSocket
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WsConn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.closed = false;
    this.alive = true;
    socket.setNoDelay(true);
    socket.on('data', d => this.feed(d));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }
  finish() {
    if (this.done) return;
    this.done = true; this.closed = true;
    this.socket.destroy();
    this.emit('close');
  }
  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (!this.closed) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const op = b[0] & 0x0f;
      if (b[0] & 0x70) return this.close(1002, 'RSV bits set');
      if (!(b[1] & 0x80)) return this.close(1002, 'Client frames must be masked');
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        if (b.readUInt32BE(2) !== 0) return this.close(1009, 'Too big');
        len = b.readUInt32BE(6); off = 10;
      }
      if (len > MAX_WS_MESSAGE) return this.close(1009, 'Too big');
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      this.frame(fin, op, payload);
    }
  }
  frame(fin, op, payload) {
    if (op >= 8) {
      if (!fin || payload.length > 125) return this.close(1002, 'Bad control frame');
      if (op === 8) return this.close(1000, '');
      if (op === 9) return this.raw(0x8a, payload);
      if (op === 10) { this.alive = true; return; }
      return this.close(1002, 'Unknown opcode');
    }
    if (op === 0) {
      if (!this.frag) return this.close(1002, 'Unexpected continuation');
      this.frag.parts.push(payload); this.frag.size += payload.length;
    } else {
      if (this.frag) return this.close(1002, 'Expected continuation');
      this.frag = { op, parts: [payload], size: payload.length };
    }
    if (this.frag.size > MAX_WS_MESSAGE) return this.close(1009, 'Too big');
    if (!fin) return;
    const { op: mop, parts } = this.frag; this.frag = null;
    if (mop !== 1) return this.close(1003, 'Text only');
    this.alive = true;
    this.emit('message', Buffer.concat(parts).toString('utf8'));
  }
  raw(opByte, data) {
    if (this.closed && opByte !== 0x88) return;
    let hdr;
    if (data.length < 126) hdr = Buffer.from([opByte, data.length]);
    else if (data.length < 65536) { hdr = Buffer.alloc(4); hdr[0] = opByte; hdr[1] = 126; hdr.writeUInt16BE(data.length, 2); }
    else { hdr = Buffer.alloc(10); hdr[0] = opByte; hdr[1] = 127; hdr.writeUInt32BE(0, 2); hdr.writeUInt32BE(data.length, 6); }
    try { this.socket.write(Buffer.concat([hdr, data])); } catch { /* socket gone */ }
  }
  send(obj) { if (!this.closed) this.raw(0x81, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj))); }
  ping() { this.raw(0x89, Buffer.alloc(0)); }
  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    const r = Buffer.from(String(reason).slice(0, 100));
    const data = Buffer.alloc(2 + r.length); data.writeUInt16BE(code, 0); r.copy(data, 2);
    this.raw(0x88, data);
    try { this.socket.end(); } catch { /* ignore */ }
    setTimeout(() => this.finish(), 1500).unref();
  }
}

// ---------------------------------------------------------------- signalling hub
const SID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const INTENTS = new Set(['voice', 'video', 'screen', 'file']);

const hub = {
  users: new Map(),   // userId -> {conn, displayName}
  calls: new Map(),   // sid -> {sid, caller, callee, intent, state, updated}
  conns: new Set(),
  presenceTimer: null,

  attach(conn, req) {
    this.conns.add(conn);
    conn.ip = clientIp(req);
    conn.authTimer = setTimeout(() => { if (!conn.userId) conn.close(4401, 'Authenticate first'); }, 10_000);
    conn.on('message', raw => {
      try { this.onMessage(conn, raw); } catch (e) { log('[ws] handler error', e && e.message); }
    });
    conn.on('close', () => this.onClose(conn));
  },

  onMessage(conn, raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return conn.close(1007, 'Bad JSON'); }
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;

    if (!conn.userId) {
      if (m.type !== 'auth') return conn.close(4401, 'Authenticate first');
      const s = getSession(m.token);
      if (!s) return conn.close(4401, 'Invalid session');
      clearTimeout(conn.authTimer);
      const prev = this.users.get(s.id);
      if (prev && prev.conn !== conn) { prev.conn.replaced = true; prev.conn.close(4409, 'Signed in on another device'); }
      conn.userId = s.id; conn.token = m.token;
      const displayName = safeName(m.displayName, s.displayName);
      this.users.set(s.id, { conn, displayName });
      // Close any active call this client no longer knows about (e.g. after a page reload).
      const keep = typeof m.activeSid === 'string' ? m.activeSid : '';
      for (const c of [...this.calls.values()]) {
        if ((c.caller === s.id || c.callee === s.id) && c.sid !== keep) this.endCall(c, s.id, 'ended');
      }
      conn.send({ type: 'ready', userId: s.id, displayName });
      this.schedulePresence();
      return;
    }

    if (!getSession(conn.token)) return conn.close(4401, 'Session expired');
    if (!allow('ws:' + conn.userId, 900)) return conn.close(4429, 'Too many messages');
    const from = conn.userId;

    switch (m.type) {
      case 'ping': return conn.send({ type: 'pong' });
      case 'profile': {
        const u = this.users.get(from);
        if (u) { u.displayName = safeName(m.displayName, u.displayName); this.schedulePresence(); }
        return;
      }
      case 'presence': return conn.send(this.presencePayload());
    }

    const to = typeof m.to === 'string' ? m.to : '';
    const sid = typeof m.sid === 'string' ? m.sid : '';
    if (!to || !SID_RE.test(sid)) return;
    const payload = m.payload === undefined ? null : m.payload;
    if (payload !== null && JSON.stringify(payload).length > MAX_PAYLOAD) return conn.send({ type: 'error', sid, message: 'Signalling message too large' });
    const call = this.calls.get(sid);
    const t = now();

    switch (m.type) {
      case 'invite': {
        if (call || to === from || !payload || !INTENTS.has(payload.intent)) return;
        if (!allow('invite:' + from, 20)) return conn.send({ type: 'error', sid, message: 'Too many calls in a minute. Wait a moment and try again.' });
        const target = this.users.get(to);
        if (!target) return conn.send({ type: 'unavailable', sid, to });
        let mine = 0; for (const c of this.calls.values()) if (c.caller === from || c.callee === from) mine++;
        if (mine >= 4) return conn.send({ type: 'error', sid, message: 'Too many open calls' });
        this.calls.set(sid, { sid, caller: from, callee: to, intent: payload.intent, state: 'INVITED', updated: t });
        return this.forward(to, { type: 'invite', from, sid, payload, fromName: this.users.get(from)?.displayName || 'Guest' });
      }
      case 'accept':
      case 'reject': {
        if (!call || call.callee !== from || call.caller !== to || call.state !== 'INVITED') return;
        if (m.type === 'accept') { call.state = 'ACTIVE'; call.updated = t; }
        else this.calls.delete(sid);
        return this.forward(to, { type: m.type, from, sid, payload });
      }
      case 'sdp':
      case 'ice': {
        if (!call || call.state !== 'ACTIVE') return;
        const other = call.caller === from ? call.callee : call.callee === from ? call.caller : null;
        if (other !== to) return;
        call.updated = t;
        return this.forward(to, { type: m.type, from, sid, payload });
      }
      case 'hangup': {
        if (!call || (call.caller !== from && call.callee !== from)) return;
        return this.endCall(call, from, (payload && typeof payload.reason === 'string') ? payload.reason.slice(0, 20) : 'ended');
      }
    }
  },

  endCall(call, by, reason) {
    this.calls.delete(call.sid);
    const other = call.caller === by ? call.callee : call.caller;
    this.forward(other, { type: 'hangup', from: by, sid: call.sid, payload: { reason } });
  },

  forward(userId, msg) {
    const u = this.users.get(userId);
    if (u) u.conn.send(msg);
  },

  onClose(conn) {
    this.conns.delete(conn);
    clearTimeout(conn.authTimer);
    const id = conn.userId;
    if (!id) return;
    const u = this.users.get(id);
    if (!u || u.conn !== conn) return; // replaced by a newer connection
    this.users.delete(id);
    this.schedulePresence();
    for (const c of [...this.calls.values()]) {
      if (c.caller !== id && c.callee !== id) continue;
      if (c.state === 'INVITED') { this.endCall(c, id, 'offline'); continue; }
      // Active call: the WebRTC link may survive a short signalling drop, so wait before ending.
      setTimeout(() => {
        if (!this.users.has(id) && this.calls.get(c.sid) === c) this.endCall(c, id, 'offline');
      }, 30_000).unref();
    }
  },

  dropToken(token) {
    for (const conn of this.conns) if (conn.token === token) conn.close(4401, 'Signed out');
  },

  presencePayload() {
    const users = [];
    for (const [id, u] of this.users) users.push({ id, displayName: u.displayName });
    return { type: 'presence', users };
  },

  schedulePresence() {
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      const msg = JSON.stringify(this.presencePayload());
      for (const u of this.users.values()) u.conn.send(msg);
    }, 150);
  },
};

setInterval(() => {
  const t = now();
  for (const c of [...hub.calls.values()]) {
    if (c.state === 'INVITED' && t - c.updated > INVITE_TTL) { hub.endCall(c, c.caller, 'timeout'); hub.forward(c.caller, { type: 'hangup', from: c.callee, sid: c.sid, payload: { reason: 'timeout' } }); }
    else if (t - c.updated > CALL_IDLE) hub.calls.delete(c.sid);
  }
}, 15_000).unref();

setInterval(() => {
  for (const conn of hub.conns) {
    if (!conn.alive) { conn.finish(); continue; }
    conn.alive = false;
    conn.ping();
  }
}, 30_000).unref();

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  let o;
  try { o = new URL(origin); } catch { return false; }
  const clean = `${o.protocol}//${o.host}`;
  if (APP_ORIGINS.includes(clean)) return true;
  return o.host === req.headers.host; // same-origin page
}

// ---------------------------------------------------------------- server
const server = http.createServer((req, res) => { handleHttp(req, res); });
server.headersTimeout = 20_000;
server.requestTimeout = 30_000;

server.on('upgrade', (req, socket, head) => {
  const reject = (code, text) => { try { socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* ignore */ } socket.destroy(); };
  let pathname;
  try { pathname = new URL(req.url, 'http://local').pathname; } catch { return reject(400, 'Bad Request'); }
  if (pathname !== '/ws') return reject(404, 'Not Found');
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return reject(400, 'Bad Request');
  if (req.headers['sec-websocket-version'] !== '13') return reject(426, 'Upgrade Required');
  const key = req.headers['sec-websocket-key'];
  if (!key || !/^[A-Za-z0-9+/]{22}==$/.test(key)) return reject(400, 'Bad Request');
  if (!originAllowed(req)) { log('[ws] rejected origin', req.headers.origin); return reject(403, 'Forbidden'); }
  if (!allow('wsconnect:' + clientIp(req), 60)) return reject(429, 'Too Many Requests');
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const conn = new WsConn(socket);
  hub.attach(conn, req);
  if (head && head.length) conn.feed(head);
});

server.listen(PORT, HOST, () => {
  log(`[start] Private Share listening on http://${HOST}:${PORT}`);
  log(`[start] Google sign-in: ${GOOGLE_CLIENT_ID ? 'on' : 'off'} · test sign-in: ${DEV_LOGIN ? 'ON (do not use in production)' : 'off'} · TURN: ${TURN_HOST && TURN_SECRET.length >= 32 ? TURN_HOST : 'not configured'}`);
  if (APP_ORIGINS.length) log(`[start] Allowed origins: ${APP_ORIGINS.join(', ')}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log('[stop]', sig); server.close(); process.exit(0); });
