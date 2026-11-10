// Favourites persistence, constellation figures and Solar System geometry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCatalog, parseNames } from '../src/catalog.js';
import { Favourites, FAVOURITES_LIMIT } from '../src/favourites.js';
import { Constellations, magFade, solFade, LINE_ALPHA } from '../src/constellations.js';
import { SolarSystem, solarIntensity, parkingSide, ECLIPTIC_NORTH, SOLAR_OUTER_PC, SOLAR_INNER_PC, AU_PER_PC } from '../src/solar/system.js';
import { julianDay } from '../src/solar/astro.js';

const buf = readFileSync(new URL('../public/data/stars.bin', import.meta.url));
const cat = parseCatalog(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const names = parseNames(JSON.parse(readFileSync(new URL('../public/data/names.json', import.meta.url), 'utf8')));
const yale = JSON.parse(readFileSync(new URL('../tools/sources/yale/stars.json', import.meta.url), 'utf8'));
const idx = (n) => names.find((x) => x.name === n).index;

class MemoryStorage {
  constructor() { this.data = new Map(); }
  getItem(k) { return this.data.has(k) ? this.data.get(k) : null; }
  setItem(k, v) { this.data.set(k, String(v)); }
}

// ---------------------------------------------------------------- favourites
test('favourites persist, rename, remove and survive a reload', () => {
  const store = new MemoryStorage();
  const fav = new Favourites(cat, store);
  const vega = { kind: 'star', index: idx('Vega') };
  assert.equal(fav.has(vega), false);
  const it = fav.add(vega, 'Vega');
  assert.equal(fav.has(vega), true);
  assert.equal(fav.add(vega, 'Vega again'), it, 'no duplicates');
  fav.add({ kind: 'body', id: 'saturn' }, 'Saturn');
  fav.rename(it.id, '  My favourite star  ');
  const again = new Favourites(cat, store);
  assert.equal(again.items.length, 2);
  assert.equal(again.items[0].name, 'My favourite star');
  assert.equal(again.items[0].index, vega.index);
  assert.deepEqual(again.target(again.items[1]), { kind: 'body', id: 'saturn' });
  again.rename(again.items[0].id, '   ');
  assert.equal(again.items[0].name, 'Vega', 'empty rename restores the original name');
  again.remove(again.items[1].id);
  assert.equal(new Favourites(cat, store).items.length, 1);
});

test('favourites are capped and toggle cleanly', () => {
  const fav = new Favourites(cat, new MemoryStorage());
  for (let i = 0; i < FAVOURITES_LIMIT; i++) assert.ok(fav.add({ kind: 'star', index: 1000 + i }, `s${i}`));
  assert.equal(fav.add({ kind: 'star', index: 5 }, 'one too many'), null);
  assert.equal(fav.toggle({ kind: 'star', index: 1000 }, 's0'), false);
  assert.equal(fav.toggle({ kind: 'star', index: 5 }, 'now fits'), true);
});

test('favourites are found again by position after a catalogue rebuild', () => {
  const store = new MemoryStorage();
  const fav = new Favourites(cat, store);
  const deneb = idx('Deneb'), sirius = idx('Sirius');
  fav.add({ kind: 'star', index: deneb }, 'Deneb');
  fav.add({ kind: 'star', index: sirius }, 'Sirius');
  // Simulate a rebuilt catalogue: different dataId, stored indices now wrong.
  const saved = JSON.parse(store.getItem('starfield-flight.favourites.v1'));
  for (const it of saved.items) { it.data = 'older-catalogue'; it.index = 12; }
  store.setItem('starfield-flight.favourites.v1', JSON.stringify(saved));
  const reloaded = new Favourites(cat, store);
  assert.deepEqual(reloaded.items.map((i) => i.index), [deneb, sirius]);
  assert.equal(reloaded.items[0].data, cat.header.dataId, 're-stamped with the current catalogue');
});

// ---------------------------------------------------------------- constellations
const cons = new Constellations(JSON.parse(readFileSync(new URL('../public/data/constellations.json', import.meta.url), 'utf8')), cat);

test('all 88 constellations have figures made of real catalogue stars', () => {
  assert.equal(new Set(cons.con).size, 88);
  assert.equal(cons.count, 743);
  for (const i of cons.pairs) assert.ok(i < cat.count);
});

test('seen from the Sun, figure stars sit where the Yale catalogue puts them', () => {
  // Every endpoint direction from the Sun matches a Yale star within 1 arcminute.
  const dirs = yale.ra.map((ra, i) => {
    const a = ra * Math.PI / 180, d = yale.dec[i] * Math.PI / 180;
    return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
  });
  let worst = 0;
  for (const i of cons.stars) {
    const p = cat.position(i), l = Math.hypot(...p);
    const u = [p[0] / l, p[1] / l, p[2] / l];
    let best = -1;
    for (const v of dirs) best = Math.max(best, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]);
    worst = Math.max(worst, Math.acos(Math.min(1, best)) * 180 / Math.PI * 60);
  }
  assert.ok(worst < 1, `worst ${worst.toFixed(2)} arcmin`);
});

test('figures fade with star brightness and distance from the Sun', () => {
  assert.equal(magFade(4, 7.5), 1);
  assert.equal(magFade(8, 7.5), 0);
  assert.ok(magFade(6.9, 7.5) > 0 && magFade(6.9, 7.5) < 1);
  assert.equal(solFade(0), 1);
  assert.ok(Math.abs(solFade(5000 / 3.2616) - 0.2) < 1e-9);
  // Orion from home: the belt segments are fully drawn.
  const k = [...cons.con].findIndex((c, i) => cons.abbr[c] === 'Ori' && cons.segmentAlpha(i, [0, 0, 0], 7.5, 1) >= LINE_ALPHA - 1e-9);
  assert.ok(k >= 0);
});

// ---------------------------------------------------------------- solar system
test('Solar System mode fades in between 0.2 and 0.08 light-years', () => {
  assert.equal(solarIntensity(SOLAR_OUTER_PC * 1.01), 0);
  assert.equal(solarIntensity(SOLAR_INNER_PC * 0.99), 1);
  const mid = solarIntensity((SOLAR_OUTER_PC + SOLAR_INNER_PC) / 2);
  assert.ok(mid > 0.4 && mid < 0.6);
});

test('bodies, co-moving neighbourhoods, collisions and the home parking spot', () => {
  const ss = new SolarSystem();
  ss.update(julianDay(Date.UTC(2026, 10, 9, 12)));
  const earth = ss.get('earth'), moon = ss.get('moon'), jupiter = ss.get('jupiter');
  const em = Math.hypot(moon.pos[0] - earth.pos[0], moon.pos[1] - earth.pos[1], moon.pos[2] - earth.pos[2]) * 149597870.7;
  assert.ok(em > 356000 && em < 407000, `Earth-Moon ${em.toFixed(0)} km`);
  const re = Math.hypot(...earth.pos);
  assert.ok(re > 0.98 && re < 1.02);
  // Near the Moon you move with the Moon, near the Earth with the Earth, between planets with the Sun.
  assert.equal(ss.frameBody(moon.pos.map((x, i) => x + (i === 0 ? 0.0001 : 0)))?.id, 'moon');
  assert.equal(ss.frameBody(earth.pos.map((x, i) => x + (i === 1 ? 0.005 : 0)))?.id, 'earth');
  assert.equal(ss.frameBody([3, 0, 0]), null);
  // Collisions: a point inside Jupiter is pushed to its surface.
  const p = [...jupiter.pos];
  assert.ok(ss.keepOutside(p));
  const r = Math.hypot(p[0] - jupiter.pos[0], p[1] - jupiter.pos[1], p[2] - jupiter.pos[2]);
  assert.ok(Math.abs(r / jupiter.Req - 1.02) < 1e-6);
  // Home: 6 AU from the Sun on the line of approach, lifted to 25 degrees when that line
  // lies near the planets' plane (test/flight.test.mjs covers the whole range).
  const elevOf = (p) => Math.asin((p[0] * ECLIPTIC_NORTH[0] + p[1] * ECLIPTIC_NORTH[1] + p[2] * ECLIPTIC_NORTH[2]) / Math.hypot(...p)) * 180 / Math.PI;
  const steep = [400000, -300000, 400000];
  const onLine = ss.homeParking(steep);
  assert.ok(Math.abs(Math.hypot(...onLine) - 6) < 1e-9);
  assert.ok(elevOf(steep) > 33 && Math.abs(elevOf(onLine) - elevOf(steep)) < 1e-9, 'a steep approach parks on its own line');
  const flat = [400000, -300000 * Math.cos(23.4392911 * Math.PI / 180), -300000 * Math.sin(23.4392911 * Math.PI / 180)];
  const lifted = ss.homeParking(flat);
  assert.ok(Math.abs(elevOf(flat)) < 1e-6 && Math.abs(elevOf(lifted) - 25) < 1e-6, `an approach in the plane is lifted to ${elevOf(lifted)} deg`);
  assert.ok(lifted[0] * flat[0] + lifted[1] * flat[1] + lifted[2] * flat[2] > 0, 'on the side the ship comes from');
  void AU_PER_PC;
});

test('magnitudes: planets look as bright as they do from Earth', () => {
  const ss = new SolarSystem();
  ss.update(julianDay(Date.UTC(2026, 10, 9, 12)));
  const earth = ss.get('earth').pos;
  const m = (id) => ss.magnitude(ss.get(id), earth);
  assert.ok(m('sun') > -26.9 && m('sun') < -26.6, `Sun ${m('sun')}`);
  assert.ok(m('venus') < -3.3 && m('venus') > -4.9, `Venus ${m('venus')}`);
  assert.ok(m('jupiter') < -1.6 && m('jupiter') > -3.0, `Jupiter ${m('jupiter')}`);
  assert.ok(m('neptune') > 7.6 && m('neptune') < 8.1, `Neptune ${m('neptune')}`);
  // Body frames are orthonormal rotations.
  for (const b of ss.bodies) {
    const f = ss.bodyFrame(b);
    const row = (i) => [f[i * 3], f[i * 3 + 1], f[i * 3 + 2]];
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(Math.hypot(...row(i)) - 1) < 1e-9, b.id);
    const x = row(0), y = row(1);
    assert.ok(Math.abs(x[0] * y[0] + x[1] * y[1] + x[2] * y[2]) < 1e-9, b.id);
  }
});

test('the autopilot parks on the sunlit side of a planet without crossing it', () => {
  const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180 / Math.PI;
  const unit = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
  const jupiter = [-3.1, 3.9, 1.75];
  const sunward = unit(jupiter.map((x) => -x));
  const stop = 4.5 * 71492 / 149597870.7;
  for (const ship of [[-3.1 - 40, 3.9 + 20, 1.75], [0.2, 0.3, 0.1], [-2000, 9000, 4000], [-3.1 + 0.02, 3.9 - 0.01, 1.75 + 0.03]]) {
    const d = parkingSide(jupiter, ship);
    assert.ok(Math.abs(Math.hypot(...d) - 1) < 1e-12);
    const u = unit(ship.map((x, i) => x - jupiter[i]));
    assert.ok(ang(d, u) <= 75 + 1e-9, `within 75 degrees of the approach (${ang(d, u).toFixed(1)})`);
    // the straight path from the ship to the parking point stays clear of the planet
    const P = jupiter.map((x, i) => x + d[i] * stop);
    let closest = Infinity;
    for (let k = 0; k <= 2000; k++) {
      const t = k / 2000, q = ship.map((x, i) => x + (P[i] - x) * t);
      closest = Math.min(closest, Math.hypot(q[0] - jupiter[0], q[1] - jupiter[1], q[2] - jupiter[2]));
    }
    assert.ok(closest > stop * 0.999, `closest ${(closest / stop).toFixed(3)} x the parking distance`);
  }
  // arriving from the Sun's side: parked about 35-45 degrees off the Sun line, lit
  const lit = parkingSide(jupiter, [0.2, 0.3, 0.1]);
  const phase = ang(lit, sunward);
  assert.ok(phase > 25 && phase < 50, `phase ${phase.toFixed(1)} deg`);
  // arriving from the night side: as far round towards the Sun as the path allows
  const night = parkingSide(jupiter, jupiter.map((x) => x * 1.5));
  assert.ok(ang(night, sunward) < 120, `turned towards the light (${ang(night, sunward).toFixed(1)} deg)`);
});
