// game.js – Spielregeln, Phasen, Physik, Waffen. Weiß nichts vom Netzwerk und nichts vom DOM.
import { generateTerrain, findSpawns, mulberry32, MAP_SIZES } from './terrain.js';

export const TICK = 1 / 60;
export const G = 440;            // Schwerkraft px/s²
export const MAX_SPEED = 760;    // Abschussgeschwindigkeit bei voller Stärke
export const WIND_ACC = 150;     // px/s² bei Wind 1.0
export const WALK_SPEED = 55;
export const SETTLE_MAX = 8;
export const RETREAT_TIME = 3;
export const GIVE_UP_AFTER = 120;

export const TEAM_COLORS = ['#e8504a', '#3d8bfd', '#35c46a', '#f2b33d'];
export const FIG_NAMES = [
  'Pip', 'Knut', 'Mo', 'Bo', 'Fips', 'Lumi', 'Tilda', 'Rudi', 'Ole', 'Nell',
  'Kiki', 'Bruno', 'Mika', 'Zora', 'Hugo', 'Ida', 'Jojo', 'Lotte', 'Nils', 'Wanda',
];

// Eigene Waffen. kind bestimmt das Verhalten.
export const WEAPONS = [
  { name: 'Rakete', kind: 'shell', wind: true, r: 38, dmg: 48, ammo: -1, charge: true, key: '1',
    info: 'Fliegt mit dem Wind, explodiert beim Aufprall.' },
  { name: 'Knallei', kind: 'egg', wind: false, r: 44, dmg: 50, ammo: -1, charge: true, fuse: true, bounce: 0.42, key: '2',
    info: 'Springt herum und explodiert nach dem Zünder (F ändert die Zeit).' },
  { name: 'Streukürbis', kind: 'pumpkin', wind: true, r: 26, dmg: 22, ammo: 2, charge: true, sub: 5, key: '3',
    info: 'Platzt beim Aufprall in fünf kleine Kerne.' },
  { name: 'Schrotflinte', kind: 'ray', r: 16, dmg: 28, ammo: -1, charge: false, key: '4',
    info: 'Schießt geradeaus, ohne Bogen und ohne Wind.' },
  { name: 'Sprengfass', kind: 'barrel', r: 72, dmg: 75, ammo: 1, charge: false, fuseTime: 4, key: '5',
    info: 'Wird abgestellt. Vier Sekunden, dann schnell weg!' },
];
const SEED_KIND = { r: 18, dmg: 16 };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class Game {
  /**
   * teams: [{ id, name, color, owner }]
   * opts: { perTeam, size, mode, turnTime, seed }
   */
  constructor(teams, opts = {}) {
    const perTeam = clamp(opts.perTeam | 0 || 3, 1, 5);
    const [W, H] = MAP_SIZES[opts.size] || MAP_SIZES.mittel;
    this.mode = opts.mode || 'hoehlen';
    this.size = opts.size || 'mittel';
    this.turnTime = clamp(opts.turnTime | 0 || 45, 10, 120);

    let seed = (opts.seed >>> 0) || 1;
    let terrain = null, spawns = null;
    for (let tries = 0; tries < 30; tries++) {
      terrain = generateTerrain({ W, H, mode: this.mode, seed });
      spawns = findSpawns(terrain, teams.length * perTeam, mulberry32(seed ^ 0x9e3779b9));
      if (spawns) break;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; // neue Saat würfeln
    }
    if (!spawns) throw new Error('Keine passende Karte gefunden');
    this.seed = seed;
    this.terrain = terrain;
    this.rnd = mulberry32(seed ^ 0x51ed27);

    // Startplätze mischen
    for (let i = spawns.length - 1; i > 0; i--) {
      const j = Math.floor(this.rnd() * (i + 1));
      [spawns[i], spawns[j]] = [spawns[j], spawns[i]];
    }

    this.teams = teams.map((t, i) => ({
      id: i, name: t.name, color: t.color || TEAM_COLORS[i % 4], owner: t.owner,
      absent: false, absentT: 0, gaveUp: false,
      ammo: WEAPONS.map((w) => w.ammo), figIdx: -1, weapon: 0,
    }));
    this.figures = [];
    let n = 0, nameOff = Math.floor(this.rnd() * FIG_NAMES.length);
    for (let k = 0; k < perTeam; k++) {
      for (const t of this.teams) {
        const s = spawns[n++];
        this.figures.push({
          id: this.figures.length, team: t.id, name: FIG_NAMES[(nameOff++) % FIG_NAMES.length],
          x: s.x, y: s.y, vx: 0, vy: 0, hp: 100, dir: s.x < W / 2 ? 1 : -1,
          air: false, alive: true, walk: 0, walkAcc: 0,
        });
      }
    }

    this.projectiles = [];
    this.pid = 1;
    this.events = [];
    this.seq = 0;
    this.phase = 'next';
    this.phaseT = 0;
    this.turn = 0;
    this.teamIdx = Math.floor(this.rnd() * this.teams.length) - 1;
    this.activeId = -1;
    this.clock = 0;
    this.wind = 0;
    this.winner = -2;
    this.ctrl = { dx: 0, ang: 30, weapon: 0, fuse: 3, chg: 0 };
    this.nextTurn();
  }

  // --- Ereignisse ----------------------------------------------------------
  emit(kind, ...args) { this.events.push([++this.seq, kind, ...args]); }
  takeEvents() { const e = this.events; this.events = []; return e; }

  staticInfo() {
    return {
      W: this.terrain.W, H: this.terrain.H, water: this.terrain.water, seed: this.seed,
      mode: this.mode, size: this.size, turnTime: this.turnTime,
      teams: this.teams.map((t) => ({ id: t.id, name: t.name, color: t.color, owner: t.owner })),
      figs: this.figures.map((f) => ({ id: f.id, team: f.team, name: f.name })),
    };
  }

  activeFig() { return this.figures[this.activeId] || null; }
  activeTeam() { const f = this.activeFig(); return f ? this.teams[f.team] : null; }

  snapshot() {
    const t = this.activeTeam();
    return {
      t: 'state', ph: this.phase, turn: this.turn, act: this.activeId,
      clock: Math.ceil(this.clock), wind: Math.round(this.wind * 100),
      // [id, x, y, hp, blickrichtung, zustand]  zustand: 0 steht, 1 läuft, 2 fliegt/fällt, 9 tot
      f: this.figures.map((f) => [f.id, Math.round(f.x), Math.round(f.y), f.hp, f.dir, f.alive ? (f.air ? 2 : f.walk ? 1 : 0) : 9]),
      aim: [this.ctrl.ang, this.ctrl.weapon, this.ctrl.chg, this.ctrl.fuse],
      // [id, art, x, y, vx, vy, zünder]
      p: this.projectiles.map((p) => [p.id, p.kind, Math.round(p.x), Math.round(p.y), Math.round(p.vx), Math.round(p.vy), p.fuse > 0 ? Math.ceil(p.fuse) : 0]),
      am: t ? t.ammo.slice() : [],
      ab: this.teams.map((x) => (x.gaveUp ? 2 : x.absent ? 1 : 0)),
    };
  }

  // --- Eingaben (der Aufrufer prüft, dass sie vom Spieler am Zug kommen) ----
  control(inp) {
    const c = this.ctrl;
    c.dx = clamp(inp.dx | 0, -1, 1);
    c.ang = clamp(inp.ang | 0, -90, 90);
    c.fuse = clamp(inp.fuse | 0 || 3, 1, 5);
    c.chg = this.phase === 'aim' ? clamp(inp.chg | 0, 0, 100) : 0;
    const w = inp.weapon | 0;
    const t = this.activeTeam();
    if (this.phase === 'aim' && t && w >= 0 && w < WEAPONS.length && t.ammo[w] !== 0) {
      c.weapon = w;
      t.weapon = w;
    }
  }

  jump() {
    const f = this.activeFig();
    if (!f || !f.alive || f.air) return;
    if (!['aim', 'shot', 'retreat'].includes(this.phase)) return;
    f.air = true;
    f.vy = -235;
    f.vx = f.dir * 105;
    f.walk = 0;
  }

  fire(pow) {
    const f = this.activeFig();
    const t = this.activeTeam();
    if (this.phase !== 'aim' || !f || !f.alive || f.air) return false;
    const wi = this.ctrl.weapon;
    const w = WEAPONS[wi];
    if (!w || t.ammo[wi] === 0) return false;
    if (t.ammo[wi] > 0) t.ammo[wi]--;
    pow = clamp(pow | 0, 0, 100);
    const a = (this.ctrl.ang * Math.PI) / 180;
    const dx = Math.cos(a) * f.dir, dy = -Math.sin(a);
    const cx = f.x, cy = f.y - 8;
    this.ctrl.chg = 0;
    this.phase = 'shot';
    this.phaseT = 0;
    f.walk = 0;
    this.emit('shot', wi, Math.round(cx), Math.round(cy));

    if (w.kind === 'ray') {
      let x = cx + dx * 6, y = cy + dy * 6;
      let hit = false;
      for (let s = 0; s < 1100; s++) {
        x += dx; y += dy;
        if (x < -50 || x > this.terrain.W + 50 || y > this.terrain.H || y < -400) break;
        if (this.terrain.solid(x, y) || this.figureAt(x, y, f.id)) { hit = true; break; }
      }
      this.emit('ray', Math.round(cx + dx * 8), Math.round(cy + dy * 8), Math.round(x), Math.round(y));
      if (hit) this.explosion(x, y, w.r, w.dmg, 1.4);
      return true;
    }
    if (w.kind === 'barrel') {
      this.projectiles.push({
        id: this.pid++, kind: 'barrel', x: f.x + f.dir * 7, y: f.y - 5, vx: f.dir * 30, vy: -40,
        fuse: w.fuseTime, r: w.r, dmg: w.dmg, wind: false, impact: false, bounce: 0.2, age: 0, owner: f.id, rest: false,
      });
      return true;
    }
    const sp = (MAX_SPEED * Math.max(5, pow)) / 100;
    this.projectiles.push({
      id: this.pid++, kind: w.kind, x: cx + dx * 9, y: cy + dy * 9, vx: dx * sp, vy: dy * sp,
      fuse: w.fuse ? this.ctrl.fuse : 0, r: w.r, dmg: w.dmg, wind: !!w.wind,
      impact: w.kind !== 'egg', bounce: w.bounce || 0, age: 0, owner: f.id, rest: false, sub: w.sub || 0,
    });
    return true;
  }

  setAbsent(teamId, v) {
    const t = this.teams[teamId];
    if (!t) return;
    t.absent = v;
    if (!v) t.absentT = 0;
    if (v && this.activeTeam() === t && this.phase === 'aim') this.toSettle();
  }

  // --- Simulation ----------------------------------------------------------
  update(dt) {
    for (const t of this.teams) {
      if (t.absent && !t.gaveUp) {
        t.absentT += dt;
        if (t.absentT > GIVE_UP_AFTER) { t.gaveUp = true; this.emit('gaveup', t.id); }
      }
    }
    if (this.phase === 'over') return;
    const act = this.activeFig();
    const canMove = this.phase === 'aim' || this.phase === 'shot' || this.phase === 'retreat';
    for (const f of this.figures) {
      if (!f.alive) continue;
      if (f === act && canMove && !f.air) this.walkFig(f, this.ctrl.dx, dt);
      else f.walk = 0;
      this.physFig(f, dt);
    }
    this.updateProjectiles(dt);

    switch (this.phase) {
      case 'aim':
        this.clock -= dt;
        if (this.clock <= 0) { this.clock = 0; this.emit('timeout'); this.toSettle(); }
        else if (!act || !act.alive) this.toSettle();
        break;
      case 'shot':
        this.phaseT += dt;
        if (!this.projectiles.length) {
          if (act && act.alive) { this.phase = 'retreat'; this.phaseT = RETREAT_TIME; }
          else this.toSettle();
        }
        break;
      case 'retreat':
        this.phaseT -= dt;
        if ((this.phaseT <= 0 || !act || !act.alive) && !this.projectiles.length) this.toSettle();
        break;
      case 'settle':
        this.phaseT += dt;
        if ((this.allResting() && !this.projectiles.length) || this.phaseT > SETTLE_MAX) {
          if (this.killDead()) this.phaseT = Math.min(this.phaseT, SETTLE_MAX - 2);
          else this.nextTurn();
        }
        break;
      case 'pause':
        this.phaseT -= dt;
        if (this.phaseT <= 0) this.nextTurn();
        break;
    }
  }

  toSettle() {
    this.phase = 'settle';
    this.phaseT = 0;
    this.ctrl.dx = 0;
    this.ctrl.chg = 0;
  }

  allResting() {
    return this.figures.every((f) => !f.alive || !f.air);
  }

  killDead() {
    let any = false;
    for (const f of this.figures) {
      if (f.alive && f.hp <= 0) {
        f.alive = false;
        any = true;
        this.emit('die', f.id, 0);
        const x = Math.round(f.x), y = Math.round(f.y - 6);
        this.terrain.carve(x, y, 14);
        this.emit('x', x, y, 14);
      }
    }
    return any;
  }

  nextTurn() {
    const aliveTeams = this.teams.filter((t) => !t.gaveUp && this.figures.some((f) => f.team === t.id && f.alive));
    if (aliveTeams.length <= 1) {
      this.phase = 'over';
      this.winner = aliveTeams.length ? aliveTeams[0].id : -1;
      this.emit('over', this.winner);
      return;
    }
    const n = this.teams.length;
    let team = null;
    for (let k = 1; k <= n; k++) {
      const t = this.teams[(this.teamIdx + k + n) % n];
      if (!t.gaveUp && !t.absent && this.figures.some((f) => f.team === t.id && f.alive)) {
        team = t;
        this.teamIdx = t.id;
        break;
      }
    }
    if (!team) {
      // Alle, die noch leben, sind gerade abwesend: kurz warten
      this.phase = 'pause';
      this.phaseT = 1;
      this.activeId = -1;
      return;
    }
    const figs = this.figures.filter((f) => f.team === team.id);
    for (let k = 1; k <= figs.length; k++) {
      const i = (team.figIdx + k) % figs.length;
      if (figs[i].alive) { team.figIdx = i; this.activeId = figs[i].id; break; }
    }
    this.wind = Math.round((this.rnd() * 2 - 1) * 100) / 100;
    this.turn++;
    this.phase = 'aim';
    this.clock = this.turnTime;
    this.ctrl.dx = 0;
    this.ctrl.chg = 0;
    this.ctrl.weapon = team.ammo[team.weapon] !== 0 ? team.weapon : 0;
    this.emit('turn', this.activeId, Math.round(this.wind * 100), this.terrain.hash(), this.turn);
  }

  // --- Figuren --------------------------------------------------------------
  // Figur: Füße auf Höhe y (erste feste Zeile darunter), Körper belegt Zeilen y-12 .. y-1 und Spalten x-3 .. x+3.
  bodyHit(x, y) {
    const t = this.terrain;
    const xi = Math.round(x), yi = Math.floor(y);
    for (let dy = 1; dy <= 12; dy += 2) {
      for (let dx = -3; dx <= 3; dx += 3) if (t.solid(xi + dx, yi - dy)) return true;
    }
    return t.solid(xi, yi - 12);
  }

  standing(x, y) {
    const t = this.terrain;
    const xi = Math.round(x), yi = Math.floor(y);
    return t.solid(xi, yi) || t.solid(xi - 2, yi) || t.solid(xi + 2, yi);
  }

  /** Steht auf Boden oder wird von etwas unter dem Körper gehalten. */
  supported(x, y) {
    return this.standing(x, y) || this.bodyHit(x, y + 1);
  }

  figureAt(x, y, exclude) {
    for (const f of this.figures) {
      if (!f.alive || f.id === exclude) continue;
      if (Math.abs(x - f.x) <= 6 && y >= f.y - 15 && y <= f.y + 1) return f;
    }
    return null;
  }

  walkFig(f, dx, dt) {
    if (!dx) { f.walk = 0; f.walkAcc = 0; return; }
    f.dir = dx;
    f.walk = 1;
    f.walkAcc += WALK_SPEED * dt;
    while (f.walkAcc >= 1) {
      f.walkAcc -= 1;
      const nx = f.x + dx;
      let moved = false;
      for (let c = 0; c <= 5; c++) {
        if (!this.bodyHit(nx, f.y - c)) { f.x = nx; f.y -= c; moved = true; break; }
      }
      if (!moved) { f.walkAcc = 0; break; }
      let k = 0;
      while (!this.standing(f.x, f.y) && k < 5) { f.y += 1; k++; }
      if (!this.standing(f.x, f.y)) {
        f.air = true;
        f.vx = dx * 45;
        f.vy = 0;
        break;
      }
    }
  }

  physFig(f, dt) {
    if (!f.air) {
      if (this.supported(f.x, f.y)) { f.vx = 0; f.vy = 0; return; }
      f.air = true;
      f.vy = 0;
    }
    f.vy = Math.min(900, f.vy + G * dt);
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(f.vx), Math.abs(f.vy)) * dt));
    for (let i = 0; i < n && f.air; i++) {
      const sx = (f.vx * dt) / n, sy = (f.vy * dt) / n;
      if (sx) {
        if (this.bodyHit(f.x + sx, f.y)) {
          if (!this.bodyHit(f.x + sx, f.y - 3) && f.vy >= 0) { f.x += sx; f.y -= 3; }
          else f.vx = -f.vx * 0.35;
        } else f.x += sx;
      }
      if (sy > 0) {
        const ny = f.y + sy;
        if (Math.floor(ny) !== Math.floor(f.y) && this.standing(f.x, ny)) {
          f.y = Math.floor(ny);
          this.land(f);
        } else if (this.bodyHit(f.x, ny)) {
          this.land(f); // seitlich auf einer Kante aufgesetzt
        } else f.y = ny;
      } else if (sy < 0) {
        if (this.bodyHit(f.x, f.y + sy)) f.vy = 0;
        else f.y += sy;
      }
      if (f.y > this.terrain.water + 8) {
        f.alive = false;
        f.hp = 0;
        f.air = false;
        this.emit('die', f.id, 1);
        this.emit('splash', Math.round(f.x));
        return;
      }
    }
  }

  land(f) {
    const imp = f.vy;
    if (imp > 380) {
      const d = Math.min(30, Math.round((imp - 380) / 9));
      if (d > 0) { f.hp = Math.max(0, f.hp - d); this.emit('dmg', f.id, d); }
    }
    if (Math.abs(f.vx) > 140 || imp > 460) {
      f.vy = -imp * 0.28;
      f.vx *= 0.55;
      if (Math.abs(f.vy) > 50) return;
    }
    f.air = false;
    f.vx = 0;
    f.vy = 0;
  }

  // --- Geschosse --------------------------------------------------------------
  normalAt(x, y) {
    let sx = 0, sy = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (this.terrain.solid(x + dx, y + dy)) { sx += dx; sy += dy; }
    }
    const l = Math.hypot(sx, sy);
    return l ? { x: -sx / l, y: -sy / l } : { x: 0, y: -1 };
  }

  updateProjectiles(dt) {
    const T = this.terrain;
    const keep = [];
    const born = [];
    for (const p of this.projectiles) {
      p.age += dt;
      let gone = false;
      if (p.fuse > 0) {
        p.fuse -= dt;
        if (p.fuse <= 0) { this.detonate(p, born); continue; }
      }
      if (p.rest) {
        if (T.solid(p.x, p.y + 2) || T.solid(p.x - 2, p.y + 2) || T.solid(p.x + 2, p.y + 2)) { keep.push(p); continue; }
        p.rest = false;
      }
      p.vy += G * dt;
      if (p.wind) p.vx += this.wind * WIND_ACC * dt;
      const sp = Math.hypot(p.vx, p.vy);
      const n = Math.max(1, Math.ceil((sp * dt) / 2));
      for (let i = 0; i < n; i++) {
        const nx = p.x + (p.vx * dt) / n, ny = p.y + (p.vy * dt) / n;
        if (ny > T.water) { this.emit('splash', Math.round(nx)); gone = true; break; }
        if (nx < -300 || nx > T.W + 300) { gone = true; break; }
        if (p.impact && this.figureAt(nx, ny, p.age < 0.15 ? p.owner : -1)) {
          p.x = nx; p.y = ny; this.detonate(p, born); gone = true; break;
        }
        if (T.solid(nx, ny)) {
          if (p.impact) { p.x = nx; p.y = ny; this.detonate(p, born); gone = true; break; }
          const nn = this.normalAt(nx, ny);
          const dot = p.vx * nn.x + p.vy * nn.y;
          if (dot < 0) { p.vx -= 2 * dot * nn.x; p.vy -= 2 * dot * nn.y; }
          p.vx *= p.bounce; p.vy *= p.bounce;
          if (Math.hypot(p.vx, p.vy) < 35) { p.rest = true; p.vx = 0; p.vy = 0; }
          break;
        }
        p.x = nx; p.y = ny;
      }
      if (!gone) keep.push(p);
    }
    this.projectiles = keep.concat(born);
  }

  detonate(p, born) {
    this.explosion(p.x, p.y, p.r, p.dmg, 1);
    if (p.sub) {
      for (let i = 0; i < p.sub; i++) {
        born.push({
          id: this.pid++, kind: 'seed', x: p.x, y: p.y - 4,
          vx: (this.rnd() - 0.5) * 320, vy: -160 - this.rnd() * 220,
          fuse: 0, r: SEED_KIND.r, dmg: SEED_KIND.dmg, wind: false, impact: true, bounce: 0, age: 0, owner: -1, rest: false, sub: 0,
        });
      }
    }
  }

  explosion(x, y, r, dmg, push) {
    x = Math.round(x); y = Math.round(y); r |= 0;
    this.terrain.carve(x, y, r);
    this.emit('x', x, y, r);
    const R = r + 12;
    for (const f of this.figures) {
      if (!f.alive) continue;
      const fx = f.x, fy = f.y - 7;
      const d = Math.hypot(fx - x, fy - y);
      if (d >= R) continue;
      const k = 1 - d / R;
      const amount = Math.max(1, Math.round(dmg * k));
      f.hp = Math.max(0, f.hp - amount);
      this.emit('dmg', f.id, amount);
      let nx = 0, ny = -1;
      if (d > 0.5) { nx = (fx - x) / d; ny = (fy - y) / d; }
      const kb = 380 * k * Math.min(1.7, dmg / 45) * push;
      f.vx += nx * kb;
      f.vy += ny * kb - 110 * k;
      f.air = true;
      f.walk = 0;
    }
    for (const p of this.projectiles) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d >= R || d < 0.5) continue;
      const k = 1 - d / R;
      p.vx += ((p.x - x) / d) * 300 * k;
      p.vy += ((p.y - y) / d) * 300 * k - 80 * k;
      p.rest = false;
    }
  }
}
