// terrain.js – Gelände-Maske, Krater, RLE-Kodierung, Prüfsumme und Kartengenerator.
// Läuft ohne DOM (auch in Node für Tests).

/** Kleiner, schneller PRNG. Alles Zufällige der Karte kommt hieraus, nie aus Math.random(). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const MAP_SIZES = {
  klein: [1400, 720],
  mittel: [1900, 860],
  gross: [2600, 1000],
};

/** Abstand der Wasseroberfläche vom unteren Kartenrand. */
export const WATER_MARGIN = 46;

export class Terrain {
  constructor(W, H, mask) {
    this.W = W;
    this.H = H;
    this.mask = mask || new Uint8Array(W * H);
    this.water = H - WATER_MARGIN;
    this.dirty = null; // geänderter Bereich seit dem letzten Zeichnen [x0, y0, x1, y1]
  }

  solid(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= this.W || iy >= this.H) return false;
    return this.mask[iy * this.W + ix] === 1;
  }

  markDirty(x0, y0, x1, y1) {
    x0 = Math.max(0, x0 | 0); y0 = Math.max(0, y0 | 0);
    x1 = Math.min(this.W - 1, x1 | 0); y1 = Math.min(this.H - 1, y1 | 0);
    if (x1 < x0 || y1 < y0) return;
    const d = this.dirty;
    this.dirty = d
      ? [Math.min(d[0], x0), Math.min(d[1], y0), Math.max(d[2], x1), Math.max(d[3], y1)]
      : [x0, y0, x1, y1];
  }

  /** Krater: alle Pixel im Kreis um (cx, cy) mit Radius r werden Luft. Nur Ganzzahlen, daher überall gleich. */
  carve(cx, cy, r) {
    cx |= 0; cy |= 0; r |= 0;
    const { W, H, mask } = this;
    for (let dy = -r; dy <= r; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= H) continue;
      const s = Math.floor(Math.sqrt(r * r - dy * dy));
      const x0 = Math.max(0, cx - s), x1 = Math.min(W - 1, cx + s);
      const row = y * W;
      for (let x = x0; x <= x1; x++) mask[row + x] = 0;
    }
    this.markDirty(cx - r - 6, cy - r - 6, cx + r + 6, cy + r + 6);
  }

  /** Kreis mit festem Gelände füllen (nur Generator). */
  fill(cx, cy, r) {
    cx |= 0; cy |= 0; r |= 0;
    const { W, H, mask } = this;
    for (let dy = -r; dy <= r; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= H) continue;
      const s = Math.floor(Math.sqrt(r * r - dy * dy));
      const x0 = Math.max(0, cx - s), x1 = Math.min(W - 1, cx + s);
      for (let x = x0; x <= x1; x++) mask[y * W + x] = 1;
    }
  }

  /** Lauflängen-Kodierung (abwechselnd Luft/fest, beginnend mit Luft) als Varint-Bytes. */
  encode() {
    const m = this.mask;
    const out = [];
    const push = (v) => {
      while (v >= 128) { out.push((v & 127) | 128); v >>>= 7; }
      out.push(v);
    };
    let cur = 0, run = 0;
    for (let i = 0; i < m.length; i++) {
      if (m[i] === cur) run++;
      else { push(run); cur ^= 1; run = 1; }
    }
    push(run);
    return Uint8Array.from(out);
  }

  static decode(bytes, W, H) {
    const t = new Terrain(W, H);
    const m = t.mask;
    let i = 0, pos = 0, cur = 0;
    while (i < bytes.length && pos < m.length) {
      let v = 0, shift = 0, b;
      do { b = bytes[i++]; v += (b & 127) * 2 ** shift; shift += 7; } while (b & 128);
      if (cur) m.fill(1, pos, Math.min(m.length, pos + v));
      pos += v;
      cur ^= 1;
    }
    return t;
  }

  /** FNV-1a über die ganze Maske. */
  hash() {
    const m = this.mask;
    let h = 0x811c9dc5;
    for (let i = 0; i < m.length; i++) {
      h ^= m[i];
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  toB64() { return bytesToB64(this.encode()); }
  static fromB64(s, W, H) { return Terrain.decode(b64ToBytes(s), W, H); }
}

export function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function b64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Kartengenerator (läuft nur auf dem Gastgeber)

function makeProfile(rnd, W, base, amp) {
  const waves = [];
  for (let k = 0; k < 5; k++) {
    waves.push({
      f: ((1 + k * 1.9 + rnd() * 1.6) * 2 * Math.PI) / W,
      p: rnd() * Math.PI * 2,
      a: (amp / (1 + k * 1.1)) * (0.45 + rnd() * 0.9),
    });
  }
  const h = new Float32Array(W);
  let n = 0;
  for (let x = 0; x < W; x++) {
    let v = base;
    for (const w of waves) v += w.a * Math.sin(x * w.f + w.p);
    n = n * 0.97 + (rnd() - 0.5) * 2.2;
    h[x] = v + n;
  }
  // gelegentlich Plateaus
  const plats = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < plats; i++) {
    const cx = Math.floor(rnd() * W), hw = 30 + Math.floor(rnd() * 60);
    const lvl = h[cx];
    for (let x = Math.max(0, cx - hw); x < Math.min(W, cx + hw); x++) {
      const u = Math.abs(x - cx) / hw;
      const k = u < 0.7 ? 1 : 1 - (u - 0.7) / 0.3;
      h[x] = h[x] * (1 - k) + lvl * k;
    }
  }
  return h;
}

function fillProfile(t, h, yMin, yMax) {
  const { W, H, mask } = t;
  for (let x = 0; x < W; x++) {
    const top = Math.max(yMin, Math.min(yMax, Math.round(h[x])));
    for (let y = top; y < H; y++) mask[y * W + x] = 1;
  }
}

function carveTunnel(t, rnd, x, y, len, rad, yMin, yMax) {
  let ang = rnd() * Math.PI * 2;
  for (let s = 0; s < len; s += 4) {
    x += Math.cos(ang) * 4;
    y += Math.sin(ang) * 4 * 0.55;
    ang += (rnd() - 0.5) * 0.55;
    if (y < yMin) { y = yMin; ang = -ang; }
    if (y > yMax) { y = yMax; ang = -ang; }
    if (x < 20 || x > t.W - 20) ang = Math.PI - ang;
    const r = rad + Math.sin(s * 0.045) * rad * 0.3;
    t.carve(Math.round(x), Math.round(y), Math.round(r));
  }
}

/** Entfernt kleine, lose Brocken (Zusammenhangskomponenten unter minSize Pixeln). */
export function removeSmall(t, minSize) {
  const { W, H, mask } = t;
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const comp = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    comp.length = 0;
    while (sp) {
      const i = stack[--sp];
      comp.push(i);
      const x = i % W;
      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[sp++] = i - 1; }
      if (x < W - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[sp++] = i + 1; }
      if (i >= W && mask[i - W] && !seen[i - W]) { seen[i - W] = 1; stack[sp++] = i - W; }
      if (i < mask.length - W && mask[i + W] && !seen[i + W]) { seen[i + W] = 1; stack[sp++] = i + W; }
      if (comp.length > minSize) break;
    }
    if (comp.length <= minSize && sp === 0) for (const i of comp) mask[i] = 0;
    else {
      // Rest der großen Komponente nur markieren
      while (sp) {
        const i = stack[--sp];
        const x = i % W;
        if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[sp++] = i - 1; }
        if (x < W - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[sp++] = i + 1; }
        if (i >= W && mask[i - W] && !seen[i - W]) { seen[i - W] = 1; stack[sp++] = i - W; }
        if (i < mask.length - W && mask[i + W] && !seen[i + W]) { seen[i + W] = 1; stack[sp++] = i + W; }
      }
    }
  }
}

/**
 * Erzeugt eine neue Karte.
 * mode: 'huegel' | 'inseln' | 'hoehlen'
 */
export function generateTerrain({ W, H, mode, seed }) {
  const rnd = mulberry32(seed);
  const t = new Terrain(W, H);
  const water = t.water;
  const R = (a, b) => a + (b - a) * rnd();

  if (mode === 'inseln') {
    const n = Math.max(3, Math.round(W / 420 + R(-0.5, 1)));
    const slot = W / n;
    for (let i = 0; i < n; i++) {
      const cx = slot * (i + 0.5) + R(-slot * 0.15, slot * 0.15);
      const hw = slot * R(0.32, 0.46);
      const height = H * R(0.28, 0.55);
      const prof = makeProfile(rnd, W, 0, 26);
      for (let x = Math.max(0, Math.floor(cx - hw)); x < Math.min(W, Math.ceil(cx + hw)); x++) {
        const u = (x - cx) / hw;
        const bump = Math.pow(Math.max(0, 1 - u * u), 0.6);
        const top = Math.round(water + 20 - height * bump + prof[x] * bump);
        for (let y = Math.max(10, top); y < H; y++) t.mask[y * W + x] = 1;
      }
    }
    // schwebende Brocken
    const fl = 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < fl; i++) {
      const cx = R(100, W - 100), cy = R(H * 0.18, H * 0.45), hw = R(50, 110), th = R(24, 46);
      for (let x = Math.floor(cx - hw); x < cx + hw; x++) {
        if (x < 0 || x >= W) continue;
        const u = (x - cx) / hw;
        const k = 1 - u * u;
        const top = Math.round(cy - th * 0.35 * k + R(-1, 1));
        const bot = Math.round(cy + th * k);
        for (let y = top; y <= bot; y++) if (y >= 0 && y < H) t.mask[y * W + x] = 1;
      }
    }
    // ein paar Löcher
    const holes = Math.floor(W / 600);
    for (let i = 0; i < holes; i++) t.carve(Math.round(R(80, W - 80)), Math.round(R(H * 0.55, water - 40)), Math.round(R(18, 34)));
  } else if (mode === 'hoehlen') {
    const h = makeProfile(rnd, W, H * R(0.24, 0.32), H * 0.13);
    fillProfile(t, h, Math.round(H * 0.08), water - 120);
    const yMin = Math.round(H * 0.25), yMax = water - 40;
    // lange Gänge, ein Teil davon bricht zur Oberfläche durch
    const tunnels = Math.round(W / 260) + 2;
    for (let i = 0; i < tunnels; i++) {
      const x = R(60, W - 60);
      const open = rnd() < 0.45;
      const y = open ? h[Math.floor(x)] + 10 : R(H * 0.4, water - 70);
      carveTunnel(t, rnd, x, y, R(260, 700), R(13, 24), yMin, yMax);
    }
    // große Kammern
    const rooms = Math.round(W / 450) + 1;
    for (let i = 0; i < rooms; i++) {
      const cx = R(120, W - 120), cy = R(H * 0.45, water - 90);
      const parts = 5 + Math.floor(rnd() * 5);
      for (let k = 0; k < parts; k++) {
        t.carve(Math.round(cx + R(-80, 80)), Math.round(cy + R(-30, 30)), Math.round(R(26, 48)));
      }
    }
    // Öffnungen zum Meer hin unten an den Rändern lassen das Wasser „hereinschauen“
    for (const side of [0, 1]) {
      if (rnd() < 0.5) {
        const x = side ? W - R(30, 140) : R(30, 140);
        carveTunnel(t, rnd, x, water - 30, R(150, 300), R(14, 22), water - 120, water - 10);
      }
    }
  } else {
    // huegel
    const h = makeProfile(rnd, W, H * R(0.42, 0.56), H * 0.2);
    fillProfile(t, h, Math.round(H * 0.12), water - 50);
    // ein paar Überhänge/Kuhlen
    const dents = Math.floor(W / 500);
    for (let i = 0; i < dents; i++) {
      const x = R(80, W - 80);
      t.carve(Math.round(x), Math.round(h[Math.floor(x)] + R(10, 30)), Math.round(R(20, 36)));
    }
  }

  // Nichts unter dem Wasser lassen, was Mitspieler sehen könnten, außer dem Boden selbst
  removeSmall(t, 500);
  t.dirty = null;
  return t;
}

/** Markiert alle Luft-Pixel, die mit dem Himmel (oberer, linker, rechter Rand) verbunden sind. */
export function skyAir(t) {
  const { W, H, mask } = t;
  const sky = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  let sp = 0;
  const seed = (i) => { if (!mask[i] && !sky[i]) { sky[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < W; x++) seed(x);
  for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
  while (sp) {
    const i = stack[--sp];
    const x = i % W;
    if (x > 0) seed(i - 1);
    if (x < W - 1) seed(i + 1);
    if (i >= W) seed(i - W);
    if (i < mask.length - W) seed(i + W);
  }
  return sky;
}

/** Sucht n Startplätze: fester Boden, Platz für die Figur, Abstand zueinander, nicht eingeschlossen. */
export function findSpawns(t, n, rnd) {
  const { W } = t;
  const sky = skyAir(t);
  const spots = [];
  let minDist = 80;
  const free = (x, y) => {
    for (let yy = y - 20; yy < y; yy++) for (let xx = x - 6; xx <= x + 6; xx++) if (t.solid(xx, yy)) return false;
    return true;
  };
  for (let attempt = 0; attempt < 600 && spots.length < n; attempt++) {
    if (attempt === 300) minDist = 45;
    if (attempt === 450) minDist = 25;
    const x = 30 + Math.floor(rnd() * (W - 60));
    const cands = [];
    for (let y = 18; y < t.water - 10; y++) {
      if (t.solid(x, y) && !t.solid(x, y - 1) && sky[(y - 1) * W + x] && t.solid(x - 3, y + 1) && t.solid(x + 3, y + 1) && free(x, y)) cands.push(y);
    }
    if (!cands.length) continue;
    const y = cands[Math.floor(rnd() * cands.length)];
    if (spots.some((s) => Math.hypot(s.x - x, s.y - y) < minDist)) continue;
    spots.push({ x, y });
  }
  return spots.length === n ? spots : null;
}
