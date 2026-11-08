import test from 'node:test';
import assert from 'node:assert/strict';
import { Terrain, generateTerrain, mulberry32, MAP_SIZES } from '../js/terrain.js';
import { Game, WEAPONS, TICK } from '../js/game.js';

test('Krater ergeben in zwei Masken dieselbe Prüfsumme', () => {
  const [W, H] = MAP_SIZES.klein;
  const a = generateTerrain({ W, H, mode: 'hoehlen', seed: 42 });
  const b = Terrain.decode(a.encode(), W, H);
  assert.equal(a.hash(), b.hash());
  for (const [x, y, r] of [[100, 300, 40], [700, 500, 20], [1399, 0, 70]]) { a.carve(x, y, r); b.carve(x, y, r); }
  assert.equal(a.hash(), b.hash());
  b.carve(500, 500, 10);
  assert.notEqual(a.hash(), b.hash());
});

test('RLE über Base64 hin und zurück', () => {
  const [W, H] = MAP_SIZES.gross;
  for (const mode of ['huegel', 'inseln', 'hoehlen']) {
    const a = generateTerrain({ W, H, mode, seed: 7 });
    const s = a.toB64();
    assert.ok(s.length < 200000, `${mode}: ${s.length} Zeichen`);
    assert.equal(Terrain.fromB64(s, W, H).hash(), a.hash());
  }
});

test('Höhlen-Modus erzeugt wirklich Hohlräume unter der Oberfläche', () => {
  const [W, H] = MAP_SIZES.mittel;
  const t = generateTerrain({ W, H, mode: 'hoehlen', seed: 3 });
  let caves = 0;
  for (let x = 0; x < W; x += 5) {
    let seenSolid = false;
    for (let y = 0; y < t.water; y++) {
      const s = t.solid(x, y);
      if (s) seenSolid = true;
      else if (seenSolid) { caves++; break; }
    }
  }
  assert.ok(caves > W / 5 / 10, `nur ${caves} Spalten mit Höhle`);
});

test('Komplette Partie mit zufälligen Schüssen endet', () => {
  for (const mode of ['huegel', 'inseln', 'hoehlen']) {
    for (let s = 1; s <= 4; s++) {
      const teams = [0, 1, 2].map((i) => ({ name: 'T' + i, owner: 0 }));
      const g = new Game(teams, { perTeam: 3, size: 'klein', mode, seed: s * 977, turnTime: 20 });
      const rnd = mulberry32(s);
      let steps = 0, lastTurn = -1, fireAt = 0;
      while (g.phase !== 'over' && steps < 60 * 60 * 60) {
        if (g.phase === 'aim' && g.turn !== lastTurn) { lastTurn = g.turn; fireAt = steps + 30 + Math.floor(rnd() * 90); }
        if (g.phase === 'aim') {
          const w = Math.floor(rnd() * WEAPONS.length);
          g.control({ dx: steps < fireAt - 20 ? (rnd() < 0.5 ? -1 : 1) : 0, ang: Math.floor(rnd() * 120) - 30, weapon: w, fuse: 3 });
          if (steps === fireAt) g.fire(40 + rnd() * 60);
        }
        g.update(TICK);
        g.takeEvents();
        steps++;
      }
      assert.equal(g.phase, 'over', `${mode}/${s}: nach ${g.turn} Zügen nicht vorbei`);
      for (const f of g.figures) assert.ok(Number.isFinite(f.x) && Number.isFinite(f.y));
    }
  }
});

test('Vorschläge für Name, Raum und Passwort', async () => {
  const { NAMES, ROOMS, randomName, randomRoom, randomPassword } = await import('../js/defaults.js');
  const { slug } = await import('../js/net.js');
  assert.equal(new Set(NAMES).size, 100);
  assert.equal(new Set(ROOMS).size, 100);
  for (const n of NAMES) assert.ok(n.length <= 16, n);
  for (const r of ROOMS) assert.ok(r.length <= 32 && slug(r), r);
  assert.ok(NAMES.includes(randomName()));
  assert.ok(ROOMS.includes(randomRoom()));
  for (let i = 0; i < 50; i++) assert.match(randomPassword(), /^\d{3}\.[a-z]{3}$/);
});
