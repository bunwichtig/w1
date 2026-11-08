// net.js – Verbindungen: PeerJS (Internet) oder BroadcastChannel (?local, mehrere Tabs auf einem Rechner).
// Beide liefern dieselbe Conn-Schnittstelle: send(obj), onMessage, onClose, close(), buffered().

export const PREFIX = 'wuermer-toeten-v1-';
const LOCAL_PREFIX = 'wuermer-toeten-local-v1-';
const TIMEOUT = 12000;
const SERVER_DOWN = 'Keine Verbindung zum Vermittlungs-Server. Bitte Internet prüfen oder es gleich nochmal versuchen.';

export function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

export async function hashPw(pw) {
  if (!pw) return '';
  const data = new TextEncoder().encode('wuermer-toeten:' + pw);
  try {
    const d = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    let h = 0x811c9dc5;
    for (const b of data) { h ^= b; h = Math.imul(h, 16777619); }
    return 'f' + (h >>> 0).toString(16);
  }
}

export function randomId(n = 8) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => (b % 36).toString(36)).join('');
}

class Conn {
  constructor() {
    this.q = [];
    this.msgFn = null;
    this.closeFn = null;
    this.closed = false;
  }
  set onMessage(fn) {
    this.msgFn = fn;
    while (fn && this.q.length) fn(this.q.shift());
  }
  set onClose(fn) {
    this.closeFn = fn;
    if (this.closed && fn) fn();
  }
  deliver(d) {
    if (this.closed) return;
    if (this.msgFn) this.msgFn(d);
    else this.q.push(d);
  }
  fireClose() {
    if (this.closed) return;
    this.closed = true;
    if (this.closeFn) this.closeFn();
  }
  send() {}
  close() { this.fireClose(); }
  buffered() { return 0; }
}

// --- PeerJS ------------------------------------------------------------------

function wrapPeer(dc) {
  const c = new Conn();
  c.send = (o) => { try { if (dc.open) dc.send(o); } catch (e) { console.warn(e); } };
  c.close = () => { try { dc.close(); } catch { /* egal */ } c.fireClose(); };
  c.buffered = () => (dc.dataChannel ? dc.dataChannel.bufferedAmount : 0);
  dc.on('data', (d) => c.deliver(d));
  dc.on('close', () => c.fireClose());
  dc.on('error', () => c.fireClose());
  return c;
}

function needPeer() {
  if (typeof window === 'undefined' || !window.Peer) throw new Error('Die Netzwerk-Bibliothek konnte nicht geladen werden.');
}

function peerHost(room, onConn) {
  return new Promise((resolve, reject) => {
    needPeer();
    const peer = new window.Peer(PREFIX + room, { debug: 0 });
    let opened = false;
    const to = setTimeout(() => { if (!opened) { peer.destroy(); reject(new Error('Zeitüberschreitung: Der Vermittlungs-Server antwortet nicht.')); } }, TIMEOUT);
    peer.on('open', () => {
      opened = true;
      clearTimeout(to);
      resolve({ close: () => peer.destroy() });
    });
    peer.on('connection', (dc) => {
      const c = wrapPeer(dc);
      let ok = false;
      const t = setTimeout(() => { if (!ok) c.close(); }, TIMEOUT);
      dc.on('open', () => { ok = true; clearTimeout(t); onConn(c); });
    });
    peer.on('disconnected', () => { if (opened && !peer.destroyed) try { peer.reconnect(); } catch { /* egal */ } });
    peer.on('error', (e) => {
      if (opened) { console.warn('PeerJS', e.type, e); return; }
      clearTimeout(to);
      peer.destroy();
      if (e.type === 'unavailable-id') reject(new Error('Diesen Raum gibt es schon. Bitte einen anderen Namen wählen.'));
      else if (e.type === 'browser-incompatible') reject(new Error('Dieser Browser kann kein WebRTC.'));
      else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) reject(new Error(SERVER_DOWN));
      else reject(new Error('Verbindungsfehler: ' + (e.type || e.message)));
    });
  });
}

function peerJoin(room) {
  return new Promise((resolve, reject) => {
    needPeer();
    const peer = new window.Peer({ debug: 0 });
    let done = false;
    const fail = (msg) => { if (done) return; done = true; clearTimeout(to); peer.destroy(); reject(new Error(msg)); };
    const to = setTimeout(() => fail('Zeitüberschreitung: Keine Verbindung zum Gastgeber.'), TIMEOUT);
    peer.on('open', () => {
      const dc = peer.connect(PREFIX + room, { reliable: true, serialization: 'json' });
      dc.on('open', () => {
        if (done) return;
        done = true;
        clearTimeout(to);
        const c = wrapPeer(dc);
        const close = c.close;
        c.close = () => { close(); peer.destroy(); };
        resolve(c);
      });
    });
    peer.on('error', (e) => {
      if (e.type === 'peer-unavailable') fail('Diesen Raum gibt es nicht (oder der Gastgeber ist offline).');
      else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) fail(SERVER_DOWN);
      else if (!done) fail('Verbindungsfehler: ' + (e.type || e.message));
    });
  });
}

// --- BroadcastChannel (?local) --------------------------------------------------

function localHost(room, onConn) {
  return new Promise((resolve, reject) => {
    const ch = new BroadcastChannel(LOCAL_PREFIX + room);
    const conns = new Map();
    let probing = true;
    ch.onmessage = (ev) => {
      const m = ev.data;
      if (!m) return;
      if (probing) { if (m.k === 'here') { probing = false; ch.close(); reject(new Error('Diesen Raum gibt es schon. Bitte einen anderen Namen wählen.')); } return; }
      if (m.k === 'probe') ch.postMessage({ k: 'here' });
      else if (m.k === 'hello' && !conns.has(m.from)) {
        const c = new Conn();
        const id = m.from;
        c.send = (d) => { if (!c.closed) ch.postMessage({ k: 'msg', to: id, d }); };
        c.close = () => { ch.postMessage({ k: 'bye', to: id }); conns.delete(id); c.fireClose(); };
        conns.set(id, c);
        ch.postMessage({ k: 'ack', to: id });
        onConn(c);
      } else if (m.k === 'msg' && m.to === 'host') {
        const c = conns.get(m.from);
        if (c) c.deliver(m.d);
      } else if (m.k === 'bye' && m.to === 'host') {
        const c = conns.get(m.from);
        if (c) { conns.delete(m.from); c.fireClose(); }
      }
    };
    ch.postMessage({ k: 'probe' });
    setTimeout(() => {
      if (!probing) return;
      probing = false;
      const bye = () => ch.postMessage({ k: 'bye', to: '*' });
      addEventListener('pagehide', bye);
      resolve({ close: () => { bye(); ch.close(); removeEventListener('pagehide', bye); } });
    }, 400);
  });
}

function localJoin(room) {
  return new Promise((resolve, reject) => {
    const ch = new BroadcastChannel(LOCAL_PREFIX + room);
    const me = randomId(10);
    const c = new Conn();
    let ok = false;
    const to = setTimeout(() => { if (!ok) { ch.close(); reject(new Error('Diesen Raum gibt es nicht (oder der Gastgeber ist offline).')); } }, 1500);
    const bye = () => ch.postMessage({ k: 'bye', from: me, to: 'host' });
    ch.onmessage = (ev) => {
      const m = ev.data;
      if (!m) return;
      if (m.k === 'ack' && m.to === me && !ok) {
        ok = true;
        clearTimeout(to);
        addEventListener('pagehide', bye);
        resolve(c);
      } else if (m.k === 'msg' && m.to === me) c.deliver(m.d);
      else if (m.k === 'bye' && (m.to === me || m.to === '*')) { c.fireClose(); ch.close(); }
    };
    c.send = (d) => { if (!c.closed) ch.postMessage({ k: 'msg', from: me, to: 'host', d }); };
    c.close = () => { bye(); removeEventListener('pagehide', bye); c.fireClose(); ch.close(); };
    ch.postMessage({ k: 'hello', from: me });
  });
}

/** Raum öffnen. onConn(conn) wird für jede neue Verbindung aufgerufen. */
export function hostRoom(room, local, onConn) {
  return local ? localHost(room, onConn) : peerHost(room, onConn);
}

/** Raum beitreten. Liefert eine Conn. */
export function joinRoom(room, local) {
  return local ? localJoin(room) : peerJoin(room);
}
