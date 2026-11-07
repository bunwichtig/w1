// ui.js – Menü, Lobby, HUD, Eingabe (Tastatur, Maus, Touch), Töne. Startpunkt der Seite.
import { Host, Client, cleanName, MAX_TEAMS } from './session.js';
import { View, THEMES } from './view.js';
import { WEAPONS } from './game.js';
import { slug, hashPw } from './net.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const LOCAL = params.has('local');
const DESYNC_TEST = params.has('desync');

const store = {
  get(k) { try { return localStorage.getItem('krater-' + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('krater-' + k, v); } catch { /* privat */ } },
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let session = null;
let isHost = false;
let myId = -1;
let started = false;
let lobby = null;
let lastSeq = 0;
let waitingSync = false;
let desyncDone = false;
const view = new View($('cv'));
if (params.has('debug')) window.krater = { view, get session() { return session; } };

// --- Töne (selbst erzeugt mit WebAudio) ---------------------------------------
const sfx = {
  ctx: null,
  muted: store.get('mute') === '1',
  ensure() {
    if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; } }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },
  noise(dur, type, freq, vol, q = 1) {
    const c = this.ctx;
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = c.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(c.destination);
    src.start();
  },
  tone(f0, f1, dur, vol, type = 'sine') {
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t); o.stop(t + dur);
  },
  play(kind, r = 30) {
    if (this.muted || !this.ctx) return;
    try {
      if (kind === 'boom') { this.noise(0.35 + r / 90, 'lowpass', 300 + r * 8, 0.9); this.tone(120, 40, 0.3 + r / 150, 0.5); }
      else if (kind === 'shot') { this.noise(0.18, 'bandpass', 900, 0.35, 0.8); this.tone(500, 180, 0.15, 0.12, 'triangle'); }
      else if (kind === 'bang') this.noise(0.22, 'highpass', 1200, 0.6);
      else if (kind === 'splash') this.noise(0.5, 'bandpass', 600, 0.4, 0.6);
      else if (kind === 'chat') this.tone(990, 1320, 0.08, 0.05);
      else if (kind === 'turn') { this.tone(660, 660, 0.09, 0.08); setTimeout(() => this.ctx && this.tone(880, 880, 0.12, 0.08), 110); }
    } catch { /* egal */ }
  },
};
view.onSound = (k, r) => sfx.play(k, r);
view.onNotice = (text, color) => toast(text, color);

// --- Bildschirme ----------------------------------------------------------------
function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
}

function toast(text, color, cls) {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (cls ? ' ' + cls : '');
  el.textContent = text;
  if (color) el.style.borderLeftColor = color;
  box.appendChild(el);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3800);
}

function menuError(msg) {
  $('menu-err').textContent = msg || '';
}

function busy(on, text) {
  for (const id of ['btn-host', 'btn-join', 'btn-hotseat']) $(id).disabled = on;
  $('menu-busy').textContent = on ? text || 'Verbinde …' : '';
}

function backToMenu(msg) {
  if (session) { try { session.close(); } catch { /* egal */ } }
  session = null;
  started = false;
  lobby = null;
  view.loaded = false;
  $('over').hidden = true;
  chatMsgs.length = 0;
  chatUnread = 0;
  settingsInit = false;
  $('game-chat').hidden = true;
  renderChat();
  show('menu');
  busy(false);
  menuError(msg);
}

// --- Nachrichten (gleich für Gastgeber und Mitspieler) ----------------------------
const ui = {
  handle(m) {
    switch (m.t) {
      case 'welcome': myId = m.id; break;
      case 'reject': backToMenu(m.reason); break;
      case 'hostgone': if (session) backToMenu('Der Gastgeber hat das Spiel verlassen.'); break;
      case 'lobby':
        lobby = m;
        if (!m.running && started) { started = false; $('over').hidden = true; }
        if (!started) { show('lobby'); busy(false); }
        renderLobby();
        break;
      case 'start':
      case 'sync':
        view.load(m);
        lastSeq = m.seq || 0;
        waitingSync = false;
        started = true;
        $('over').hidden = true;
        show('game');
        if (m.t === 'sync') toast('Spielstand geladen.');
        break;
      case 'ev': onEvents(m.e); break;
      case 'state': view.applyState(m); break;
      case 'toast': toast(m.text); break;
      case 'chat': addChat(m, true); break;
      case 'chatlog': chatMsgs.length = 0; for (const c of m.list) addChat(c, false); break;
      case 'over': showOver(m); break;
    }
  },
};

function requestResync() {
  if (isHost || waitingSync || !session) return;
  waitingSync = true;
  session.resync();
}

function onEvents(list) {
  for (const e of list) {
    if (e[0] <= lastSeq) continue;
    if (e[0] !== lastSeq + 1) { requestResync(); return; }
    lastSeq = e[0];
    if (DESYNC_TEST && !isHost && !desyncDone && e[1] === 'x') {
      desyncDone = true;
      toast('Test: Krater absichtlich ausgelassen');
      continue;
    }
    if (!view.applyEvent(e)) {
      toast('Gelände weicht ab, hole den Stand neu …');
      requestResync();
    }
  }
}

function showOver(m) {
  $('over').hidden = false;
  const t = view.teams && view.teams[m.winner];
  $('over-title').textContent = t ? `${t.name} gewinnt!` : 'Unentschieden!';
  $('over-title').style.color = t ? t.color : '';
  $('over-text').textContent = isHost ? 'Noch eine Runde? Jede Partie bekommt eine neue Karte.' : 'Warte auf den Gastgeber …';
  $('btn-again').hidden = !isHost;
}

// --- Menü ----------------------------------------------------------------------
async function doHost(hotseat) {
  menuError('');
  const name = cleanName($('in-name').value, 'Spieler');
  store.set('name', name);
  let room = null;
  if (!hotseat) {
    room = slug($('in-room').value);
    if (!room) return menuError('Bitte einen Raumnamen eingeben.');
  }
  sfx.ensure();
  busy(true, hotseat ? '' : 'Öffne Raum …');
  const pwHash = hotseat ? '' : await hashPw($('in-pw').value);
  const s = new Host(ui, { name, room, local: LOCAL, pwHash });
  session = s;
  isHost = true;
  try {
    await s.open();
    if (hotseat) s.addLocalTeam();
  } catch (e) {
    if (session === s) session = null;
    busy(false);
    menuError(e.message);
  }
}

async function doJoin() {
  menuError('');
  const name = cleanName($('in-name').value, 'Spieler');
  store.set('name', name);
  const room = slug($('in-room').value);
  if (!room) return menuError('Bitte den Raumnamen eingeben, den dir der Gastgeber genannt hat.');
  sfx.ensure();
  busy(true, 'Verbinde …');
  const pwHash = await hashPw($('in-pw').value);
  const c = new Client(ui, { name, room, local: LOCAL, pwHash });
  session = c;
  isHost = false;
  try {
    await c.open();
  } catch (e) {
    if (session === c) session = null;
    busy(false);
    menuError(e.message);
  }
}

$('btn-host').onclick = () => doHost(false);
$('btn-join').onclick = () => doJoin();
$('btn-hotseat').onclick = () => doHost(true);
$('in-name').value = store.get('name') || '';
if (params.get('room')) {
  $('in-room').value = params.get('room');
  $('btn-join').classList.add('primary');
  $('btn-host').classList.remove('primary');
}
$('local-hint').hidden = !LOCAL;
// Nach einem Neuladen mitten im Spiel automatisch wieder beitreten
try {
  const r = slug(params.get('room') || '');
  if (r && sessionStorage.getItem('krater-tok-' + (LOCAL ? 'l-' : '') + r)) setTimeout(() => doJoin(), 0);
} catch { /* privat */ }
fetch('version.txt', { cache: 'no-store' }).then((r) => (r.ok ? r.text() : 'dev')).then((v) => { $('version').textContent = v.trim().slice(0, 40); }).catch(() => {});

// --- Lobby ----------------------------------------------------------------------
function inviteLink(room) {
  return `${location.origin}${location.pathname}?room=${encodeURIComponent(room)}${LOCAL ? '&local' : ''}`;
}

const SETTING_IDS = { size: 'set-size', mode: 'set-mode', perTeam: 'set-per', turnTime: 'set-time', theme: 'set-theme', seed: 'set-seed' };

function renderLobby() {
  const m = lobby;
  if (!m) return;
  $('lobby-room').textContent = m.room ? `„${m.room}“` : 'an diesem Gerät';
  $('invite').hidden = !m.room;
  if (m.room) $('invite-link').value = inviteLink(m.room);
  $('team-list').innerHTML = m.teams.map((t, i) => {
    const who = t.owner === myId ? (isHost && i > 0 ? 'an diesem Gerät' : 'du') : t.owner === 0 ? 'Gastgeber' : 'Mitspieler';
    const editable = isHost && t.owner === 0;
    const name = editable
      ? `<input class="team-name" data-i="${i}" value="${esc(t.name)}" maxlength="16" aria-label="Teamname">`
      : `<span class="team-name">${esc(t.name)}</span>`;
    const rm = isHost && i > 0 ? `<button class="small ghost" data-rm="${i}" title="Entfernen">✕</button>` : '';
    return `<li><span class="dot" style="background:${esc(t.color)}"></span>${name}<span class="who">${esc(who)}${t.absent ? ' · weg' : ''}</span>${rm}</li>`;
  }).join('');
  for (const el of document.querySelectorAll('#team-list input.team-name')) el.onchange = () => session.renameTeam(+el.dataset.i, el.value);
  for (const el of document.querySelectorAll('#team-list [data-rm]')) el.onclick = () => session.removeTeam(+el.dataset.rm);
  for (const [k, id] of Object.entries(SETTING_IDS)) {
    const el = $(id);
    el.disabled = !isHost;
    if (document.activeElement !== el) el.value = String(m.settings[k]);
  }
  const st = m.settings;
  const sizeName = { klein: 'klein', mittel: 'mittel', gross: 'groß' }[st.size];
  const modeName = { hoehlen: 'Höhlen', huegel: 'Hügel', inseln: 'Inseln' }[st.mode];
  $('settings-sum').textContent = `${sizeName} · ${modeName} · ${st.perTeam} ${st.perTeam == 1 ? 'Figur' : 'Figuren'} · ${st.turnTime} s`;
  if (!settingsInit) { settingsInit = true; $('settings-box').open = isHost && store.get('settings-open') !== '0'; }
  $('btn-add-team').hidden = !isHost || m.teams.length >= MAX_TEAMS;
  $('btn-start').hidden = !isHost;
  $('btn-start').disabled = m.teams.length < 2;
  $('lobby-hint').textContent = isHost
    ? m.teams.length < 2
      ? m.room ? 'Mindestens 2 Teams: Schick den Link an Freunde oder füge ein Team an diesem Gerät hinzu.' : 'Mindestens 2 Teams.'
      : m.room ? 'Bitte diesen Tab während des Spiels nicht in den Hintergrund legen, sonst ruckelt es für alle.' : 'Bereit. Ihr spielt abwechselnd an diesem Gerät.'
    : 'Warte, bis der Gastgeber das Spiel startet.';
}

let settingsInit = false;
$('settings-box').addEventListener('toggle', () => { if (isHost) store.set('settings-open', $('settings-box').open ? '1' : '0'); });
for (const [k, id] of Object.entries(SETTING_IDS)) {
  $(id).onchange = () => { if (isHost && session) session.setSettings({ [k]: $(id).value }); };
}
$('set-theme').innerHTML = '<option value="-1">zufällig</option>' + THEMES.map((t, i) => `<option value="${i}">${t.name}</option>`).join('');
$('btn-add-team').onclick = () => session && session.addLocalTeam();
$('btn-start').onclick = () => { sfx.ensure(); session && session.start(); };
$('btn-leave').onclick = () => backToMenu('');
$('btn-copy').onclick = async () => {
  const link = $('invite-link').value;
  try { await navigator.clipboard.writeText(link); toast('Link kopiert.'); } catch { $('invite-link').select(); document.execCommand('copy'); toast('Link kopiert.'); }
};
$('btn-share').hidden = !navigator.share;
$('btn-share').onclick = () => navigator.share({ title: 'Krater', text: 'Spiel mit mir Krater!', url: $('invite-link').value }).catch(() => {});
$('btn-again').onclick = () => session && session.backToLobby && session.backToLobby();
$('btn-quit').onclick = () => backToMenu('');
$('btn-exit').onclick = () => { if (confirm(isHost && lobby && lobby.room ? 'Spiel beenden? Alle Mitspieler fliegen dann raus.' : 'Spiel verlassen?')) backToMenu(''); };
$('btn-mute').onclick = () => { sfx.muted = !sfx.muted; store.set('mute', sfx.muted ? '1' : '0'); updateMute(); };
function updateMute() { $('btn-mute').textContent = sfx.muted ? '🔇' : '🔊'; }
updateMute();

// --- Chat ---------------------------------------------------------------------------
const chatMsgs = [];
let chatUnread = 0;
let chatPopups = store.get('chatpop') !== '0';

function addChat(m, live) {
  chatMsgs.push(m);
  if (chatMsgs.length > 60) chatMsgs.shift();
  renderChat();
  if (!live) return;
  const open = !$('game-chat').hidden;
  if (started && !open) {
    chatUnread++;
    if (chatPopups && m.id !== myId) toast(`${m.name}: ${m.text}`, m.color, 'chat-toast');
  }
  updateBadge();
  if (m.id !== myId) sfx.play('chat');
}

function renderChat() {
  for (const log of document.querySelectorAll('.chat-log')) {
    const items = chatMsgs.map((m) => {
      const li = document.createElement('li');
      if (m.id === myId) li.className = 'mine';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = m.color;
      const b = document.createElement('b');
      b.textContent = m.name;
      li.append(dot, b, document.createTextNode(m.text));
      return li;
    });
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Noch keine Nachrichten.';
      items.push(li);
    }
    log.replaceChildren(...items);
    log.scrollTop = log.scrollHeight;
  }
}

function updateBadge() {
  $('chat-badge').hidden = !chatUnread;
  $('chat-badge').textContent = chatUnread > 9 ? '9+' : String(chatUnread);
}

function openChat(open) {
  $('game-chat').hidden = !open;
  if (open) {
    chatUnread = 0;
    updateBadge();
    renderChat();
    $('game-chat').querySelector('.chat-input').focus();
    keys.clear();
    releaseCharge();
  }
}

for (const form of document.querySelectorAll('.chat-form')) {
  const inp = form.querySelector('.chat-input');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = inp.value.trim();
    if (text && session) session.sendChat(text);
    inp.value = '';
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && form.closest('#game-chat')) { inp.blur(); openChat(false); }
  });
}
for (const cb of document.querySelectorAll('.chat-popups')) {
  cb.checked = chatPopups;
  cb.onchange = () => {
    chatPopups = cb.checked;
    store.set('chatpop', chatPopups ? '1' : '0');
    for (const o of document.querySelectorAll('.chat-popups')) o.checked = chatPopups;
  };
}
$('btn-chat').onclick = () => openChat($('game-chat').hidden);
$('chat-close').onclick = () => openChat(false);
renderChat();

// --- Eingabe ----------------------------------------------------------------------
const input = { dx: 0, jump: 0, ang: 30, weapon: 0, fire: 0, pow: 0, fuse: 3, chg: 0 };
const keys = new Set();
let angF = 30;
let charging = false;

function activeFig() { return view.loaded ? view.figs.get(view.act) : null; }
function myTurn() {
  const f = activeFig();
  return started && !!f && f.alive && view.teams[f.team].owner === myId && ['aim', 'shot', 'retreat'].includes(view.ph);
}
function ammo(i) { return view.am && view.am[i] != null ? view.am[i] : WEAPONS[i].ammo; }

function selectWeapon(i) {
  if (!myTurn() || view.ph !== 'aim' || !WEAPONS[i] || ammo(i) === 0) return;
  input.weapon = i;
  charging = false;
  input.chg = 0;
}

function startCharge() {
  if (!myTurn() || view.ph !== 'aim') return;
  if (ammo(input.weapon) === 0) return;
  if (!WEAPONS[input.weapon].charge) { fire(100); return; }
  charging = true;
  input.chg = 0;
}
function releaseCharge() {
  if (!charging) return;
  charging = false;
  fire(Math.max(5, input.chg));
}
function fire(p) {
  input.pow = Math.round(p);
  input.chg = 0;
  input.fire++;
  sendInput();
}
function jump() {
  if (!myTurn()) return;
  view.manual = false;
  input.jump++;
  sendInput();
}
function sendInput() {
  if (!session || !started) return;
  if (isHost) session.localInput(input);
  else session.sendInput(input);
}

const KEYMAP = { ArrowLeft: 'L', KeyA: 'L', ArrowRight: 'R', KeyD: 'R', ArrowUp: 'U', KeyW: 'U', ArrowDown: 'D', KeyS: 'D' };
addEventListener('keydown', (e) => {
  sfx.ensure();
  if (!started || e.target.tagName === 'INPUT') return;
  if (KEYMAP[e.code]) { keys.add(KEYMAP[e.code]); e.preventDefault(); }
  else if (e.code === 'Space') { if (!e.repeat) startCharge(); e.preventDefault(); }
  else if (e.code === 'Enter' || e.code === 'KeyJ') { if (!e.repeat) jump(); e.preventDefault(); }
  else if (/^Digit[1-9]$/.test(e.code)) selectWeapon(+e.code.slice(5) - 1);
  else if (e.code === 'KeyF') input.fuse = (input.fuse % 5) + 1;
  else if (e.code === 'KeyM') $('btn-mute').click();
  else if (e.code === 'KeyT') { e.preventDefault(); openChat(true); }
  else if (e.code === 'Equal' || e.code === 'NumpadAdd') view.zoomMul = Math.min(2.5, view.zoomMul * 1.15);
  else if (e.code === 'Minus' || e.code === 'NumpadSubtract') view.zoomMul = Math.max(0.6, view.zoomMul / 1.15);
});
addEventListener('keyup', (e) => {
  if (KEYMAP[e.code]) keys.delete(KEYMAP[e.code]);
  if (e.code === 'Space') releaseCharge();
});
addEventListener('blur', () => { keys.clear(); releaseCharge(); });

// Kamera mit der Maus/dem Finger ziehen, Mausrad zoomt
const cv = $('cv');
let drag = null;
cv.addEventListener('pointerdown', (e) => { sfx.ensure(); drag = { x: e.clientX, y: e.clientY, moved: false }; cv.setPointerCapture(e.pointerId); });
cv.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 5) return;
  drag.moved = true;
  view.drag(dx, dy);
  drag.x = e.clientX; drag.y = e.clientY;
});
cv.addEventListener('pointerup', () => { drag = null; });
cv.addEventListener('pointercancel', () => { drag = null; });
cv.addEventListener('wheel', (e) => { e.preventDefault(); view.zoomMul = Math.max(0.6, Math.min(2.5, view.zoomMul * (e.deltaY < 0 ? 1.1 : 1 / 1.1))); }, { passive: false });

// Touch-Knöpfe
for (const el of document.querySelectorAll('#touch [data-k]')) {
  const k = el.dataset.k;
  const down = (e) => {
    e.preventDefault();
    sfx.ensure();
    el.classList.add('on');
    if (k === 'J') jump();
    else if (k === 'F') startCharge();
    else keys.add(k);
  };
  const up = (e) => {
    e.preventDefault();
    el.classList.remove('on');
    if (k === 'F') releaseCharge();
    else keys.delete(k);
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('pointerleave', up);
}
if (matchMedia('(pointer: coarse)').matches) document.body.classList.add('touch');

// --- HUD ----------------------------------------------------------------------------
const hudCache = {};
function setHtml(id, html) {
  if (hudCache[id] === html) return;
  hudCache[id] = html;
  $(id).innerHTML = html;
}

// Eigene Symbole für die Waffen (viewBox 32×32)
const svg = (body) => `<svg viewBox="0 0 32 32" aria-hidden="true">${body}</svg>`;
const WEAPON_ICONS = [
  // Rakete: schräg nach oben, mit Flamme
  svg('<g transform="rotate(-35 16 16)"><path d="M7 16 L21 12.2 Q29 16 21 19.8 Z" fill="#d5dbe8" stroke="#3b4250" stroke-width=".8"/><path d="M21 12.2 Q29 16 21 19.8 Z" fill="#e8504a"/><path d="M9 15 L5 10.5 L11.5 13.4Z M9 17 L5 21.5 L11.5 18.6Z" fill="#e8504a"/><circle cx="4.6" cy="16" r="2.6" fill="#f2b33d"/><circle cx="2.6" cy="16" r="1.4" fill="#fff6a0"/></g>'),
  // Knallei: Ei mit Punkten und brennender Lunte
  svg('<ellipse cx="15" cy="19.5" rx="8" ry="10" fill="#f4ecd6" stroke="#8a7a5a"/><circle cx="12" cy="17" r="1.7" fill="#e8504a"/><circle cx="18" cy="22.5" r="1.5" fill="#e8504a"/><circle cx="13.5" cy="24.5" r="1.1" fill="#e8504a"/><path d="M15 9.5 q2 -4 6 -4" stroke="#6b6b6b" stroke-width="1.4" fill="none"/><circle cx="22.5" cy="5.2" r="2.4" fill="#f2b33d"/><circle cx="22.5" cy="5.2" r="1.1" fill="#fff6a0"/>'),
  // Streukürbis: Kürbis, aus dem Kerne fliegen
  svg('<ellipse cx="13" cy="20" rx="9.5" ry="8" fill="#f08a24" stroke="#a3520c"/><path d="M13 12.2v15.6 M8 13.5q-2.5 6.5 0 13 M18 13.5q2.5 6.5 0 13" stroke="#a3520c" fill="none" stroke-width=".9"/><rect x="11.8" y="8" width="2.6" height="4.4" rx="1" fill="#4c8a2a"/><ellipse cx="25" cy="10" rx="2.2" ry="1.6" fill="#ffd36a"/><ellipse cx="28" cy="16.5" rx="2.2" ry="1.6" fill="#ffd36a"/><ellipse cx="22" cy="4.5" rx="2.2" ry="1.6" fill="#ffd36a"/>'),
  // Schrotflinte: Doppellauf mit drei Schrotspuren
  svg('<rect x="3" y="12" width="17" height="3.2" rx="1.2" fill="#a8b0c2" stroke="#4a5060" stroke-width=".7"/><rect x="3" y="16" width="17" height="3.2" rx="1.2" fill="#a8b0c2" stroke="#4a5060" stroke-width=".7"/><path d="M3 19.5 L1.5 26 H7 L9.5 19.5Z" fill="#8b5a2b"/><path d="M23 11.5h5 M23.5 16.6h6.5 M23 21.7h5" stroke="#ffe08a" stroke-width="2.2" stroke-linecap="round"/>'),
  // Sprengfass: rotes Fass mit Funken
  svg('<rect x="7.5" y="10" width="15" height="19" rx="3.2" fill="#c0392b" stroke="#6e1f17"/><rect x="7.5" y="14" width="15" height="2.6" fill="#f2b33d"/><rect x="7.5" y="23" width="15" height="2.6" fill="#f2b33d"/><path d="M15 10 q.5 -4 5 -5.5" stroke="#6b6b6b" stroke-width="1.4" fill="none"/><path d="M22 0.8 l1.3 2.9 3.1 .3 -2.4 2.1 .7 3.1 -2.7 -1.6 -2.7 1.6 .7 -3.1 -2.4 -2.1 3.1 -.3z" fill="#ffd36a"/>'),
];

const PHASE_TEXT = { shot: 'Schuss!', retreat: 'Rückzug!', settle: '…', pause: 'Warte auf Spieler …', next: '', over: 'Spielende' };

function updateHud(mine) {
  const f = activeFig();
  const team = f ? view.teams[f.team] : null;
  setHtml('hud-turn', team
    ? `<span class="dot" style="background:${esc(team.color)}"></span><b>${esc(f.name)}</b> <span class="muted">${esc(team.name)}</span>${mine ? ' <span class="you">du bist dran</span>' : ''}`
    : esc(PHASE_TEXT[view.ph] || ''));
  const clock = view.ph === 'aim' ? String(view.clock) : PHASE_TEXT[view.ph] || '';
  setHtml('hud-clock', `<span class="${view.ph === 'aim' && view.clock <= 5 ? 'hot' : ''}">${esc(clock)}</span>`);
  const w = view.wind;
  $('wind-l').style.width = (w < 0 ? -w / 2 : 0) + '%';
  $('wind-r').style.width = (w > 0 ? w / 2 : 0) + '%';

  // Teams mit Lebensbalken
  const totals = view.teams.map((t) => {
    let hp = 0, n = 0;
    for (const fg of view.figs.values()) if (fg.team === t.id) { n++; if (fg.alive) hp += fg.hp; }
    return { t, hp, max: n * 100 };
  });
  setHtml('hud-teams', totals.map(({ t, hp, max }) =>
    `<div class="tbar${view.ab[t.id] ? ' absent' : ''}"><span class="tname">${esc(t.name)}${view.ab[t.id] === 1 ? ' (weg)' : view.ab[t.id] === 2 ? ' (aufgegeben)' : ''}</span><span class="tfill" style="width:${max ? (hp / max) * 100 : 0}%;background:${esc(t.color)}"></span><span class="thp">${hp}</span></div>`).join(''));

  // Waffenleiste
  const showWeapons = mine && view.ph === 'aim';
  $('hud-weapons').hidden = !showWeapons;
  if (showWeapons) {
    if (ammo(input.weapon) === 0) input.weapon = 0;
    const wsel = WEAPONS[input.weapon];
    setHtml('hud-weapons', '<div class="wlist">' + WEAPONS.map((w, i) => {
      const a = ammo(i);
      return `<button class="wbtn${i === input.weapon ? ' sel' : ''}" data-w="${i}" ${a === 0 ? 'disabled' : ''} title="${esc(w.name)} (${w.key})" aria-label="${esc(w.name)}"><span class="wkey">${w.key}</span>${WEAPON_ICONS[i]}<span class="wammo">${a < 0 ? '∞' : a}</span></button>`;
    }).join('') + `</div><div class="winfo"><span>${esc(wsel.info)}</span>${wsel.fuse ? ` <button class="fuse" data-fuse>Zünder: ${input.fuse} s</button>` : ''}</div>`);
  }
}
$('hud-weapons').addEventListener('pointerdown', (e) => {
  const b = e.target.closest('[data-w]');
  if (b) { e.preventDefault(); selectWeapon(+b.dataset.w); }
  if (e.target.closest('[data-fuse]')) { e.preventDefault(); input.fuse = (input.fuse % 5) + 1; }
});

// --- Hauptschleife (Zeichnen und Eingabe; der Gastgeber rechnet separat per setInterval) ----
let lastT = performance.now();
let wasMine = false;
function loop(now) {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  if (started && view.loaded) {
    const mine = myTurn();
    if (mine && !wasMine) { angF = input.ang; if (ammo(input.weapon) === 0) input.weapon = 0; }
    wasMine = mine;
    if (mine) {
      input.dx = (keys.has('R') ? 1 : 0) - (keys.has('L') ? 1 : 0);
      if (input.dx) view.manual = false;
      if (view.ph === 'aim') {
        if (keys.has('U')) angF = Math.min(90, angF + 70 * dt);
        if (keys.has('D')) angF = Math.max(-90, angF - 70 * dt);
        input.ang = Math.round(angF);
        if (charging) {
          input.chg = Math.min(100, input.chg + dt * 75);
          if (input.chg >= 100) releaseCharge();
        }
      } else { charging = false; input.chg = 0; }
    } else {
      input.dx = 0;
      charging = false;
      input.chg = 0;
    }
    sendInput();
    view.frame(dt, mine && view.ph === 'aim' ? input : null);
    updateHud(mine);
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

show('menu');
