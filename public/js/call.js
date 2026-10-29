// One session between two people: a single RTCPeerConnection carrying
//   - calls: an audio transceiver (microphone), two video transceivers (camera, screen) and an
//     audio transceiver for the shared screen's sound
//   - file sessions: no media at all, only data channels
//   - always: a "ctl" data channel for control messages, plus one data channel per file transfer.
// Tracks are swapped with replaceTrack, so turning the camera or screen on and off never
// needs renegotiation. Renegotiation (e.g. ICE restart) uses the "perfect negotiation" pattern.
import * as C from './crypto.js';

export const MAX_FILE = 1024 * 1024 * 1024; // 1 GiB, received files are held in memory/Blob storage
const ROLES = ['audio', 'camera', 'screen', 'screenAudio'];
const TRACK_OF = { audio: 'mic', camera: 'cam', screen: 'screen', screenAudio: 'screenAudio' };
const MAX_TRANSFERS = 200;
const FILE_ID = /^[a-f0-9]{32}$/;
const cleanName = n => String(n).replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/^\.+/, '_').slice(0, 200) || 'file';

export function canShareScreen() {
  return !!(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function');
}

export function mediaError(e, what) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return what === 'screen' ? 'Screen sharing was cancelled or blocked.' : `Access to the ${what} is blocked. Allow it in your browser's site settings, then try again.`;
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return `No ${what} was found on this device.`;
  if (n === 'NotReadableError' || n === 'AbortError') return `The ${what} is being used by another app. Close that app and try again.`;
  if (!navigator.mediaDevices) return 'Calls need a secure connection. Open this site with https://.';
  return `Could not start the ${what}${e && e.message ? `: ${e.message}` : '.'}`;
}

export class Call extends EventTarget {
  constructor({ sid, me, peer, role, intent, signal, iceServers }) {
    super();
    Object.assign(this, { sid, me, peer, role, intent, signal, iceServers });
    this.polite = role === 'callee';
    this.state = role === 'caller' ? 'calling' : 'incoming';
    this.local = { mic: null, cam: null, screen: null, screenAudio: null };
    this.micMuted = false;
    this.facing = 'user';
    this.canFlip = false;
    this.remote = { audio: null, camera: null, screen: null, screenAudio: null };
    this.remoteState = { mic: false, cam: false, screen: false, screenAudio: false };
    this.isFile = intent === 'file';
    this.phase = role === 'caller' ? 'ringing' : 'incoming'; // permission → keys → route → connected
    this.diag = { local: new Set(), remote: 0 };
    this.tx = {};
    this.mids = null;
    this.transfers = new Map();
    this.pendingOffers = [];
    this.autoAccept = new Map();
    this.timers = {};
    this.queue = Promise.resolve();
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.route = '';
    this.connectedAt = 0;
    this.peerIdentity = null;
    this.material = null;
    this.safety = '';
    this.keyStatus = '';
  }

  emit(type, detail = {}) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  setState(s) { if (this.state !== 'ended') { this.state = s; this.emit('state'); } }
  enqueue(fn) {
    this.queue = this.queue.then(fn).catch(e => {
      console.error(e);
      this.emit('notice', { message: e.message || String(e), level: 'error' });
    });
    return this.queue;
  }

  // ---------------------------------------------------------------- local media
  async getMic() {
    const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    return s.getAudioTracks()[0];
  }
  async getCam(facing) {
    const s = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
    const t = s.getVideoTracks()[0];
    try { t.contentHint = 'motion'; } catch { /* optional */ }
    this.refreshFlip();
    return t;
  }
  // Screen plus its sound where the browser allows it (Chrome/Edge: tab audio everywhere,
  // whole-system audio on Windows and ChromeOS). The person ticks "Share audio" in the picker.
  async getScreen() {
    const video = { frameRate: { ideal: 15, max: 30 } };
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false };
    let s;
    try {
      s = await navigator.mediaDevices.getDisplayMedia({ video, audio, systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include' });
    } catch (e) {
      if (e && e.name === 'TypeError') s = await navigator.mediaDevices.getDisplayMedia({ video });
      else throw e;
    }
    const t = s.getVideoTracks()[0];
    const a = s.getAudioTracks()[0] || null;
    try { t.contentHint = 'detail'; } catch { /* optional */ }
    t.addEventListener('ended', () => { if (this.local.screen === t) this.stopScreen(); });
    return { video: t, audio: a };
  }
  setScreen(sc) {
    this.local.screen = sc ? sc.video : null;
    this.local.screenAudio = sc ? sc.audio : null;
  }
  async refreshFlip() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.canFlip = devices.filter(d => d.kind === 'videoinput').length > 1;
      this.emit('local');
    } catch { /* ignore */ }
  }

  // Acquire the media the chosen action needs. Returns warnings; throws if the action can't start.
  async prepareLocal() {
    const warnings = [];
    const need = {
      voice: { mic: true }, video: { mic: true, cam: true }, screen: { screen: this.role === 'caller', mic: true }, file: {},
    }[this.intent];
    if ((need.mic || need.cam || need.screen) && !navigator.mediaDevices) throw new Error(mediaError(null, 'microphone'));
    if (need.screen) {
      this.phase = 'permission'; this.emit('state');
      try { this.setScreen(await this.getScreen()); } catch (e) { throw new Error(mediaError(e, 'screen')); }
    }
    if (need.mic || need.cam) { this.phase = 'permission'; this.emit('state'); }
    if (need.mic) {
      try { this.local.mic = await this.getMic(); } catch (e) {
        if (this.role === 'caller' && this.intent === 'voice') throw new Error(mediaError(e, 'microphone'));
        warnings.push(mediaError(e, 'microphone'));
      }
    }
    if (need.cam) {
      try { this.local.cam = await this.getCam(this.facing); } catch (e) { warnings.push(mediaError(e, 'camera')); }
    }
    this.emit('local');
    return warnings;
  }

  async applyTrack(role) {
    const t = this.tx[role];
    if (!t) return;
    try { await t.sender.replaceTrack(this.local[TRACK_OF[role]] || null); } catch (e) { console.warn('replaceTrack', e); }
  }
  sendMediaState() {
    if (this.isFile) return;
    this.sendCtl({ k: 'media', mic: !!this.local.mic && !this.micMuted, cam: !!this.local.cam, screen: !!this.local.screen, screenAudio: !!this.local.screenAudio });
  }

  async toggleMic() {
    if (!this.local.mic) {
      try { this.local.mic = await this.getMic(); } catch (e) { throw new Error(mediaError(e, 'microphone')); }
      this.micMuted = false;
      await this.applyTrack('audio');
    } else {
      this.micMuted = !this.micMuted;
      this.local.mic.enabled = !this.micMuted;
    }
    this.sendMediaState(); this.emit('local');
  }
  async toggleCam() {
    if (this.local.cam) {
      this.local.cam.stop(); this.local.cam = null;
    } else {
      try { this.local.cam = await this.getCam(this.facing); } catch (e) { throw new Error(mediaError(e, 'camera')); }
    }
    await this.applyTrack('camera');
    this.sendMediaState(); this.emit('local');
  }
  async flipCam() {
    if (!this.local.cam) return;
    const next = this.facing === 'user' ? 'environment' : 'user';
    this.local.cam.stop(); // many phones cannot open two cameras at once
    try { this.local.cam = await this.getCam(next); this.facing = next; }
    catch (e) {
      this.local.cam = await this.getCam(this.facing).catch(() => null);
      await this.applyTrack('camera'); this.sendMediaState(); this.emit('local');
      throw new Error(mediaError(e, 'camera'));
    }
    await this.applyTrack('camera');
    this.sendMediaState(); this.emit('local');
  }
  async toggleScreen() {
    if (this.local.screen) return this.stopScreen();
    if (!canShareScreen()) throw new Error("This browser can't share its screen. Phones can view a shared screen but most mobile browsers can't share one.");
    try { this.setScreen(await this.getScreen()); } catch (e) { throw new Error(mediaError(e, 'screen')); }
    await this.applyTrack('screen'); await this.applyTrack('screenAudio');
    this.sendMediaState(); this.emit('local');
    return { audio: !!this.local.screenAudio };
  }
  async stopScreen() {
    if (this.local.screen) this.local.screen.stop();
    if (this.local.screenAudio) this.local.screenAudio.stop();
    this.setScreen(null);
    await this.applyTrack('screen'); await this.applyTrack('screenAudio');
    this.sendMediaState(); this.emit('local');
  }

  // ---------------------------------------------------------------- call setup
  async invite(files = []) {
    for (const f of files) this.addOutgoing(f);
    const list = [...this.transfers.values()].map(t => ({ id: t.id, name: t.name, size: t.size }));
    const { bundle, ecdhPrivate } = await C.makeBundle({ sid: this.sid, from: this.me.id, to: this.peer.id, role: 'caller', intent: this.intent, files: list });
    this.ecdhPrivate = ecdhPrivate;
    this.signal.send({ type: 'invite', to: this.peer.id, sid: this.sid, payload: { intent: this.intent, bundle } });
    this.timers.ring = setTimeout(() => { if (this.state === 'calling') { this.signal.send({ type: 'hangup', to: this.peer.id, sid: this.sid, payload: { reason: 'timeout' } }); this.end('no-answer'); } }, 45000);
  }

  // Callee: check the caller's signed bundle. Returns the key status so the UI can warn.
  async receiveInvite(bundle) {
    const b = await C.openBundle(bundle, { sid: this.sid, from: this.peer.id, to: this.me.id, role: 'caller' });
    if (b.intent !== this.intent) throw new Error('Call type does not match its signature.');
    this.peerBundle = b;
    this.peerIdentity = b.identity;
    for (const f of b.files) this.autoAccept.set(f.id, f);
    const k = await C.checkPeerKey(this.peer.id, b.identity);
    this.keyStatus = k.status; this.verified = k.verified;
    this.safety = await C.safetyCode((await C.identity()).publicKey, b.identity);
    return k;
  }

  async answer() {
    clearTimeout(this.timers.ring);
    if (this.keyStatus === 'changed') { await C.trustPeerKey(this.peer.id, this.peerIdentity); this.keyStatus = 'known'; }
    this.setState('connecting');
    const warnings = await this.prepareLocal();
    this.phase = 'keys'; this.emit('state');
    const { bundle, ecdhPrivate } = await C.makeBundle({ sid: this.sid, from: this.me.id, to: this.peer.id, role: 'callee', intent: this.intent });
    this.material = await C.sessionMaterial(ecdhPrivate, this.peerBundle.ecdh);
    this.createPeer();
    this.signal.send({ type: 'accept', to: this.peer.id, sid: this.sid, payload: { bundle } });
    return warnings;
  }

  decline(reason = 'declined') {
    this.signal.send({ type: 'reject', to: this.peer.id, sid: this.sid, payload: { reason } });
    this.end('declined-local');
  }

  // Caller: the callee accepted.
  async onAccept(payload, confirmKeyChange) {
    if (this.role !== 'caller' || this.state !== 'calling') return;
    clearTimeout(this.timers.ring);
    this.phase = 'keys';
    this.setState('connecting');
    const b = await C.openBundle(payload && payload.bundle, { sid: this.sid, from: this.peer.id, to: this.me.id, role: 'callee' });
    this.peerIdentity = b.identity;
    const k = await C.checkPeerKey(this.peer.id, b.identity);
    this.keyStatus = k.status; this.verified = k.verified;
    this.safety = await C.safetyCode((await C.identity()).publicKey, b.identity);
    if (k.status === 'changed') {
      const ok = await confirmKeyChange(this);
      if (!ok) { this.hangup('key-rejected'); return; }
      await C.trustPeerKey(this.peer.id, b.identity);
      this.keyStatus = 'known';
    }
    this.material = await C.sessionMaterial(this.ecdhPrivate, b.ecdh);
    this.createPeer();
    this.emit('state');
  }

  createPeer() {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    this.pc = pc;
    this.phase = 'route';
    pc.onicecandidate = e => {
      if (!e.candidate) {
        // Gathering finished: tell the other side which kinds of route this device found.
        this.signal.send({ type: 'ice', to: this.peer.id, sid: this.sid, payload: { done: true, types: [...this.diag.local] } });
        return;
      }
      const m = / typ (host|srflx|prflx|relay)/.exec(e.candidate.candidate || '');
      if (m) this.diag.local.add(m[1]);
      this.signal.send({ type: 'ice', to: this.peer.id, sid: this.sid, payload: e.candidate.toJSON() });
    };
    pc.ontrack = e => this.onTrack(e);
    pc.ondatachannel = e => this.onDataChannel(e.channel);
    pc.onconnectionstatechange = () => this.onConnState();
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        if (this.role === 'caller' && this.tx.audio) this.mids = Object.fromEntries(ROLES.map(r => [r, this.tx[r].mid]));
        await this.sendSdp(pc.localDescription);
      } catch (e) { console.warn('negotiation', e); }
      finally { this.makingOffer = false; }
    };
    if (this.role === 'caller') {
      this.setupCtl(pc.createDataChannel('ctl', { ordered: true }));
      if (!this.isFile) {
        this.tx.audio = pc.addTransceiver(this.local.mic || 'audio', { direction: 'sendrecv' });
        this.tx.camera = pc.addTransceiver(this.local.cam || 'video', { direction: 'sendrecv' });
        this.tx.screen = pc.addTransceiver(this.local.screen || 'video', { direction: 'sendrecv' });
        this.tx.screenAudio = pc.addTransceiver(this.local.screenAudio || 'audio', { direction: 'sendrecv' });
      }
    }
    this.emit('state');
    this.timers.connect = setTimeout(() => {
      if (!this.connectedAt) this.end('failed');
    }, 45000);
  }

  async sendSdp(desc) {
    const mids = this.role === 'caller' ? this.mids : null;
    const sig = await C.signSdp({ sid: this.sid, from: this.me.id, to: this.peer.id, type: desc.type, sdp: desc.sdp, mids });
    this.signal.send({ type: 'sdp', to: this.peer.id, sid: this.sid, payload: { type: desc.type, sdp: desc.sdp, mids, sig } });
  }

  async onSdp(p) {
    const pc = this.pc;
    if (!pc || this.state === 'ended' || !p || !['offer', 'answer'].includes(p.type) || typeof p.sdp !== 'string') return;
    const ok = await C.verifySdp(this.peerIdentity, { sid: this.sid, from: this.peer.id, to: this.me.id, type: p.type, sdp: p.sdp, mids: p.mids }, p.sig);
    if (!ok) { this.emit('notice', { message: 'A connection message failed its signature check, so the call was ended.', level: 'error' }); this.hangup('security'); return; }
    if (this.role === 'callee' && !this.isFile && p.mids && !this.mids) {
      if (!ROLES.every(r => typeof p.mids[r] === 'string')) throw new Error('The other person is using an older version of the app. Ask them to reload the page.');
      this.mids = p.mids;
    }
    const collision = p.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
    this.ignoreOffer = !this.polite && collision;
    if (this.ignoreOffer) return;
    await pc.setRemoteDescription({ type: p.type, sdp: p.sdp });
    if (p.type === 'offer') {
      if (this.role === 'callee' && !this.isFile && !this.tx.audio) await this.bindTransceivers();
      await pc.setLocalDescription();
      await this.sendSdp(pc.localDescription);
    }
  }

  async bindTransceivers() {
    for (const r of ROLES) {
      const t = this.pc.getTransceivers().find(x => x.mid === this.mids[r]);
      if (!t) throw new Error('Call description is missing a media line.');
      t.direction = 'sendrecv';
      this.tx[r] = t;
    }
    for (const r of ROLES) await this.applyTrack(r);
  }

  async onIce(c) {
    if (!this.pc || this.state === 'ended' || !c) return;
    if (c.done === true) {
      this.diag.remoteDone = true;
      this.diag.remoteTypes = Array.isArray(c.types) ? c.types.filter(t => ['host', 'srflx', 'prflx', 'relay'].includes(t)) : [];
      return;
    }
    this.diag.remote++;
    try { await this.pc.addIceCandidate(c); } catch (e) { if (!this.ignoreOffer) console.warn('addIceCandidate', e); }
  }

  roleForMid(mid) {
    for (const r of ROLES) if ((this.tx[r] && this.tx[r].mid === mid) || (this.mids && this.mids[r] === mid)) return r;
    return null;
  }

  onTrack(e) {
    const r = this.roleForMid(e.transceiver && e.transceiver.mid);
    if (!r) return;
    this.remote[r] = new MediaStream([e.track]);
    e.track.addEventListener('unmute', () => this.emit('remote'));
    e.track.addEventListener('mute', () => this.emit('remote'));
    this.emit('remote');
  }

  onConnState() {
    const pc = this.pc;
    if (!pc || this.state === 'ended') return;
    const s = pc.connectionState;
    if (s === 'connected') {
      clearTimeout(this.timers.disc); clearTimeout(this.timers.fail); clearTimeout(this.timers.connect);
      this.timers.fail = null;
      if (!this.connectedAt) this.connectedAt = Date.now();
      this.phase = 'connected';
      this.setState('connected');
      this.updateRoute();
      clearInterval(this.timers.route);
      this.timers.route = setInterval(() => this.updateRoute(), 5000);
      this.keepAwake();
    } else if (s === 'disconnected') {
      if (this.connectedAt) this.setState('reconnecting');
      clearTimeout(this.timers.disc);
      this.timers.disc = setTimeout(() => { if (this.pc && this.pc.connectionState !== 'connected' && this.role === 'caller') this.pc.restartIce(); }, 4000);
    } else if (s === 'failed') {
      if (this.connectedAt) this.setState('reconnecting');
      if (this.role === 'caller') { try { pc.restartIce(); } catch { /* ignore */ } }
      if (!this.timers.fail) this.timers.fail = setTimeout(() => { if (this.pc && this.pc.connectionState !== 'connected') this.end('failed'); }, 20000);
    }
  }

  async updateRoute() {
    if (!this.pc) return;
    try {
      const stats = await this.pc.getStats();
      let pair = null;
      stats.forEach(s => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId); });
      if (!pair) stats.forEach(s => { if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) pair = s; });
      if (!pair) return;
      const l = stats.get(pair.localCandidateId), r = stats.get(pair.remoteCandidateId);
      const route = (l && l.candidateType === 'relay') || (r && r.candidateType === 'relay') ? 'Relayed' : 'Direct';
      if (route !== this.route) { this.route = route; this.emit('state'); }
    } catch { /* ignore */ }
  }

  async keepAwake() {
    try { if ('wakeLock' in navigator && !this.wakeLock) this.wakeLock = await navigator.wakeLock.request('screen'); } catch { /* optional */ }
  }

  // ---------------------------------------------------------------- control channel
  setupCtl(ch) {
    this.ctl = ch;
    ch.onopen = () => {
      this.sendMediaState();
      const q = this.pendingOffers; this.pendingOffers = [];
      for (const t of q) this.sendOffer(t);
      this.emit('state');
    };
    ch.onmessage = e => this.onCtl(e.data);
  }
  sendCtl(obj) {
    if (this.ctl && this.ctl.readyState === 'open') { try { this.ctl.send(JSON.stringify(obj)); return true; } catch { /* closing */ } }
    return false;
  }
  get ctlOpen() { return !!this.ctl && this.ctl.readyState === 'open'; }

  onDataChannel(ch) {
    if (ch.label === 'ctl') return this.setupCtl(ch);
    const m = /^file:([a-f0-9]{32})$/.exec(ch.label);
    const t = m && this.transfers.get(m[1]);
    if (!t || t.dir !== 'in' || t.status !== 'accepted') { ch.close(); return; }
    this.setupIncoming(t, ch);
  }

  onCtl(data) {
    if (typeof data !== 'string' || data.length > 4096) return;
    let m; try { m = JSON.parse(data); } catch { return; }
    const t = m && typeof m.id === 'string' ? this.transfers.get(m.id) : null;
    switch (m && m.k) {
      case 'media':
        this.remoteState = { mic: !!m.mic, cam: !!m.cam, screen: !!m.screen, screenAudio: !!m.screenAudio };
        this.emit('remote');
        break;
      case 'file-offer': {
        if (!FILE_ID.test(m.id) || this.transfers.has(m.id) || !Number.isSafeInteger(m.size) || m.size < 0 || typeof m.name !== 'string') return;
        if (this.transfers.size >= MAX_TRANSFERS) { this.sendCtl({ k: 'file-decline', id: m.id }); return; }
        if (m.size > MAX_FILE) { this.sendCtl({ k: 'file-decline', id: m.id }); return; }
        const tr = { id: m.id, dir: 'in', name: cleanName(m.name), size: m.size, mime: typeof m.mime === 'string' ? m.mime.slice(0, 100) : '', status: 'offered', done: 0 };
        this.transfers.set(tr.id, tr);
        const pre = this.autoAccept.get(tr.id);
        if (pre && pre.size === tr.size && pre.name === m.name) this.acceptFile(tr.id);
        else this.emit('transfers');
        break;
      }
      case 'file-accept':
        if (t && t.dir === 'out' && t.status === 'offered') this.startSending(t);
        break;
      case 'file-decline':
        if (t && t.dir === 'out' && t.status === 'offered') { t.status = 'declined'; this.emit('transfers'); }
        break;
      case 'file-cancel':
        if (t && !['done', 'failed', 'declined', 'cancelled'].includes(t.status)) this.finishTransfer(t, 'cancelled', 'Cancelled by the other person.');
        break;
      case 'file-done':
        if (t && t.dir === 'out' && t.status === 'verifying') this.finishTransfer(t, 'done');
        break;
      case 'bye':
        this.end('peer-hangup');
        break;
    }
  }

  // ---------------------------------------------------------------- files: sending
  addOutgoing(file) {
    if (file.size > MAX_FILE) throw new Error(`${file.name} is larger than 1 GB. Send a smaller file.`);
    if (this.transfers.size >= MAX_TRANSFERS) throw new Error('Too many files in one session. Start a new one.');
    const t = { id: C.randomHex(16), dir: 'out', file, name: cleanName(file.name), size: file.size, mime: file.type || 'application/octet-stream', status: 'offered', done: 0 };
    this.transfers.set(t.id, t);
    if (this.ctlOpen) this.sendOffer(t); else this.pendingOffers.push(t);
    this.emit('transfers');
    return t;
  }
  sendOffer(t) { this.sendCtl({ k: 'file-offer', id: t.id, name: t.name, size: t.size, mime: t.mime }); }

  chunkSize() {
    const max = this.pc && this.pc.sctp && Number.isFinite(this.pc.sctp.maxMessageSize) && this.pc.sctp.maxMessageSize > 0 ? this.pc.sctp.maxMessageSize : 65536;
    return Math.max(16 * 1024, Math.floor(Math.min(65536, max) / 1024) * 1024 - 1024);
  }

  startSending(t) {
    t.status = 'sending'; t.startedAt = Date.now();
    const ch = this.pc.createDataChannel(`file:${t.id}`, { ordered: true });
    ch.binaryType = 'arraybuffer';
    ch.bufferedAmountLowThreshold = 1 << 20;
    t.ch = ch;
    ch.onopen = () => this.pump(t).catch(e => this.finishTransfer(t, 'failed', e.message));
    ch.onclose = () => { if (['sending', 'verifying'].includes(t.status)) this.finishTransfer(t, 'failed', 'Connection closed before the file finished.'); };
    this.emit('transfers');
  }

  waitLow(ch) {
    return new Promise(resolve => {
      const done = () => { ch.removeEventListener('bufferedamountlow', done); ch.removeEventListener('close', done); clearTimeout(timer); resolve(); };
      const timer = setTimeout(done, 1000);
      ch.addEventListener('bufferedamountlow', done);
      ch.addEventListener('close', done);
    });
  }

  async pump(t) {
    const ch = t.ch;
    const key = await C.fileKey(this.material, { sid: this.sid, fileId: t.id, senderId: this.me.id });
    const prefix = crypto.getRandomValues(new Uint8Array(8));
    const chunkSize = this.chunkSize();
    const total = Math.ceil(t.size / chunkSize);
    ch.send(JSON.stringify({ k: 'head', id: t.id, prefix: C.b64(prefix), chunkSize, total, size: t.size }));
    const digests = new Uint8Array(total * 32);
    let lastEmit = 0;
    for (let i = 0; i < total; i++) {
      if (t.status !== 'sending') return;
      if (ch.readyState !== 'open') throw new Error('Connection closed before the file finished.');
      while (ch.bufferedAmount > 4 * 1024 * 1024 && ch.readyState === 'open' && t.status === 'sending') await this.waitLow(ch);
      if (t.status !== 'sending') return;
      const plain = await t.file.slice(i * chunkSize, Math.min(t.size, (i + 1) * chunkSize)).arrayBuffer();
      digests.set(await C.sha256(plain), i * 32);
      const ct = await C.encryptChunk(key, C.nonce(prefix, i), C.chunkAad(this.sid, t.id, i, total), plain);
      const packet = new Uint8Array(4 + ct.byteLength);
      new DataView(packet.buffer).setUint32(0, i);
      packet.set(new Uint8Array(ct), 4);
      if (ch.readyState !== 'open') throw new Error('Connection closed before the file finished.');
      ch.send(packet);
      t.done = Math.min(t.size, (i + 1) * chunkSize);
      if (Date.now() - lastEmit > 150) { lastEmit = Date.now(); this.emit('transfers'); }
    }
    const manifest = { v: 2, sid: this.sid, id: t.id, from: this.me.id, to: this.peer.id, name: t.name, size: t.size, mime: t.mime, total, chunkSize, digest: C.b64(await C.sha256(digests)) };
    const sig = await C.signManifest(manifest);
    ch.send(JSON.stringify({ k: 'end', manifest, sig }));
    t.status = 'verifying';
    this.emit('transfers');
  }

  // ---------------------------------------------------------------- files: receiving
  acceptFile(id) {
    const t = this.transfers.get(id);
    if (!t || t.dir !== 'in' || t.status !== 'offered') return;
    t.status = 'accepted';
    this.sendCtl({ k: 'file-accept', id });
    this.emit('transfers');
  }
  declineFile(id) {
    const t = this.transfers.get(id);
    if (!t || t.status !== 'offered') return;
    if (t.dir === 'in') { t.status = 'declined'; this.sendCtl({ k: 'file-decline', id }); }
    else { t.status = 'cancelled'; this.sendCtl({ k: 'file-cancel', id }); }
    this.emit('transfers');
  }
  cancelFile(id) {
    const t = this.transfers.get(id);
    if (!t || ['done', 'failed', 'declined', 'cancelled'].includes(t.status)) return;
    this.sendCtl({ k: 'file-cancel', id });
    this.finishTransfer(t, 'cancelled', 'Cancelled.');
  }

  setupIncoming(t, ch) {
    ch.binaryType = 'arraybuffer';
    t.ch = ch; t.startedAt = Date.now();
    t.keyP = C.fileKey(this.material, { sid: this.sid, fileId: t.id, senderId: this.peer.id });
    t.parts = []; t.blobs = []; t.next = 0; t.head = null; t.q = Promise.resolve(); t.lastEmit = 0;
    ch.onmessage = e => { t.q = t.q.then(() => this.onFileMessage(t, e.data)).catch(err => this.failIncoming(t, err)); };
    ch.onclose = () => { if (['accepted', 'receiving'].includes(t.status)) t.q = t.q.then(() => { if (['accepted', 'receiving'].includes(t.status)) this.finishTransfer(t, 'failed', 'Connection closed before the file finished.'); }); };
  }

  async onFileMessage(t, data) {
    if (!['accepted', 'receiving'].includes(t.status)) return;
    if (typeof data === 'string') {
      const m = JSON.parse(data);
      if (m.k === 'head') {
        if (t.head || m.id !== t.id || m.size !== t.size || !Number.isSafeInteger(m.chunkSize) || m.chunkSize < 1024 || m.chunkSize > 262144 || m.total !== Math.ceil(t.size / m.chunkSize)) throw new Error('File header does not match the offer.');
        const prefix = C.unb64(m.prefix);
        if (prefix.length !== 8) throw new Error('Invalid file header.');
        t.head = { prefix, chunkSize: m.chunkSize, total: m.total };
        t.digests = new Uint8Array(m.total * 32);
        t.status = 'receiving';
        this.emit('transfers');
        return;
      }
      if (m.k === 'end') {
        const mf = m.manifest || {};
        if (!t.head || t.next !== t.head.total) throw new Error('File ended early.');
        const expect = { v: 2, sid: this.sid, id: t.id, from: this.peer.id, to: this.me.id, size: t.size, total: t.head.total, chunkSize: t.head.chunkSize };
        for (const k of Object.keys(expect)) if (mf[k] !== expect[k]) throw new Error('Signed file manifest does not match this transfer.');
        if (cleanName(mf.name) !== t.name) throw new Error('Signed file name does not match.');
        if (!(await C.verifyManifest(this.peerIdentity, mf, m.sig))) throw new Error('Sender signature on the file is invalid.');
        if (C.b64(await C.sha256(t.digests)) !== mf.digest) throw new Error('File fingerprint check failed. The file was discarded.');
        if (t.parts.length) { t.blobs.push(new Blob(t.parts)); t.parts = []; }
        const blob = new Blob(t.blobs, { type: typeof mf.mime === 'string' ? mf.mime : '' });
        t.blobs = [];
        if (blob.size !== t.size) throw new Error('File size check failed.');
        t.blob = blob;
        t.url = URL.createObjectURL(blob);
        t.done = t.size;
        this.sendCtl({ k: 'file-done', id: t.id });
        this.finishTransfer(t, 'done');
      }
      return;
    }
    if (!t.head) throw new Error('File data arrived before its header.');
    const packet = new Uint8Array(data);
    if (packet.length < 20) throw new Error('Damaged file chunk.');
    const i = new DataView(packet.buffer, packet.byteOffset, 4).getUint32(0);
    if (i !== t.next || i >= t.head.total) throw new Error('File chunk out of order.');
    const plain = await C.decryptChunk(await t.keyP, C.nonce(t.head.prefix, i), C.chunkAad(this.sid, t.id, i, t.head.total), packet.subarray(4));
    const expected = i < t.head.total - 1 ? t.head.chunkSize : t.size - t.head.chunkSize * (t.head.total - 1);
    if (plain.byteLength !== expected) throw new Error('File chunk has the wrong size.');
    t.digests.set(await C.sha256(plain), i * 32);
    t.parts.push(plain);
    if (t.parts.length >= 64) { t.blobs.push(new Blob(t.parts)); t.parts = []; }
    t.next++;
    t.done += plain.byteLength;
    if (Date.now() - t.lastEmit > 150) { t.lastEmit = Date.now(); this.emit('transfers'); }
  }

  failIncoming(t, err) {
    if (!['accepted', 'receiving'].includes(t.status)) return;
    const msg = err && err.name === 'OperationError' ? 'A file chunk failed decryption, so the file was discarded.' : (err && err.message) || 'Transfer failed.';
    this.sendCtl({ k: 'file-cancel', id: t.id });
    this.finishTransfer(t, 'failed', msg);
  }

  finishTransfer(t, status, error) {
    t.status = status;
    if (error) t.error = error;
    t.parts = null; t.blobs = null; t.digests = status === 'done' ? null : t.digests && null;
    if (t.ch) { try { t.ch.close(); } catch { /* ignore */ } t.ch = null; }
    t.finishedAt = Date.now();
    this.emit('transfers');
  }

  // Why a connection never opened, in terms a person can act on.
  diagnose() {
    const turnConfigured = (this.iceServers || []).some(s => [].concat(s.urls).some(u => /^turns?:/.test(u)));
    if (!this.pc) return 'keys';
    if (this.connectedAt) return 'dropped';
    if (this.diag.local.size === 0) return turnConfigured ? 'relay-only' : 'blocked';
    if (this.diag.remote === 0 && !this.diag.remoteDone) return 'no-remote';
    if (turnConfigured && !this.diag.local.has('relay')) return 'no-relay';
    if (turnConfigured && this.diag.remoteDone && !(this.diag.remoteTypes || []).includes('relay')) return 'peer-no-relay';
    if (!turnConfigured) return 'no-turn';
    return 'no-route';
  }

  // ---------------------------------------------------------------- ending
  hangup(reason = 'ended') {
    this.sendCtl({ k: 'bye' });
    this.signal.send({ type: 'hangup', to: this.peer.id, sid: this.sid, payload: { reason } });
    this.end('local');
  }

  end(reason) {
    if (this.state === 'ended') return;
    this.state = 'ended';
    this.endReason = reason;
    for (const k of Object.keys(this.timers)) { clearTimeout(this.timers[k]); clearInterval(this.timers[k]); }
    for (const k of ['mic', 'cam', 'screen', 'screenAudio']) { if (this.local[k]) this.local[k].stop(); this.local[k] = null; }
    if (reason === 'failed') this.failure = this.diagnose();
    for (const t of this.transfers.values()) {
      if (!['done', 'failed', 'declined', 'cancelled'].includes(t.status)) { t.status = 'cancelled'; t.error = 'The call ended.'; t.parts = null; t.blobs = null; }
    }
    try { this.pc && this.pc.close(); } catch { /* ignore */ }
    try { this.wakeLock && this.wakeLock.release(); } catch { /* ignore */ }
    this.emit('transfers');
    this.emit('ended', { reason });
  }
}
