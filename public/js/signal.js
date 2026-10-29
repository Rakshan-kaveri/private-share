// WebSocket signalling client with automatic reconnect and a short send queue.
export class Signal extends EventTarget {
  constructor({ token, getDisplayName, getActiveSid }) {
    super();
    this.token = token;
    this.getDisplayName = getDisplayName;
    this.getActiveSid = getActiveSid;
    this.ws = null;
    this.ready = false;
    this.stopped = false;
    this.attempt = 0;
    this.queue = [];
    this.pingTimer = null;
  }

  connect() {
    if (this.stopped) return;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token: this.token, displayName: this.getDisplayName(), activeSid: this.getActiveSid() || '' }));
    };
    ws.onmessage = ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'ready') {
        this.ready = true; this.attempt = 0;
        const q = this.queue; this.queue = [];
        for (const item of q) if (Date.now() - item.at < 15000) ws.send(item.data);
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.send({ type: 'ping' }), 25000);
        this.emit('status', { online: true });
      }
      if (m.type === 'pong') return;
      this.emit(m.type, m);
    };
    ws.onclose = ev => {
      if (this.ws !== ws) return;
      this.ready = false;
      clearInterval(this.pingTimer);
      if (ev.code === 4401) { this.stopped = true; this.emit('auth-failed', { reason: ev.reason }); return; }
      if (ev.code === 4409) { this.stopped = true; this.emit('replaced', {}); return; }
      this.emit('status', { online: false });
      if (this.stopped) return;
      const delay = Math.min(10000, 600 * 2 ** this.attempt++);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  send(obj) {
    const data = JSON.stringify(obj);
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) { this.ws.send(data); return true; }
    if (obj.type !== 'ping' && this.queue.length < 300) this.queue.push({ data, at: Date.now() });
    return false;
  }

  close() {
    this.stopped = true;
    clearInterval(this.pingTimer);
    try { this.ws?.close(1000); } catch { /* ignore */ }
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}
