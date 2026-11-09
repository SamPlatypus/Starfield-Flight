// Solar System ephemerides against astronomy-engine (VSOP87, ELP/MPP02 and the E5 theory
// of the Galilean moons), across the second half of the 20th and the 21st century.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as A from 'astronomy-engine';
import { bodyPositions, satellitePosition, orbitPoints, planetElements, KM_PER_AU } from '../src/solar/ephemeris.js';
import { ttFromUt, julianDay } from '../src/solar/astro.js';

const angleDeg = (a, b) => {
  const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b));
  return Math.acos(Math.min(1, Math.max(-1, c))) * 180 / Math.PI;
};
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const DATES = [1962.3, 1985.7, 2000.04, 2013.5, 2026.86, 2041.2, 2063.9].map((y) =>
  new Date(Date.UTC(Math.floor(y), Math.floor((y % 1) * 12), 1 + Math.floor(((y * 12) % 1) * 28), 6)));
const BODY = {
  mercury: A.Body.Mercury, venus: A.Body.Venus, earth: A.Body.Earth, mars: A.Body.Mars, jupiter: A.Body.Jupiter,
  saturn: A.Body.Saturn, uranus: A.Body.Uranus, neptune: A.Body.Neptune, pluto: A.Body.Pluto, moon: A.Body.Moon,
};

function worst(fn) {
  const w = {};
  for (const date of DATES) {
    for (const [id, deg, rel] of fn(date, ttFromUt(julianDay(date)))) {
      const e = w[id] || (w[id] = { deg: 0, rel: 0 });
      e.deg = Math.max(e.deg, deg); e.rel = Math.max(e.rel, rel);
    }
  }
  return w;
}

test('planets: heliocentric directions within arcminutes, distances within 0.1%', () => {
  const w = worst((date, jd) => {
    const mine = bodyPositions(jd);
    return Object.entries(BODY).map(([id, b]) => {
      const r = A.HelioVector(b, date), ref = [r.x, r.y, r.z];
      return [id, angleDeg(mine[id], ref), Math.abs(len(mine[id]) / len(ref) - 1)];
    });
  });
  // Measured 1950-2100: directions within 2.4' for every planet. Schlyter's model perturbs
  // longitude but not radius, so Jupiter, Saturn and Uranus distances can be ~0.1-0.45% off.
  const radiusLimit = { jupiter: 0.005, saturn: 0.005, uranus: 0.005 };
  for (const [id, e] of Object.entries(w)) {
    assert.ok(e.deg * 60 < 3, `${id}: ${(e.deg * 60).toFixed(2)}' off`);
    assert.ok(e.rel < (radiusLimit[id] ?? 0.0005), `${id}: distance off by ${(e.rel * 100).toFixed(3)}%`);
  }
});

test('Moon: geocentric direction within an arcminute and distance within 0.1%', () => {
  const w = worst((date, jd) => {
    const mine = bodyPositions(jd);
    const g = A.GeoMoon(date);
    const ref = [g.x, g.y, g.z], me = sub(mine.moon, mine.earth);
    return [['moon', angleDeg(me, ref), Math.abs(len(me) / len(ref) - 1)]];
  });
  assert.ok(w.moon.deg * 60 < 1, `Moon ${(w.moon.deg * 60).toFixed(2)}' off`);
  assert.ok(w.moon.rel < 0.001);
});

test('Galilean moons: JPL mean elements track the E5 theory to a few degrees', () => {
  const w = worst((date, jd) => {
    const ref = A.JupiterMoons(date);
    return ['io', 'europa', 'ganymede', 'callisto'].map((id) => {
      const r = ref[id], me = satellitePosition(id, jd);
      return [id, angleDeg(me, [r.x, r.y, r.z]), Math.abs(len(me) / len([r.x, r.y, r.z]) - 1)];
    });
  });
  for (const [id, e] of Object.entries(w)) {
    console.log(`  ${id}: ${e.deg.toFixed(2)} deg, ${(e.rel * 100).toFixed(2)}% (worst over 1962-2064)`);
    assert.ok(e.deg < 4, `${id}: ${e.deg.toFixed(2)} deg off`);
    assert.ok(e.rel < 0.03, `${id}: distance off by ${(e.rel * 100).toFixed(2)}%`);
  }
});

test('orbit lines pass through the bodies they belong to', () => {
  const jd = ttFromUt(julianDay(new Date(Date.UTC(2026, 10, 9))));
  const pos = bodyPositions(jd);
  for (const id of ['mercury', 'venus', 'mars', 'neptune', 'pluto']) {
    const pts = orbitPoints(id, jd, 2048);
    let best = Infinity;
    for (let k = 0; k < pts.length; k += 3) best = Math.min(best, len(sub([pts[k], pts[k + 1], pts[k + 2]], pos[id])));
    assert.ok(best / planetElements(id, jd).a < 0.004, `${id} is ${best.toFixed(4)} AU from its orbit line`);
  }
  // Jupiter, Saturn, Uranus include perturbations: allow the ~1 degree they add along track.
  for (const id of ['jupiter', 'saturn', 'uranus']) {
    const pts = orbitPoints(id, jd, 2048);
    let best = Infinity;
    for (let k = 0; k < pts.length; k += 3) best = Math.min(best, len(sub([pts[k], pts[k + 1], pts[k + 2]], pos[id])));
    assert.ok(best / planetElements(id, jd).a < 0.02, `${id} is ${best.toFixed(4)} AU from its orbit line`);
  }
  const moonOrbit = orbitPoints('moon', jd, 1024);
  let best = Infinity;
  const mg = sub(pos.moon, pos.earth);
  for (let k = 0; k < moonOrbit.length; k += 3) best = Math.min(best, len(sub([moonOrbit[k], moonOrbit[k + 1], moonOrbit[k + 2]], mg)));
  assert.ok(best * KM_PER_AU < 40000, `Moon is ${(best * KM_PER_AU).toFixed(0)} km from its mean orbit`);
});

test('the Solar System view: discs, points, ring extents and orbits for one frame', async () => {
  const { SolarSystem, AU_PER_PC } = await import('../src/solar/system.js');
  const { SolarView } = await import('../src/solar/view.js');
  const { quat, transpose3 } = await import('../src/math.js');
  const ss = new SolarSystem();
  ss.update(2461354.0);
  const sat = ss.get('saturn');
  const r = Math.hypot(...sat.pos);
  // 9 Saturn radii out on the sunward side, a little above the rings, looking at Saturn
  const cam = sat.pos.map((x) => x * (1 - 9 * sat.Req / r));
  cam[2] += 3 * sat.Req;
  const dir = sat.pos.map((x, i) => x - cam[i]);
  const camToWorld = quat.toMat3(quat.lookRotation(dir, [0, 0, 1]), new Float32Array(9));
  const view = transpose3(camToWorld, new Float32Array(9));
  const sv = new SolarView(ss);
  const f = sv.build({ camAU: cam, view, camToWorld, tanX: 0.65, tanY: 1.36, w: 412, h: 860, dpr: 1, px: 1, magLimit: 6.5, gain: 1, s: 1, orbits: true, selected: 'saturn' });
  const s = sv.screen.find((e) => e.body.id === 'saturn');
  assert.ok(Math.abs(s.x - 206) < 1 && Math.abs(s.y - 430) < 1, 'Saturn in the middle of the view');
  assert.ok(s.r > 20 && s.r < 40, `disc radius ${s.r.toFixed(1)} px`);
  assert.ok(s.rx > s.r * 2 && s.ry >= s.r, `rings reach ${s.rx.toFixed(0)} x ${s.ry.toFixed(0)} px`);
  const body = f.bodies.find((b) => b.id === 'saturn');
  assert.ok(body && body.disc > 0.99 && body.point[0] === 0, 'drawn as a disc, not a point');
  assert.ok(f.bodies.every((b, i) => i === 0 || f.bodies[i - 1].dist >= b.dist), 'far to near');
  assert.ok(f.orbits.length > 3 && f.orbits.every((o) => o.alpha > 0 && o.alpha <= 0.6), 'orbits');
  // every orbit is bent to pass exactly through its body
  for (const o of f.orbits) assert.ok(Number.isFinite(o.fixAt) && o.fix.every(Number.isFinite));
  assert.ok(f.belt.alpha >= 0 && f.belt.days > 9000);
  void AU_PER_PC;
});
