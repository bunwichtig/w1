// view.js – Zeichnet das Spiel aus Schnappschüssen und Ereignissen. Gastgeber und Mitspieler nutzen denselben Weg.
import { Terrain } from './terrain.js';
import { WEAPONS, G } from './game.js';

export const THEMES = [
  { name: 'Wiese', sky: ['#69b5f5', '#dff1ff'], far: '#a8cfb0', near: '#7fb38b', top: [92, 178, 70], top2: [64, 138, 50], dirt: [138, 96, 60], dirt2: [112, 76, 48], stone: [150, 148, 136], water: 'rgba(36,104,204,0.86)', water2: 'rgba(110,170,240,0.7)', dust: 'rgba(255,255,255,0.7)' },
  { name: 'Wüste', sky: ['#f6a35f', '#ffe9c6'], far: '#efc293', near: '#d9a067', top: [238, 206, 124], top2: [216, 176, 98], dirt: [196, 140, 82], dirt2: [168, 114, 64], stone: [168, 128, 96], water: 'rgba(30,140,168,0.86)', water2: 'rgba(100,200,214,0.7)', dust: 'rgba(255,240,210,0.7)' },
  { name: 'Schnee', sky: ['#8eaad3', '#eef3fb'], far: '#cfdbea', near: '#adbfd6', top: [246, 249, 255], top2: [208, 220, 238], dirt: [106, 116, 138], dirt2: [86, 96, 118], stone: [140, 148, 166], water: 'rgba(48,88,150,0.88)', water2: 'rgba(130,160,210,0.7)', dust: 'rgba(255,255,255,0.95)' },
  { name: 'Glut', sky: ['#1d1026', '#6b2a3a'], far: '#3c2136', near: '#2a1828', top: [96, 74, 84], top2: [74, 54, 64], dirt: [60, 44, 54], dirt2: [46, 33, 42], stone: [118, 72, 60], water: 'rgba(214,72,26,0.9)', water2: 'rgba(255,150,50,0.75)', dust: 'rgba(255,150,60,0.85)' },
];

const rgba = (c, k = 1) => (255 << 24 | (Math.min(255, c[2] * k) << 16) | (Math.min(255, c[1] * k) << 8) | Math.min(255, c[0] * k)) >>> 0;
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
function noise(x, y) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function smoothNoise(x, y, s) {
  const gx = Math.floor(x / s), gy = Math.floor(y / s), fx = x / s - gx, fy = y / s - gy;
  const a = noise(gx, gy), b = noise(gx + 1, gy), c = noise(gx, gy + 1), d = noise(gx + 1, gy + 1);
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 255) * k) | 0, g = Math.min(255, ((n >> 8) & 255) * k) | 0, b = Math.min(255, (n & 255) * k) | 0;
  return `rgb(${r},${g},${b})`;
}

export class View {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.loaded = false;
    this.onNotice = () => {};
    this.onSound = () => {};
    this.cam = { x: 0, y: 0, tx: 0, ty: 0 };
    this.manual = false;
    this.zoomMul = 1;
    this.shake = 0;
    this.time = 0;
    this.myTurn = false;
    this.local = null;
  }

  load(st) {
    this.W = st.W; this.H = st.H; this.water = st.water;
    this.theme = THEMES[st.theme] || THEMES[0];
    this.themeId = st.theme;
    this.seed = st.seed;
    this.teams = st.teams;
    this.terrain = Terrain.fromB64(st.rle, st.W, st.H);
    this.figs = new Map();
    for (const f of st.figs) {
      this.figs.set(f.id, { ...f, x: 0, y: 0, rx: 0, ry: 0, hp: 100, shownHp: 100, dir: 1, st: 0, alive: true, seen: false, walkT: 0 });
    }
    this.projs = new Map();
    this.fx = [];
    this.labels = [];
    this.ph = 'aim'; this.act = -1; this.clock = 0; this.wind = 0; this.aim = [30, 0, 0, 3]; this.am = []; this.ab = [];
    this.buildTexture();
    this.buildBackground();
    this.dust = Array.from({ length: 50 }, (_, i) => ({ x: noise(i, 1) * 2000, y: noise(i, 2) * 1200, s: 0.5 + noise(i, 3) * 1.5, p: noise(i, 4) * 6 }));
    this.loaded = true;
    this.manual = false;
    this.camInit = false;
  }

  // --- Gelände zeichnen --------------------------------------------------------
  buildTexture() {
    const { W, H, mask } = this.terrain;
    const th = this.theme;
    this.tcv = document.createElement('canvas');
    this.tcv.width = W; this.tcv.height = H;
    this.tctx = this.tcv.getContext('2d');
    this.img = this.tctx.createImageData(W, H);
    this.px = new Uint32Array(this.img.data.buffer);
    const tex = (this.tex = new Uint32Array(W * H));
    for (let x = 0; x < W; x++) {
      let d = 0;
      for (let y = 0; y < H; y++) {
        const i = y * W + x;
        if (!mask[i]) { d = 0; continue; }
        d++;
        const n = noise(x, y);
        let c;
        if (d <= 4) c = mix(th.top, th.top2, (d - 1) / 6 + n * 0.15);
        else if (d <= 9) c = mix(th.top2, th.dirt, (d - 4) / 5);
        else {
          const b = smoothNoise(x, y, 18) * 0.7 + smoothNoise(x, y, 6) * 0.3;
          c = mix(th.dirt, th.dirt2, b);
          const st = smoothNoise(x + 999, y, 7);
          if (st > 0.78) c = mix(c, th.stone, Math.min(1, (st - 0.78) * 9));
        }
        tex[i] = rgba(c, 0.9 + n * 0.18);
      }
      // Unterseiten von Überhängen etwas dunkler
      let u = 0;
      for (let y = H - 1; y >= 0; y--) {
        const i = y * W + x;
        if (!mask[i]) { u = 0; continue; }
        u++;
        if (u <= 3) tex[i] = darken(tex[i], 0.62 + u * 0.08);
      }
    }
    for (let i = 0; i < mask.length; i++) this.px[i] = mask[i] ? tex[i] : 0;
    this.tctx.putImageData(this.img, 0, 0);
    this.terrain.dirty = null;

    // Rückwand: alles unterhalb der ursprünglichen Oberfläche bekommt dunkle Erde dahinter (Höhlen, Krater)
    this.bcv = document.createElement('canvas');
    this.bcv.width = W; this.bcv.height = H;
    const bctx = this.bcv.getContext('2d');
    const bimg = bctx.createImageData(W, H);
    const bpx = new Uint32Array(bimg.data.buffer);
    const dark = mix(th.dirt2, [0, 0, 0], 0.5), dark2 = mix(th.dirt, [0, 0, 0], 0.55);
    for (let x = 0; x < W; x++) {
      let top = 0;
      while (top < H && !mask[top * W + x]) top++;
      for (let y = top + 5; y < H; y++) {
        const b = smoothNoise(x, y, 24);
        bpx[y * W + x] = rgba(mix(dark, dark2, b), 0.92 + noise(x, y) * 0.12);
      }
    }
    bctx.putImageData(bimg, 0, 0);
  }

  craterTexture(cx, cy, r) {
    const { W, H, mask } = this.terrain;
    const tex = this.tex;
    const R = r + 5;
    for (let y = Math.max(0, cy - R); y <= Math.min(H - 1, cy + R); y++) {
      for (let x = Math.max(0, cx - R); x <= Math.min(W - 1, cx + R); x++) {
        const i = y * W + x;
        if (!mask[i]) continue;
        const d = Math.hypot(x - cx, y - cy);
        if (d <= R) tex[i] = darken(tex[i], 0.55 + 0.45 * Math.max(0, (d - r) / 5));
      }
    }
  }

  flushTerrain() {
    const d = this.terrain.dirty;
    if (!d) return;
    const { W, mask } = this.terrain;
    for (let y = d[1]; y <= d[3]; y++) {
      for (let x = d[0]; x <= d[2]; x++) {
        const i = y * W + x;
        this.px[i] = mask[i] ? this.tex[i] : 0;
      }
    }
    this.tctx.putImageData(this.img, 0, 0, d[0], d[1], d[2] - d[0] + 1, d[3] - d[1] + 1);
    this.terrain.dirty = null;
  }

  buildBackground() {
    const s = this.seed >>> 0;
    const layer = (k) => Array.from({ length: 4 }, (_, i) => ({
      f: (0.002 + noise(s + k, i) * 0.006) * (1 + i), p: noise(s, i + k * 7) * 6.28, a: (40 + noise(i, s + k) * 50) / (1 + i * 0.7),
    }));
    this.bg = [layer(1), layer(2)];
  }

  // --- Ereignisse und Zustand ----------------------------------------------------
  /** Wendet ein Ereignis an. Gibt false zurück, wenn die Gelände-Prüfsumme nicht passt. */
  applyEvent(e) {
    const [, kind] = e;
    const team = (f) => (f ? this.teams[f.team] : null);
    switch (kind) {
      case 'x': {
        const [, , x, y, r] = e;
        this.terrain.carve(x, y, r);
        this.craterTexture(x, y, r);
        this.fx.push({ k: 'boom', x, y, r, t: 0 });
        const n = Math.min(40, 8 + r / 2);
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2, s = 60 + Math.random() * r * 6;
          this.fx.push({ k: 'part', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 80, t: 0, life: 0.6 + Math.random() * 0.8, c: Math.random() < 0.5 ? this.theme.dirt : this.theme.top, sz: 1.5 + Math.random() * 2.5 });
        }
        for (let i = 0; i < 6; i++) this.fx.push({ k: 'smoke', x: x + (Math.random() - 0.5) * r, y: y + (Math.random() - 0.5) * r, t: 0, life: 1.2 + Math.random(), sz: r * (0.3 + Math.random() * 0.4) });
        this.shake = Math.min(14, this.shake + r / 5);
        this.onSound('boom', r);
        break;
      }
      case 'dmg': {
        const f = this.figs.get(e[2]);
        if (f) this.fx.push({ k: 'num', x: f.x, y: f.y - 26, t: 0, life: 1.6, text: '-' + e[3], c: team(f).color });
        break;
      }
      case 'die': {
        const f = this.figs.get(e[2]);
        if (!f) break;
        f.alive = false;
        this.onNotice(e[3] === 1 ? `${f.name} ist baden gegangen.` : `${f.name} ist ausgeschieden.`, team(f).color);
        break;
      }
      case 'splash': {
        const x = e[2];
        for (let i = 0; i < 14; i++) this.fx.push({ k: 'drop', x, y: this.water, vx: (Math.random() - 0.5) * 140, vy: -120 - Math.random() * 200, t: 0, life: 1 });
        this.onSound('splash');
        break;
      }
      case 'shot': this.onSound(WEAPONS[e[2]]?.kind === 'ray' ? 'bang' : 'shot'); break;
      case 'ray': this.fx.push({ k: 'ray', x0: e[2], y0: e[3], x1: e[4], y1: e[5], t: 0, life: 0.25 }); break;
      case 'turn': {
        const [, , id, wind, hash] = e;
        this.act = id; this.wind = wind;
        this.manual = false;
        const f = this.figs.get(id);
        if (f) this.onNotice(`${team(f).name}: ${f.name} ist dran`, team(f).color, true);
        this.onSound('turn');
        if (hash !== this.terrain.hash()) return false;
        break;
      }
      case 'timeout': this.onNotice('Zeit abgelaufen!'); break;
      case 'gaveup': { const t = this.teams[e[2]]; if (t) this.onNotice(`${t.name} hat aufgegeben.`, t.color); break; }
    }
    return true;
  }

  applyState(s) {
    if (!this.loaded) return;
    this.ph = s.ph; this.act = s.act; this.clock = s.clock; this.wind = s.wind; this.aim = s.aim; this.am = s.am; this.ab = s.ab;
    for (const a of s.f) {
      const f = this.figs.get(a[0]);
      if (!f) continue;
      f.x = a[1]; f.y = a[2]; f.hp = a[3]; f.dir = a[4]; f.st = a[5];
      if (a[5] === 9) f.alive = false;
      if (!f.seen || Math.hypot(f.rx - f.x, f.ry - f.y) > 80) { f.rx = f.x; f.ry = f.y; f.seen = true; }
    }
    const ids = new Set();
    for (const a of s.p) {
      ids.add(a[0]);
      let p = this.projs.get(a[0]);
      if (!p) {
        p = { id: a[0], kind: a[1], rx: a[2], ry: a[3], trail: [] };
        this.projs.set(a[0], p);
        this.manual = false;
      }
      p.x = a[2]; p.y = a[3]; p.vx = a[4]; p.vy = a[5]; p.fuse = a[6];
    }
    for (const id of this.projs.keys()) if (!ids.has(id)) this.projs.delete(id);
  }

  // --- Zeichnen ---------------------------------------------------------------
  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.cv.clientWidth, h = this.cv.clientHeight;
    if (this.cv.width !== Math.round(w * dpr) || this.cv.height !== Math.round(h * dpr)) {
      this.cv.width = Math.round(w * dpr);
      this.cv.height = Math.round(h * dpr);
    }
    this.dpr = dpr; this.vw = w; this.vh = h;
  }

  get zoom() {
    const base = Math.max(this.vh < 520 ? 0.75 : 0.35, Math.min(1.4, this.vh / (this.H + 10)));
    return base * this.zoomMul;
  }

  drag(dx, dy) {
    this.manual = true;
    this.cam.tx -= dx / this.zoom;
    this.cam.ty -= dy / this.zoom;
  }

  updateCamera(dt) {
    const z = this.zoom, vw = this.vw / z, vh = this.vh / z;
    let target = null;
    for (const p of this.projs.values()) target = p;
    if (!target) target = this.figs.get(this.act);
    if (target && !this.manual) {
      this.cam.tx = (target.rx ?? target.x) - vw / 2;
      this.cam.ty = (target.ry ?? target.y) - vh * 0.55;
    }
    const clampX = (v) => (this.W <= vw + 1 ? (this.W - vw) / 2 : Math.max(-60, Math.min(this.W - vw + 60, v)));
    const clampY = (v) => (this.H + 10 <= vh + 1 ? this.H + 10 - vh : Math.max(Math.min(-120, this.H + 10 - vh), Math.min(this.H + 10 - vh, v)));
    this.cam.tx = clampX(this.cam.tx);
    this.cam.ty = clampY(this.cam.ty);
    if (!this.camInit) { this.cam.x = this.cam.tx; this.cam.y = this.cam.ty; this.camInit = true; }
    const k = Math.min(1, dt * (this.manual ? 14 : 4));
    this.cam.x += (this.cam.tx - this.cam.x) * k;
    this.cam.y += (this.cam.ty - this.cam.y) * k;
  }

  /** local: { ang, chg, weapon, fuse } der eigenen Eingabe, wenn man selbst am Zug ist (sonst null). */
  frame(dt, local) {
    if (!this.loaded) return;
    this.time += dt;
    this.resize();
    this.flushTerrain();

    // Glätten
    const k = 1 - Math.pow(0.65, dt * 60); // 35 % pro Bild bei 60 fps
    for (const f of this.figs.values()) {
      f.rx += (f.x - f.rx) * k;
      f.ry += (f.y - f.ry) * k;
      f.shownHp += (f.hp - f.shownHp) * Math.min(1, dt * 3);
      if (f.st === 1) f.walkT += dt * 12;
    }
    for (const p of this.projs.values()) {
      // lokale Vorausrechnung zwischen den Schnappschüssen (nur Optik)
      p.vy += G * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (Math.hypot(p.rx - p.x, p.ry - p.y) > 60) { p.rx = p.x; p.ry = p.y; }
      p.rx += (p.x - p.rx) * 0.5; p.ry += (p.y - p.ry) * 0.5;
      p.trail.push([p.rx, p.ry]);
      if (p.trail.length > 14) p.trail.shift();
    }
    this.updateCamera(dt);
    this.shake *= Math.pow(0.02, dt);

    const ctx = this.ctx, dpr = this.dpr, z = this.zoom;
    const sx = (Math.random() - 0.5) * this.shake, sy = (Math.random() - 0.5) * this.shake;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawSky(ctx);
    ctx.setTransform(dpr * z, 0, 0, dpr * z, (-this.cam.x * z + sx) * dpr, (-this.cam.y * z + sy) * dpr);
    const vx0 = Math.max(0, Math.floor(this.cam.x - 20)), vy0 = Math.max(0, Math.floor(this.cam.y - 20));
    const vx1 = Math.min(this.W, Math.ceil(this.cam.x + this.vw / z + 20)), vy1 = Math.min(this.H, Math.ceil(this.cam.y + this.vh / z + 20));
    if (vx1 > vx0 && vy1 > vy0) {
      ctx.drawImage(this.bcv, vx0, vy0, vx1 - vx0, vy1 - vy0, vx0, vy0, vx1 - vx0, vy1 - vy0);
      ctx.drawImage(this.tcv, vx0, vy0, vx1 - vx0, vy1 - vy0, vx0, vy0, vx1 - vx0, vy1 - vy0);
    }

    for (const f of this.figs.values()) if (!f.alive) this.drawGrave(ctx, f);
    for (const f of this.figs.values()) if (f.alive) this.drawFig(ctx, f, local);
    for (const p of this.projs.values()) this.drawProj(ctx, p);
    this.drawFx(ctx, dt);
    this.drawWater(ctx);
    this.drawAim(ctx, local);

    // Beschriftungen in Bildschirm-Koordinaten (bleiben lesbar beim Zoomen)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawLabels(ctx, z);
  }

  drawSky(ctx) {
    const th = this.theme;
    const g = ctx.createLinearGradient(0, 0, 0, this.vh);
    g.addColorStop(0, th.sky[0]);
    g.addColorStop(1, th.sky[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.vw, this.vh);
    const z = this.zoom;
    const horizon = (this.water - this.cam.y) * z;
    [[th.far, 0.25, 0.55], [th.near, 0.5, 0.4]].forEach(([col, par, hgt], li) => {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(0, this.vh);
      for (let x = 0; x <= this.vw + 8; x += 8) {
        const wx = x / z + this.cam.x * par;
        let h = 0;
        for (const w of this.bg[li]) h += w.a * Math.sin(wx * w.f + w.p);
        ctx.lineTo(x, horizon - (this.H * hgt * 0.5 + h) * z * (0.6 + par));
      }
      ctx.lineTo(this.vw, this.vh);
      ctx.fill();
    });
    // Teilchen in der Luft zeigen den Wind
    ctx.fillStyle = th.dust;
    const wind = this.wind / 100;
    for (const d of this.dust) {
      d.x += (wind * 140 + 8) * d.s * (1 / 60);
      d.y += (12 + Math.sin(this.time + d.p) * 10) * (1 / 60);
      const X = ((d.x % (this.vw + 40)) + this.vw + 40) % (this.vw + 40) - 20;
      const Y = ((d.y % (this.vh + 40)) + this.vh + 40) % (this.vh + 40) - 20;
      ctx.globalAlpha = 0.35 + d.s * 0.3;
      ctx.fillRect(X, Y, 1.5 * d.s + 0.5, 1.5 * d.s + 0.5);
    }
    ctx.globalAlpha = 1;
  }

  drawWater(ctx) {
    const th = this.theme, z = this.zoom;
    const x0 = this.cam.x - 40, x1 = this.cam.x + this.vw / z + 40;
    const yb = Math.max(this.H + 400, this.cam.y + this.vh / z + 40);
    const wave = (col, amp, off, sp) => {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(x0, yb);
      for (let x = Math.floor(x0 / 10) * 10; x <= x1; x += 10) ctx.lineTo(x, this.water + off + Math.sin(x * 0.025 + this.time * sp) * amp + Math.sin(x * 0.061 - this.time * sp * 0.7) * amp * 0.5);
      ctx.lineTo(x1, yb);
      ctx.fill();
    };
    wave(th.water2, 3, -2, 1.6);
    wave(th.water, 4, 4, -1.2);
  }

  drawFig(ctx, f, local) {
    const team = this.teams[f.team];
    const x = f.rx, y = f.ry, dir = f.dir;
    const col = team.color;
    const step = f.st === 1 ? Math.sin(f.walkT) * 1.6 : 0;
    const bob = f.st === 1 ? Math.abs(Math.sin(f.walkT)) * -1 : Math.sin(this.time * 2 + f.id) * 0.3;
    // Füße
    ctx.fillStyle = shade(col, 0.55);
    ctx.beginPath(); ctx.ellipse(x - 3 + step, y - 1, 2.6, 1.6, 0, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(x + 3 - step, y - 1, 2.6, 1.6, 0, 0, 7); ctx.fill();
    // Körper
    const by = y - 7.5 + bob;
    ctx.fillStyle = col;
    ctx.strokeStyle = shade(col, 0.45);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(x, by, 6.2, 7, 0, 0, 7); ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.beginPath(); ctx.ellipse(x + dir * 1.6, by + 2, 3.4, 3.8, 0, 0, 7); ctx.fill();
    // Spross auf dem Kopf
    ctx.strokeStyle = shade(col, 0.5);
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(x - dir, by - 6.5); ctx.quadraticCurveTo(x - dir * 2, by - 10, x - dir * 4.5, by - 10.5); ctx.stroke();
    ctx.fillStyle = '#7ad45a';
    ctx.beginPath(); ctx.ellipse(x - dir * 4.8, by - 10.6, 2, 1.2, dir * 0.5, 0, 7); ctx.fill();
    // Augen
    let look = 0;
    if (f.id === this.act && this.ph === 'aim') look = -((local ? local.ang : this.aim[0]) / 90) * 1.2;
    for (const ex of [0.6, 3.6]) {
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(x + dir * ex, by - 2.8, 1.9, 0, 7); ctx.fill();
      ctx.fillStyle = '#1b1b24';
      ctx.beginPath(); ctx.arc(x + dir * (ex + 0.7), by - 2.8 + look, 0.95, 0, 7); ctx.fill();
    }
  }

  drawGrave(ctx, f) {
    const team = this.teams[f.team];
    const x = f.rx, y = f.ry;
    if (y > this.water) return;
    ctx.fillStyle = '#8b8f99';
    ctx.strokeStyle = '#5a5e68';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x - 5, y); ctx.lineTo(x - 5, y - 7); ctx.quadraticCurveTo(x - 5, y - 13, x, y - 13); ctx.quadraticCurveTo(x + 5, y - 13, x + 5, y - 7); ctx.lineTo(x + 5, y);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = team.color;
    ctx.fillRect(x - 5, y - 6, 10, 2);
  }

  drawProj(ctx, p) {
    const x = p.rx, y = p.ry;
    const a = Math.atan2(p.vy, p.vx);
    if (p.kind === 'shell' || p.kind === 'pumpkin') {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      p.trail.forEach(([tx, ty], i) => (i ? ctx.lineTo(tx, ty) : ctx.moveTo(tx, ty)));
      ctx.stroke();
    }
    ctx.save();
    ctx.translate(x, y);
    switch (p.kind) {
      case 'shell':
        ctx.rotate(a);
        ctx.fillStyle = '#3b4250';
        ctx.beginPath(); ctx.ellipse(0, 0, 6, 2.6, 0, 0, 7); ctx.fill();
        ctx.fillStyle = '#e8504a';
        ctx.beginPath(); ctx.moveTo(-5, 0); ctx.lineTo(-8, -3.5); ctx.lineTo(-8, 3.5); ctx.fill();
        ctx.fillStyle = `rgba(255,${150 + Math.random() * 80},40,0.9)`;
        ctx.beginPath(); ctx.arc(-9, 0, 1.5 + Math.random() * 1.5, 0, 7); ctx.fill();
        break;
      case 'egg':
        ctx.rotate(this.time * 6);
        ctx.fillStyle = '#f4ecd6'; ctx.strokeStyle = '#8a7a5a'; ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.ellipse(0, 0, 3.6, 4.6, 0, 0, 7); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#e8504a';
        ctx.beginPath(); ctx.arc(-1, -1, 1, 0, 7); ctx.arc(1.4, 1.6, 0.9, 0, 7); ctx.fill();
        break;
      case 'pumpkin':
        ctx.fillStyle = '#f08a24'; ctx.strokeStyle = '#a3520c'; ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.ellipse(0, 0, 5, 4.2, 0, 0, 7); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, -4); ctx.lineTo(0, 4); ctx.stroke();
        ctx.fillStyle = '#4c8a2a'; ctx.fillRect(-0.8, -6, 1.6, 2.4);
        break;
      case 'seed':
        ctx.fillStyle = '#ffd36a';
        ctx.beginPath(); ctx.ellipse(0, 0, 2.2, 1.6, a, 0, 7); ctx.fill();
        break;
      case 'barrel':
        ctx.fillStyle = '#c0392b'; ctx.strokeStyle = '#6e1f17'; ctx.lineWidth = 0.8;
        ctx.fillRect(-4, -6, 8, 10); ctx.strokeRect(-4, -6, 8, 10);
        ctx.fillStyle = '#f2b33d'; ctx.fillRect(-4, -3, 8, 1.4); ctx.fillRect(-4, 1, 8, 1.4);
        ctx.fillStyle = Math.sin(this.time * 30) > 0 ? '#fff6a0' : '#ff8a2a';
        ctx.beginPath(); ctx.arc(1, -8, 1.4, 0, 7); ctx.fill();
        break;
    }
    ctx.restore();
  }

  drawFx(ctx, dt) {
    const keep = [];
    for (const e of this.fx) {
      e.t += dt;
      switch (e.k) {
        case 'boom': {
          const d = 0.4;
          if (e.t > d) continue;
          const u = e.t / d;
          ctx.fillStyle = `rgba(255,${Math.round(240 - u * 140)},${Math.round(160 - u * 140)},${1 - u})`;
          ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (0.6 + u * 0.8), 0, 7); ctx.fill();
          ctx.strokeStyle = `rgba(255,255,255,${0.8 - u * 0.8})`;
          ctx.lineWidth = 3;
          ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (0.8 + u * 1.2), 0, 7); ctx.stroke();
          break;
        }
        case 'part':
          if (e.t > e.life) continue;
          e.vy += G * 0.8 * dt; e.x += e.vx * dt; e.y += e.vy * dt;
          if (this.terrain.solid(e.x, e.y)) { e.vx *= -0.3; e.vy *= -0.3; }
          ctx.fillStyle = `rgba(${e.c[0] | 0},${e.c[1] | 0},${e.c[2] | 0},${1 - e.t / e.life})`;
          ctx.fillRect(e.x - e.sz / 2, e.y - e.sz / 2, e.sz, e.sz);
          break;
        case 'smoke':
          if (e.t > e.life) continue;
          e.y -= 18 * dt; e.x += (this.wind / 100) * 40 * dt;
          ctx.fillStyle = `rgba(90,90,100,${0.35 * (1 - e.t / e.life)})`;
          ctx.beginPath(); ctx.arc(e.x, e.y, e.sz * (1 + e.t), 0, 7); ctx.fill();
          break;
        case 'drop':
          if (e.t > e.life) continue;
          e.vy += G * dt; e.x += e.vx * dt; e.y += e.vy * dt;
          if (e.y > this.water + 6) continue;
          ctx.fillStyle = this.theme.water2;
          ctx.fillRect(e.x - 1.5, e.y - 1.5, 3, 3);
          break;
        case 'ray':
          if (e.t > e.life) continue;
          ctx.strokeStyle = `rgba(255,240,170,${1 - e.t / e.life})`;
          ctx.lineWidth = 1.6;
          ctx.beginPath(); ctx.moveTo(e.x0, e.y0); ctx.lineTo(e.x1, e.y1); ctx.stroke();
          break;
        case 'num':
          if (e.t > e.life) continue;
          e.y -= 22 * dt;
          break;
      }
      keep.push(e);
    }
    this.fx = keep;
  }

  drawAim(ctx, local) {
    const f = this.figs.get(this.act);
    if (!f || !f.alive || this.ph !== 'aim') return;
    const ang = local ? local.ang : this.aim[0];
    const chg = local ? local.chg : this.aim[2];
    const wi = local ? local.weapon : this.aim[1];
    const w = WEAPONS[wi];
    const a = (ang * Math.PI) / 180;
    const dx = Math.cos(a) * f.dir, dy = -Math.sin(a);
    const cx = f.rx, cy = f.ry - 8;
    // Rohr
    ctx.strokeStyle = '#2d3240';
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx + dx * 3, cy + dy * 3); ctx.lineTo(cx + dx * 11, cy + dy * 11); ctx.stroke();
    ctx.lineCap = 'butt';
    // Fadenkreuz
    const R = 44;
    const ax = cx + dx * R, ay = cy + dy * R;
    ctx.strokeStyle = this.teams[f.team].color;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(ax, ay, 5, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ax - 8, ay); ctx.lineTo(ax - 3, ay); ctx.moveTo(ax + 3, ay); ctx.lineTo(ax + 8, ay);
    ctx.moveTo(ax, ay - 8); ctx.lineTo(ax, ay - 3); ctx.moveTo(ax, ay + 3); ctx.lineTo(ax, ay + 8); ctx.stroke();
    // Stärke
    if (chg > 0 && w && w.charge) {
      const n = Math.ceil(chg / 6);
      for (let i = 0; i < n; i++) {
        const t = (i + 1) / 17;
        const r = 12 + t * 40;
        ctx.fillStyle = `hsl(${60 - t * 60}, 95%, 55%)`;
        ctx.beginPath(); ctx.arc(cx + dx * r, cy + dy * r, 1.5 + t * 3, 0, 7); ctx.fill();
      }
    }
  }

  drawLabels(ctx, z) {
    const toS = (x, y) => [(x - this.cam.x) * z, (y - this.cam.y) * z];
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    for (const f of this.figs.values()) {
      if (!f.alive) continue;
      const team = this.teams[f.team];
      const [X, Y] = toS(f.rx, f.ry - 18);
      if (X < -50 || X > this.vw + 50 || Y < -40 || Y > this.vh + 40) continue;
      const hp = Math.round(f.shownHp);
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 3;
      ctx.strokeText(f.name, X, Y - 13);
      ctx.fillStyle = '#fff';
      ctx.fillText(f.name, X, Y - 13);
      ctx.font = '700 11px system-ui, sans-serif';
      const tw = ctx.measureText(String(hp)).width + 8;
      ctx.fillStyle = 'rgba(20,22,30,0.75)';
      roundRect(ctx, X - tw / 2, Y - 10, tw, 13, 4);
      ctx.fill();
      ctx.fillStyle = team.color;
      ctx.fillText(String(hp), X, Y);
      if (f.id === this.act && (this.ph === 'aim')) {
        const b = Math.sin(this.time * 6) * 3;
        ctx.fillStyle = team.color;
        ctx.beginPath(); ctx.moveTo(X - 6, Y - 32 + b); ctx.lineTo(X + 6, Y - 32 + b); ctx.lineTo(X, Y - 24 + b); ctx.fill();
      }
    }
    for (const p of this.projs.values()) {
      if (!p.fuse) continue;
      const [X, Y] = toS(p.rx, p.ry - 12);
      ctx.font = '700 12px system-ui, sans-serif';
      ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 3;
      ctx.strokeText(String(p.fuse), X, Y);
      ctx.fillStyle = '#fff'; ctx.fillText(String(p.fuse), X, Y);
    }
    for (const e of this.fx) {
      if (e.k !== 'num') continue;
      const [X, Y] = toS(e.x, e.y);
      ctx.globalAlpha = Math.max(0, 1 - e.t / e.life);
      ctx.font = '800 15px system-ui, sans-serif';
      ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 3;
      ctx.strokeText(e.text, X, Y);
      ctx.fillStyle = e.c; ctx.fillText(e.text, X, Y);
      ctx.globalAlpha = 1;
    }
  }
}

function darken(c, k) {
  const r = (c & 255) * k, g = ((c >>> 8) & 255) * k, b = ((c >>> 16) & 255) * k;
  return (255 << 24 | (b << 16) | (g << 8) | r) >>> 0;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
