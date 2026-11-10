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

test('orbits show while they read as rings: in from a speck, out again when far larger than the view', async () => {
  const { SolarSystem, ECLIPTIC_NORTH } = await import('../src/solar/system.js');
  const { SolarView, ringFade } = await import('../src/solar/view.js');
  const { quat, transpose3 } = await import('../src/math.js');
  const PLANET = [0.055, 0.19], MOON = [0.11, 0.31];

  // the fade itself: 0 for a speck, 1 while it reads as a ring, 0 again when huge
  assert.equal(ringFade(0.05, PLANET), 0);
  assert.equal(ringFade(0.2, PLANET), 1);
  assert.equal(ringFade(3, PLANET), 1);
  assert.equal(ringFade(10, PLANET), 0);
  assert.equal(ringFade(40, PLANET), 0);
  assert.equal(ringFade(40, PLANET, true), 1, 'a selected ring is kept however large');
  assert.equal(ringFade(0.15, MOON) < ringFade(0.15, PLANET), true, 'moon orbits come in later');
  let prev = 0, peaked = false;
  for (let r = 0.03; r < 15; r *= 1.05) {
    const v = ringFade(r, PLANET);
    assert.ok(Math.abs(v - prev) < 0.12, `no jump at ${r.toFixed(2)}`);
    if (v < prev) peaked = true;
    assert.ok(peaked ? v <= prev + 1e-12 : v >= prev, 'rises once, then falls once');
    prev = v;
  }

  const ss = new SolarSystem();
  ss.update(2461354.6);
  const sv = new SolarView(ss);
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const frame = (cam, lookAt, opts = {}) => {
    const camToWorld = quat.toMat3(quat.lookRotation(sub(lookAt, cam), ECLIPTIC_NORTH), new Float32Array(9));
    const f = sv.build({ camAU: cam, view: transpose3(camToWorld, new Float32Array(9)), camToWorld, tanX: 0.6494, tanY: 1.4431, w: 720, h: 1600,
      dpr: 2, px: 1.56, magLimit: 7, gain: 1, s: 1, orbits: true, selected: null, ...opts });
    return { alpha: Object.fromEntries(f.orbits.map((o) => [o.id, o.alpha])), host: f.host, belt: f.belt.alpha };
  };
  const up = (au, elevDeg) => { // a point `au` from the Sun, `elevDeg` above the planets' plane
    const e = elevDeg * Math.PI / 180, n = ECLIPTIC_NORTH;
    return [Math.cos(e) * au + n[0] * Math.sin(e) * au, n[1] * Math.sin(e) * au, n[2] * Math.sin(e) * au];
  };

  // 5,000 AU out: nothing yet. 400 AU: the outer planets' rings are coming in, the inner ones are specks.
  assert.deepEqual(frame(up(5000, 35), [0, 0, 0]).alpha, {});
  const far = frame(up(400, 35), [0, 0, 0]);
  assert.ok(far.alpha.neptune > 0.05 && far.alpha.neptune < 0.38 && far.alpha.pluto > far.alpha.neptune, 'outer rings fading in');
  assert.ok(!('earth' in far.alpha) && !('io' in far.alpha), 'inner rings and moons are still specks');
  assert.equal(far.belt, 0);

  // Home, 6 AU out: the rings from Earth's to Saturn's in full, Mercury's still small, Neptune's
  // and Pluto's too large to read
  const home = frame(up(6, 35), [0, 0, 0]);
  for (const id of ['earth', 'mars', 'jupiter', 'saturn']) assert.ok(Math.abs(home.alpha[id] - 0.38) < 1e-6, `${id} ring in full at home (${home.alpha[id]})`);
  assert.ok(home.alpha.mercury > 0.03 && home.alpha.mercury < home.alpha.venus && home.alpha.venus <= 0.38, 'the innermost rings are still coming in');
  assert.ok(home.alpha.uranus > 0.1 && home.alpha.uranus < 0.3, `Uranus fading out (${home.alpha.uranus})`);
  assert.ok((home.alpha.neptune ?? 0) < 0.06 && !('pluto' in home.alpha), 'Neptune and Pluto all but gone');
  assert.equal(home.host, 0);
  assert.ok(home.belt > 0.3, 'the belt shows');

  // Parked 4.5 radii from Jupiter, inside all its moons' orbits
  const j = ss.get('jupiter');
  const park = sub(j.pos, j.pos.map((x) => x * 4.5 * j.Req / Math.hypot(...j.pos))).map((x, i) => x + ECLIPTIC_NORTH[i] * 1.5 * j.Req);
  const atJ = frame(park, j.pos);
  assert.equal(atJ.host, 1, 'deep in Jupiter\'s own system');
  assert.ok(atJ.alpha.io > 0.2 && atJ.alpha.europa > 0.15, 'the inner moons\' orbits read as rings');
  assert.ok(!('callisto' in atJ.alpha) || atJ.alpha.callisto < 0.05, 'Callisto\'s is far larger than the view');
  assert.ok(!('neptune' in atJ.alpha) && !('pluto' in atJ.alpha), 'so are Neptune\'s and Pluto\'s');
  for (const id of ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn']) {
    if (id in atJ.alpha) assert.ok(atJ.alpha[id] <= 0.38 * 0.4 + 1e-6, `the Sun's rings step back at a planet: ${id} ${atJ.alpha[id].toFixed(3)}`);
  }
  // all told far less line on screen than every ring in full (4 moons at 0.3 + 9 edge-on rings at 0.11 = 2.2)
  const ink = Object.values(atJ.alpha).reduce((a, b) => a + b, 0);
  assert.ok(ink > 0.5 && ink < 1.1, `total ring opacity at Jupiter ${ink.toFixed(2)}`);
  assert.ok(Object.values(atJ.alpha).every((a) => a >= 0.03 * 0.3 - 1e-9), 'nothing is drawn too faint to see');
  // selecting one brings it back in full, however large
  const sel = frame(park, j.pos, { selected: 'neptune' });
  assert.ok(sel.alpha.neptune > 0.15, `a selected ring shows (${sel.alpha.neptune})`);

  // crossing into Jupiter's neighbourhood nothing jumps: the step back starts from nothing at its edge
  const out = (k) => j.pos.map((x, i) => x + ECLIPTIC_NORTH[i] * j.region * k);
  assert.equal(frame(out(1.2), j.pos).host, 0);
  assert.equal(frame(out(1.0), j.pos).host, 0);
  assert.ok(frame(out(0.9), j.pos).host < 0.02 && frame(out(0.5), j.pos).host > 0.1);

  // the same view at a lower render resolution shows the same rings
  const lo = (() => {
    const cam = up(6, 35), camToWorld = quat.toMat3(quat.lookRotation(sub([0, 0, 0], cam), ECLIPTIC_NORTH), new Float32Array(9));
    const f = sv.build({ camAU: cam, view: transpose3(camToWorld, new Float32Array(9)), camToWorld, tanX: 0.6494, tanY: 1.4431, w: 396, h: 880,
      dpr: 1.1, px: 1, magLimit: 7, gain: 1, s: 1, orbits: true, selected: null });
    return { alpha: Object.fromEntries(f.orbits.map((o) => [o.id, o.alpha])), belt: f.belt.alpha };
  })();
  assert.deepEqual(Object.keys(lo.alpha).sort(), Object.keys(home.alpha).sort());
  for (const id of Object.keys(lo.alpha)) assert.ok(Math.abs(lo.alpha[id] - home.alpha[id]) < 1e-9, `${id} unchanged by the render scale`);
  assert.ok(Math.abs(lo.belt - home.belt) < 1e-9);
});
