// session.js – Gastgeber und Mitspieler: Lobby, Protokoll, Schleifen.
// Der Gastgeber rechnet alles (Game) und schickt Zustand + Ereignisse. Mitspieler schicken nur Eingaben.
import { Game, TICK, TEAM_COLORS } from './game.js';
import { hostRoom, joinRoom, randomId } from './net.js';

export const MAX_TEAMS = 4;
const STATE_LIMIT = 64 * 1024; // bufferedAmount, ab dem reine Zustände ausgelassen werden
const CLIENT_TIMEOUT = 10000;

export const DEFAULT_SETTINGS = { size: 'mittel', mode: 'hoehlen', perTeam: 3, turnTime: 45, theme: -1, seed: '' };

export function cleanName(s, fallback, max = 16) {
  const t = String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
  return t || fallback;
}

function sanitizeSettings(s, cur) {
  const o = { ...cur };
  if (['klein', 'mittel', 'gross'].includes(s.size)) o.size = s.size;
  if (['huegel', 'inseln', 'hoehlen'].includes(s.mode)) o.mode = s.mode;
  if (s.perTeam != null) o.perTeam = Math.max(1, Math.min(5, s.perTeam | 0));
  if (s.turnTime != null) o.turnTime = Math.max(15, Math.min(90, s.turnTime | 0));
  if (s.theme != null) o.theme = Math.max(-1, Math.min(3, s.theme | 0));
  if (s.seed != null) o.seed = String(s.seed).replace(/\D/g, '').slice(0, 10);
  return o;
}

/**
 * Gastgeber. ui.handle(msg) bekommt dieselben Nachrichten wie ein Mitspieler.
 * room = null heißt: nur dieses Gerät (Hotseat), kein Netzwerk.
 */
export class Host {
  constructor(ui, { name, room, local, pwHash }) {
    this.ui = ui;
    this.room = room;
    this.local = local;
    this.pwHash = pwHash || '';
    this.myId = 0;
    this.nextId = 1;
    this.players = new Map(); // id -> { id, name, conn, tok, absent, lastSeen, inp }
    this.players.set(0, { id: 0, name, conn: null, tok: '', absent: false, inp: { fire: 0, jump: 0 } });
    this.teams = [{ name, color: TEAM_COLORS[0], owner: 0 }];
    this.settings = { ...DEFAULT_SETTINGS };
    this.game = null;
    this.theme = 0;
    this.server = null;
    this.timer = null;
  }

  async open() {
    if (this.room) this.server = await hostRoom(this.room, this.local, (c) => this.onConnect(c));
    this.ui.handle({ t: 'welcome', id: 0 });
    this.broadcastLobby();
  }

  close() {
    clearInterval(this.timer);
    for (const p of this.players.values()) if (p.conn) p.conn.close();
    if (this.server) this.server.close();
  }

  // --- Verbindungen --------------------------------------------------------
  onConnect(conn) {
    let p = null;
    const t = setTimeout(() => { if (!p) conn.close(); }, 8000);
    conn.onMessage = (m) => {
      if (!m || typeof m !== 'object') return;
      if (!p) {
        if (m.t !== 'join') return;
        clearTimeout(t);
        p = this.onJoin(conn, m);
        if (!p) setTimeout(() => conn.close(), 400);
        return;
      }
      if (p.conn !== conn) return;
      p.lastSeen = performance.now();
      this.onMessage(p, m);
    };
    conn.onClose = () => { if (p && p.conn === conn) this.onLeave(p); };
  }

  onJoin(conn, m) {
    const reject = (reason) => { conn.send({ t: 'reject', reason }); return null; };
    // Ein gültiges Token (Wiederverbinden) ersetzt das Passwort.
    if (m.tok) {
      for (const p of this.players.values()) {
        if (p.tok && p.tok === m.tok && p.id !== 0) {
          if (p.conn && p.conn !== conn) p.conn.close();
          p.conn = conn;
          p.absent = false;
          p.lastSeen = performance.now();
          p.inp = { fire: 0, jump: 0 };
          conn.send({ t: 'welcome', id: p.id, tok: p.tok });
          if (this.game) {
            this.teams.forEach((t, i) => { if (t.owner === p.id) this.game.setAbsent(i, false); });
            conn.send(this.syncMsg());
            this.toast(`${p.name} ist wieder da.`);
          }
          this.broadcastLobby();
          return p;
        }
      }
    }
    if (this.pwHash && m.pw !== this.pwHash) return reject('Falsches Passwort.');
    if (this.game) return reject('Das Spiel läuft schon.');
    if (this.teams.length >= MAX_TEAMS) return reject('Der Raum ist voll.');
    const p = {
      id: this.nextId++, name: cleanName(m.name, 'Gast'), conn, tok: randomId(12),
      absent: false, lastSeen: performance.now(), inp: { fire: 0, jump: 0 },
    };
    this.players.set(p.id, p);
    this.teams.push({ name: p.name, color: this.freeColor(), owner: p.id });
    conn.send({ t: 'welcome', id: p.id, tok: p.tok });
    this.broadcastLobby();
    this.toast(`${p.name} ist beigetreten.`);
    return p;
  }

  onLeave(p) {
    p.conn = null;
    if (this.game) {
      p.absent = true;
      this.teams.forEach((t, i) => { if (t.owner === p.id) this.game.setAbsent(i, true); });
      this.toast(`${p.name} hat die Verbindung verloren. Die Züge des Teams werden übersprungen, bis die Verbindung wieder steht.`);
    } else {
      this.players.delete(p.id);
      this.teams = this.teams.filter((t) => t.owner !== p.id);
      this.toast(`${p.name} hat den Raum verlassen.`);
    }
    this.broadcastLobby();
  }

  onMessage(p, m) {
    switch (m.t) {
      case 'input': if (this.game) this.applyInput(p, m); break;
      case 'resync': if (this.game) p.conn.send(this.syncMsg()); break;
      case 'ping': break;
    }
  }

  freeColor() {
    return TEAM_COLORS.find((c) => !this.teams.some((t) => t.color === c)) || TEAM_COLORS[0];
  }

  toast(text) {
    this.broadcast({ t: 'toast', text });
  }

  broadcast(msg, onlyState = false) {
    for (const p of this.players.values()) {
      if (!p.conn || p.absent) continue;
      if (onlyState && p.conn.buffered() > STATE_LIMIT) continue;
      p.conn.send(msg);
    }
    this.ui.handle(msg);
  }

  lobbyMsg() {
    return {
      t: 'lobby',
      room: this.room,
      running: !!this.game,
      settings: this.settings,
      teams: this.teams.map((t) => {
        const p = this.players.get(t.owner);
        return { name: t.name, color: t.color, owner: t.owner, ownerName: p ? p.name : '?', absent: !!(p && p.absent) };
      }),
    };
  }

  broadcastLobby() { this.broadcast(this.lobbyMsg()); }

  // --- Lobby-Aktionen (nur Gastgeber-UI) ------------------------------------
  setSettings(s) {
    if (this.game) return;
    this.settings = sanitizeSettings(s, this.settings);
    this.broadcastLobby();
  }

  addLocalTeam() {
    if (this.game || this.teams.length >= MAX_TEAMS) return;
    this.teams.push({ name: 'Team ' + (this.teams.length + 1), color: this.freeColor(), owner: 0 });
    this.broadcastLobby();
  }

  removeTeam(i) {
    if (this.game || i === 0) return;
    const t = this.teams[i];
    if (!t) return;
    if (t.owner !== 0) {
      const p = this.players.get(t.owner);
      if (p && p.conn) { p.conn.send({ t: 'reject', reason: 'Der Gastgeber hat dich aus dem Raum genommen.' }); setTimeout(() => p.conn && p.conn.close(), 300); }
      this.players.delete(t.owner);
    }
    this.teams.splice(i, 1);
    this.broadcastLobby();
  }

  renameTeam(i, name) {
    const t = this.teams[i];
    if (this.game || !t || t.owner !== 0) return;
    t.name = cleanName(name, t.name);
    this.broadcastLobby();
  }

  // --- Spiel ------------------------------------------------------------------
  start() {
    if (this.game || this.teams.length < 2) return;
    const s = this.settings;
    const seed = s.seed ? Number(s.seed) >>> 0 : crypto.getRandomValues(new Uint32Array(1))[0];
    this.theme = s.theme >= 0 ? s.theme : seed % 4;
    this.game = new Game(this.teams.map((t) => ({ ...t })), {
      perTeam: s.perTeam, size: s.size, mode: s.mode, turnTime: s.turnTime, seed,
    });
    for (const p of this.players.values()) p.inp = { fire: 0, jump: 0, ...p.inp };
    this.lastState = '';
    this.lastStateAt = 0;
    this.overSent = false;
    this.broadcast({ t: 'start', ...this.game.staticInfo(), theme: this.theme, rle: this.game.terrain.toB64(), seq: 0 });
    this.broadcastLobby();
    this.flush();
    this.last = performance.now();
    this.acc = 0;
    // setInterval statt requestAnimationFrame: rechnet auch im Hintergrund-Tab weiter.
    this.timer = setInterval(() => this.tick(), 1000 / 60);
  }

  backToLobby() {
    clearInterval(this.timer);
    this.timer = null;
    this.game = null;
    // Abwesende Mitspieler aus der Lobby entfernen
    for (const p of [...this.players.values()]) {
      if (p.id !== 0 && p.absent) { this.players.delete(p.id); this.teams = this.teams.filter((t) => t.owner !== p.id); }
    }
    this.broadcastLobby();
  }

  syncMsg() {
    const g = this.game;
    return { t: 'sync', ...g.staticInfo(), theme: this.theme, rle: g.terrain.toB64(), seq: g.seq };
  }

  applyInput(p, inp) {
    const g = this.game;
    const act = g.activeTeam();
    const mine = !!act && act.owner === p.id && !act.absent;
    const jump = inp.jump | 0, fire = inp.fire | 0;
    if (jump !== p.inp.jump) { p.inp.jump = jump; if (mine) g.jump(); }
    if (mine) g.control(inp);
    if (fire !== p.inp.fire) { p.inp.fire = fire; if (mine) g.fire(inp.pow); }
  }

  localInput(inp) {
    if (this.game) this.applyInput(this.players.get(0), inp);
  }

  flush() {
    const ev = this.game.takeEvents();
    if (ev.length) this.broadcast({ t: 'ev', e: ev });
  }

  tick() {
    const g = this.game;
    if (!g) return;
    const now = performance.now();
    this.acc += Math.min(250, now - this.last) / 1000;
    this.last = now;
    let n = 0;
    while (this.acc >= TICK && n < 20) { g.update(TICK); this.acc -= TICK; n++; }
    if (n === 20) this.acc = 0;
    this.flush();

    // Zeitüberschreitung von Mitspielern
    for (const p of this.players.values()) {
      if (p.conn && !p.absent && now - p.lastSeen > CLIENT_TIMEOUT) { const c = p.conn; this.onLeave(p); c.close(); }
    }

    const snap = g.snapshot();
    this.ui.handle(snap); // eigene Anzeige jedes Mal
    const json = JSON.stringify(snap);
    const ph = g.phase;
    const interval = ph === 'aim' ? (json === this.lastState ? 1000 : 66) : ph === 'over' || ph === 'pause' ? 1000 : 50;
    if (now - this.lastStateAt >= interval) {
      this.lastStateAt = now;
      this.lastState = json;
      for (const p of this.players.values()) {
        if (!p.conn || p.absent || p.conn.buffered() > STATE_LIMIT) continue;
        p.conn.send(snap);
      }
    }
    if (ph === 'over' && !this.overSent) {
      this.overSent = true;
      const w = g.teams[g.winner];
      this.broadcast({ t: 'over', winner: g.winner, name: w ? w.name : '' });
    }
  }
}

/** Mitspieler. */
export class Client {
  constructor(ui, { name, room, local, pwHash }) {
    this.ui = ui;
    this.room = room;
    this.local = local;
    this.name = name;
    this.pwHash = pwHash;
    this.conn = null;
    this.myId = -1;
    this.lastSent = '';
    this.lastSentAt = 0;
    this.lastSeen = 0;
    this.left = false;
  }

  tokKey() { return 'krater-tok-' + (this.local ? 'l-' : '') + this.room; }

  async open() {
    this.conn = await joinRoom(this.room, this.local);
    let tok = '';
    try { tok = sessionStorage.getItem(this.tokKey()) || ''; } catch { /* privat */ }
    this.lastSeen = performance.now();
    this.conn.onMessage = (m) => {
      if (!m || typeof m !== 'object') return;
      this.lastSeen = performance.now();
      if (m.t === 'welcome') {
        this.myId = m.id;
        try { sessionStorage.setItem(this.tokKey(), m.tok); } catch { /* privat */ }
      }
      if (m.t === 'reject') this.left = true;
      this.ui.handle(m);
    };
    this.conn.onClose = () => {
      clearInterval(this.timer);
      if (!this.left) this.ui.handle({ t: 'hostgone' });
    };
    this.conn.send({ t: 'join', name: this.name, pw: this.pwHash, tok });
    this.timer = setInterval(() => {
      if (performance.now() - this.lastSeen > CLIENT_TIMEOUT) {
        clearInterval(this.timer);
        if (!this.left) { this.left = true; this.ui.handle({ t: 'hostgone' }); }
        this.conn.close();
        return;
      }
      if (performance.now() - this.lastSentAt > 2000) this.send({ t: 'ping' });
    }, 1000);
  }

  send(m) {
    if (this.conn) this.conn.send(m);
    this.lastSentAt = performance.now();
  }

  /** Eingaben bei Änderung und spätestens alle 250 ms schicken. */
  sendInput(inp) {
    const json = JSON.stringify(inp);
    const now = performance.now();
    if (json !== this.lastSent || now - this.lastSentAt > 250) {
      this.lastSent = json;
      this.send({ t: 'input', ...inp });
    }
  }

  resync() { this.send({ t: 'resync' }); }

  close() {
    this.left = true;
    clearInterval(this.timer);
    if (this.conn) this.conn.close();
  }
}
