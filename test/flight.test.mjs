// Flight model: throttle mapping, steering, levelling, boost and the Sol autopilot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ship, throttleToSpeed, speedToThrottle, BOOST_FACTOR } from '../src/flight.js';
import { quat, v3, GALACTIC_NORTH } from '../src/math.js';

const DT = 1 / 60;
let seed = 99;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const angle = (a, b) => Math.acos(Math.min(1, Math.max(-1, v3.dot(v3.norm(a), v3.norm(b)))));

test('throttle and speed map onto each other', () => {
  assert.equal(throttleToSpeed(0), 0);
  assert.equal(throttleToSpeed(0.01), 0);
  for (const t of [0.05, 0.3, 0.55, 0.8, 1]) {
    assert.ok(Math.abs(speedToThrottle(throttleToSpeed(t)) - t) < 1e-9);
  }
  assert.ok(throttleToSpeed(1) / throttleToSpeed(0.03) > 1000, 'covers several orders of magnitude');
});

test('the autopilot flies home from anywhere and parks without overshooting', () => {
  for (let k = 0; k < 12; k++) {
    const ship = new Ship();
    const r = [0.05, 0.5, 3, 30, 300, 2000][k % 6] * (0.7 + rnd() * 0.6);
    ship.pos = v3.scale(v3.norm([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]), r);
    ship.lookAlong(v3.norm([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5])); // any heading, even away from home
    ship.throttle = rnd();
    ship.speed = throttleToSpeed(ship.throttle);
    ship.goHome();
    const stop = ship.target.stop;
    let arrived = null, minDist = Infinity, t = 0;
    for (; t < 60 && !arrived; t += DT) {
      ship.update(DT);
      minDist = Math.min(minDist, v3.len(ship.pos));
      arrived = ship.events.find((e) => e.type === 'arrived');
    }
    assert.ok(arrived, `no arrival from ${r.toFixed(2)} pc`);
    assert.ok(t < 30, `took ${t.toFixed(1)} s from ${r.toFixed(1)} pc`);
    const d = v3.len(ship.pos);
    assert.ok(Math.abs(d - stop) < 0.002, `parked at ${d} pc, wanted ${stop}`);
    assert.ok(minDist > stop * 0.9, `came within ${minDist} pc of the Sun`);
    assert.equal(ship.speed, 0);
    for (let s = 0; s < 3; s += DT) ship.update(DT); // settles its turn after parking
    assert.ok(angle(ship.forward, v3.scale(ship.pos, -1)) < 0.01, 'facing the Sun after arrival');
    assert.ok(Math.abs(v3.len(ship.pos) - stop) < 0.002, 'and stays parked');
  }
});

test('tap-to-turn: the ship swings onto a direction and releases it', () => {
  const ship = new Ship();
  ship.lookAlong([1, 0, 0], [0, 0, 1]);
  const goal = v3.norm([0, 1, 0.3]);
  ship.setTarget({ kind: 'dir', dir: goal });
  for (let t = 0; t < 4; t += DT) ship.update(DT);
  assert.ok(angle(ship.forward, goal) < 0.01, `still ${angle(ship.forward, goal)} rad off`);
  assert.equal(ship.target, null, 'target released once aligned');
});

test('manual steering overrides a target and turns the right way', () => {
  const ship = new Ship();
  ship.level = false;
  ship.lookAlong([0, 0, -1], [0, 1, 0]);
  ship.setTarget({ kind: 'dir', dir: [1, 0, 0] });
  ship.steer = [1, 0]; // right
  ship.update(DT);
  assert.equal(ship.target, null);
  for (let t = 0; t < 0.5; t += DT) ship.update(DT);
  assert.ok(ship.forward[0] > 0.1, 'turned right');
  ship.steer = [0, 1]; // up
  const before = ship.forward[1];
  for (let t = 0; t < 0.5; t += DT) ship.update(DT);
  assert.ok(ship.forward[1] > before + 0.1, 'pitched up');
});

test('levelling brings galactic north to the top of the view', () => {
  const ship = new Ship();
  // Look along the galactic plane, rolled 70 degrees.
  const fwd = v3.norm(v3.cross(GALACTIC_NORTH, [1, 0, 0]));
  ship.lookAlong(fwd);
  ship.q = quat.mul(ship.q, quat.fromAxisAngle([0, 0, 1], 1.2));
  for (let t = 0; t < 8; t += DT) ship.update(DT);
  const upErr = angle(ship.up, GALACTIC_NORTH);
  assert.ok(upErr < 0.03, `up is ${upErr} rad from galactic north`);
});

test('boost multiplies speed while held and eases off after', () => {
  const ship = new Ship();
  ship.throttle = 0.5;
  for (let t = 0; t < 4; t += DT) ship.update(DT);
  const cruise = ship.speed;
  assert.ok(Math.abs(cruise - throttleToSpeed(0.5)) / cruise < 0.02);
  ship.boostHeld = true;
  for (let t = 0; t < 3; t += DT) ship.update(DT);
  assert.ok(Math.abs(ship.speed / cruise - BOOST_FACTOR) < 0.4, `boosted ${ship.speed / cruise}x`);
  ship.boostHeld = false;
  for (let t = 0; t < 5; t += DT) ship.update(DT);
  assert.ok(Math.abs(ship.speed / cruise - 1) < 0.05);
});

test('position integrates in float64 far from the Sun', () => {
  const ship = new Ship();
  ship.pos = [3000, -2000, 1000];
  ship.lookAlong([1, 0, 0], [0, 0, 1]);
  ship.throttle = 0.03;
  ship.speed = throttleToSpeed(0.03);
  const x0 = ship.pos[0];
  for (let k = 0; k < 600; k++) ship.update(DT);
  // ~10 s at ~0.0036 pc/s: a float32 would lose most of these tiny steps at x = 3000 pc
  assert.ok(ship.pos[0] - x0 > 0.02, `moved ${ship.pos[0] - x0} pc`);
});

// ---------------------------------------------------------------- Solar System scales
const AU = 1 / 206264.80624709636; // pc
import { SolarSystem, ECLIPTIC_NORTH, SOLAR_OUTER_PC, solarSpeedCap, parkingSide } from '../src/solar/system.js';

const DEG = Math.PI / 180;
// A direction `elev` degrees above the ecliptic at compass angle `az` round it.
const EX = v3.norm(v3.cross(ECLIPTIC_NORTH, [0, 1, 0])), EY = v3.cross(ECLIPTIC_NORTH, EX);
const eclipticDir = (elev, az = 40) => v3.norm(v3.add(
  v3.scale(v3.add(v3.scale(EX, Math.cos(az * DEG)), v3.scale(EY, Math.sin(az * DEG))), Math.cos(elev * DEG)),
  v3.scale(ECLIPTIC_NORTH, Math.sin(elev * DEG))));
const elevation = (p) => Math.asin(Math.max(-1, Math.min(1, v3.dot(v3.norm(p), ECLIPTIC_NORTH)))) / DEG;

test('home is on the line of approach; only a near edge-on approach is lifted, on its own side', () => {
  const ss = new SolarSystem();
  for (const [elev, want] of [[90, 90], [75, 75], [40, 40], [33, 33], [25, 27], [17, 25], [5, 25], [0, 25], [-5, -25], [-25, -27], [-40, -40], [-90, -90]]) {
    for (const dist of [0.5, 30, 5e6]) { // AU: inside the parking distance, among the planets, 80 ly out
      const u = eclipticDir(elev, 200);
      const park = ss.homeParking(v3.scale(u, dist));
      assert.ok(Math.abs(v3.len(park) - 6) < 1e-9, '6 AU from the Sun');
      assert.ok(Math.abs(elevation(park) - want) < 1e-6, `from ${elev} deg: parked at ${elevation(park).toFixed(3)}, wanted ${want}`);
      // same compass direction, so the lift is the whole of the turn off the line of approach
      assert.ok(Math.abs(angle(park, u) / DEG - Math.abs(want - elev)) < 1e-6, `${(angle(park, u) / DEG).toFixed(3)} deg off the line of approach`);
    }
  }
  // Steeper than 33 degrees the parking point is exactly on the line of approach.
  for (let k = 0; k < 20; k++) {
    const u = eclipticDir(33 + rnd() * 57, rnd() * 360);
    assert.ok(v3.len(v3.sub(ss.homeParking(v3.scale(u, 900)), v3.scale(u, 6))) < 1e-9);
  }
  // Asking again from where it parked moves the ship by less than the "already home" margin.
  for (const elev of [0, 12, 25, 30, -20]) {
    const park = ss.homeParking(v3.scale(eclipticDir(elev), 400));
    assert.ok(v3.len(v3.sub(ss.homeParking(park), park)) < 0.25, `re-parking from ${elev} deg`);
  }
  assert.ok(Math.abs(v3.len(ss.homeParking([0, 0, 0])) - 6) < 1e-9, 'defined even at the Sun');
});

/** Flies an autopilot trip; `subject()` is what the view should hold. Returns what happened on the way. */
function flyTrip(ship, subject, { maxTime = 60, after = 3, frame = null } = {}) {
  const tgt = ship.target;
  const out = { arrived: false, time: 0, offCentre: 0, turnAfter: 0, closest: Infinity, viewRate: 0, speedDrop: 0, headingStep: 0, headingErr: 0 };
  let prevF = ship.forward, prevH = null, prevSpeed = ship.speed, atStop = null;
  for (let t = 0; t < maxTime && !out.arrived; t += DT) {
    if (frame) frame();
    const before = [...ship.pos];
    ship.update(DT);
    out.time = t + DT;
    const to = v3.sub(subject(), ship.pos);
    out.closest = Math.min(out.closest, v3.len(to));
    if (tgt.locked) out.offCentre = Math.max(out.offCentre, angle(ship.forward, to));
    out.viewRate = Math.max(out.viewRate, angle(ship.forward, prevF) / DT);
    prevF = ship.forward;
    const moved = v3.sub(ship.pos, before);
    if (v3.len(moved) > 0) out.headingErr = Math.max(out.headingErr, angle(moved, ship.heading));
    if (prevH && ship.speed > 0) out.headingStep = Math.max(out.headingStep, angle(ship.heading, prevH));
    prevH = ship.heading;
    if (prevSpeed > 0 && tgt.cruise !== undefined && ship.speed > tgt.cruise * 0.5) out.speedDrop = Math.max(out.speedDrop, 1 - ship.speed / prevSpeed);
    prevSpeed = ship.speed;
    out.arrived = ship.events.some((e) => e.type === 'arrived');
  }
  atStop = ship.forward;
  for (let t = 0; t < after; t += DT) { if (frame) frame(); ship.update(DT); out.turnAfter = Math.max(out.turnAfter, angle(ship.forward, atStop)); }
  out.facing = angle(ship.forward, v3.sub(subject(), ship.pos));
  return out;
}

test('flying home holds the Sun in the middle of the view and never turns after stopping', () => {
  const ss = new SolarSystem();
  const sun = () => [0, 0, 0];
  for (const [elev, dist] of [[70, 600], [40, 30], [10, 3], [0, 0.05], [-15, 200], [-60, 20 * AU], [5, 3 * AU]]) {
    const ship = new Ship();
    ship.pos = v3.scale(eclipticDir(elev, 300 * rnd()), dist);
    ship.lookAlong(v3.norm([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5])); // any heading, even away from home
    ship.throttle = 0.6;
    ship.speed = throttleToSpeed(0.6) * rnd();
    const start = [...ship.pos];
    const park = ss.homeParking(start.map((x) => x / AU)).map((x) => x * AU);
    ship.goHome(park);
    const r = flyTrip(ship, sun);
    const from = `from ${elev} deg, ${dist.toPrecision(3)} pc`;
    assert.ok(r.arrived && r.time < 35, `${from}: arrived after ${r.time.toFixed(1)} s`);
    assert.ok(v3.len(v3.sub(ship.pos, park)) / AU < 0.05, `${from}: parked on the spot`);
    assert.ok(r.offCentre < 2.5 * DEG, `${from}: the Sun strayed ${(r.offCentre / DEG).toFixed(2)} deg from the centre`);
    assert.ok(r.turnAfter < 0.5 * DEG, `${from}: turned ${(r.turnAfter / DEG).toFixed(2)} deg after stopping`);
    assert.ok(r.facing < 0.01, `${from}: facing the Sun`);
    assert.ok(r.headingErr < 1e-6, `${from}: moves along its reported heading`);
    if (dist > 100 * AU) {
      assert.ok(r.closest > 5.9 * AU, `${from}: came within ${(r.closest / AU).toFixed(2)} AU of the Sun`);
      // the lift off the line of approach is all the view ever turns by once it is on the Sun
      const lift = angle(park, start);
      assert.ok(Math.abs(Math.abs(elevation(park)) - Math.max(Math.abs(elev), 25)) < 2.1 && lift < 25.1 * DEG, `${from}: lifted ${(lift / DEG).toFixed(1)} deg`);
    }
  }
});

test('fly here slides round a planet with it centred, however far the parking spot is off the way in', () => {
  const ss = new SolarSystem();
  ss.update(2461354.6); // 2026-11-10
  const j = ss.get('jupiter');
  const jupiter = () => j.pos.map((x) => x * AU);
  const stop = j.park * j.Req * AU;
  const beside = v3.norm(v3.cross(j.pos, ECLIPTIC_NORTH));
  const starts = {
    'from the Sun side': v3.scale(j.pos, 1 - 2 / v3.len(j.pos)),
    'from behind': v3.scale(j.pos, 1 + 2 / v3.len(j.pos)),
    'from the inner planets': [0.6, -0.7, 0.1],
    'from beside it': v3.add(j.pos, v3.scale(beside, 0.05)),
    'from interstellar space': v3.scale(eclipticDir(35, 120), 4e6),
  };
  let widest = 0;
  for (const [name, startAU] of Object.entries(starts)) {
    const ship = new Ship();
    ship.throttle = 0.68;
    ship.pos = startAU.map((x) => x * AU);
    ship.lookAlong(v3.norm([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]), ECLIPTIC_NORTH);
    const d = parkingSide(j.pos, startAU);
    const slide = angle(d, v3.sub(startAU, j.pos));
    widest = Math.max(widest, slide);
    ship.setTarget({ kind: 'body', id: 'jupiter', name: 'Jupiter', stop: 0, arrive: stop * 0.01, locateFace: jupiter,
      locate: () => v3.add(jupiter(), v3.scale(d, stop)) }, true);
    const r = flyTrip(ship, jupiter);
    assert.ok(r.arrived && r.time < 40, `${name}: arrived after ${r.time.toFixed(1)} s`);
    assert.ok(Math.abs(v3.len(v3.sub(ship.pos, jupiter())) / stop - 1) < 0.02, `${name}: at the viewing distance`);
    assert.ok(r.closest > stop * 0.99, `${name}: came within ${(r.closest / stop).toFixed(3)} parking distances`);
    assert.ok(r.offCentre < 2.5 * DEG, `${name}: Jupiter strayed ${(r.offCentre / DEG).toFixed(2)} deg from the centre`);
    assert.ok(r.turnAfter < 0.5 * DEG, `${name}: turned ${(r.turnAfter / DEG).toFixed(2)} deg after stopping`);
    assert.ok(r.facing < 0.01, `${name}: facing Jupiter`);
    assert.ok(r.headingErr < 1e-6, `${name}: moves along its reported heading`);
  }
  assert.ok(widest > 70 * DEG, `the cases include a wide slide (${(widest / DEG).toFixed(0)} deg)`);
});

test('a wide slide is paced so the view glides rather than whips round', () => {
  const body = [0, 0, 0], stop = 1e-8;
  const rate = (slideDeg) => {
    const ship = new Ship();
    ship.pos = [1e-5, 0, 0];
    ship.lookAlong([-1, 0, 0], [0, 0, 1]);
    const d = [Math.cos(slideDeg * DEG), Math.sin(slideDeg * DEG), 0];
    ship.setTarget({ kind: 'body', name: 'B', stop: 0, arrive: stop * 0.01, locateFace: () => body, locate: () => v3.scale(d, stop) }, true);
    const r = flyTrip(ship, () => body);
    assert.ok(r.arrived, `arrived with a ${slideDeg} deg slide`);
    return r.viewRate / DEG;
  };
  assert.ok(rate(30) < 20, 'a small slide is gentle anyway');
  const wide = rate(75);
  assert.ok(wide > 15 && wide < 34, `a 75 deg slide turns the view at up to ${wide.toFixed(0)} deg/s`);
});

test('engaging the autopilot at speed sheds the old course smoothly', () => {
  const ship = new Ship();
  ship.pos = [40, 10, -5];
  ship.lookAlong(v3.norm([0.2, 1, 0.1]));   // flying across the line home
  ship.throttle = 0.8;
  ship.speed = throttleToSpeed(0.8);
  const v0 = ship.speed;
  const park = v3.scale(v3.norm(ship.pos), 6 * AU);
  ship.goHome(park);
  ship.update(DT);
  assert.ok(ship.speed > v0 * 0.9, `kept ${(ship.speed / v0 * 100).toFixed(0)} % of its speed in the first frame`);
  assert.ok(angle(ship.heading, ship.forward) < 1e-9, 'still going where it looks');
  const r = flyTrip(ship, () => [0, 0, 0]);
  assert.ok(r.arrived);
  assert.ok(r.headingStep < 3 * DEG, `direction of travel never jumped (${(r.headingStep / DEG).toFixed(2)} deg in a frame)`);
  assert.ok(r.offCentre < 2.5 * DEG && r.turnAfter < 0.5 * DEG);
});

test('the autopilot catches a moving planet and parks at its viewing distance', () => {
  const ship = new Ship();
  ship.pos = [0, -3 * AU, 0];
  ship.lookAlong([1, 0, 0], [0, 0, 1]);
  let time = 0;
  // a planet on a 1 AU circle, 1 year period... sped up 10,000x so it really moves
  const planet = () => { const a = time * 2 * Math.PI / (365.25 * 86400) * 1e4; return [Math.cos(a) * AU, Math.sin(a) * AU, 0]; };
  const stop = 4 * 6371 / 1.495978707e8 * AU;
  const region = 0.0098 * AU; // inside its neighbourhood the ship moves with the planet (as the app does)
  ship.setTarget({ kind: 'body', id: 'earth', name: 'Earth', locate: planet, stop }, true);
  let arrived = false;
  for (let t = 0; t < 60 && !arrived; t += DT) {
    const before = planet();
    time += DT;
    if (v3.len(v3.sub(ship.pos, before)) < region) ship.pos = v3.add(ship.pos, v3.sub(planet(), before));
    ship.update(DT);
    arrived = ship.events.some((e) => e.type === 'arrived');
  }
  assert.ok(arrived);
  const d = v3.len(v3.sub(ship.pos, planet()));
  assert.ok(Math.abs(d / stop - 1) < 0.05, `parked at ${(d / stop).toFixed(3)} x the viewing distance`);
});

test('a short hop (Earth to Moon distance) arrives precisely without overshooting', () => {
  const ship = new Ship();
  ship.lookAlong([1, 0, 0], [0, 0, 1]);
  ship.throttle = 0.9; // a fast throttle must not fling the ship past a nearby target
  const moon = [384400 / 1.495978707e8 * AU, 0, 0];
  const stop = 3.5 * 1737.4 / 1.495978707e8 * AU;
  ship.setTarget({ kind: 'body', id: 'moon', name: 'Moon', pos: moon, stop }, true);
  let minD = Infinity, arrived = false, t = 0;
  for (; t < 40 && !arrived; t += DT) {
    ship.update(DT);
    minD = Math.min(minD, v3.len(v3.sub(ship.pos, moon)));
    arrived = ship.events.some((e) => e.type === 'arrived');
  }
  assert.ok(arrived && t < 20, `arrived after ${t.toFixed(1)} s`);
  assert.ok(minD > stop * 0.98, 'never closer than the parking distance');
});

test('the autopilot flies from interstellar space to a planet and parks precisely', () => {
  const ship = new Ship();
  ship.pos = [12, -30, 8]; // 110 ly out
  ship.lookAlong([1, 0, 0]);
  ship.throttle = 0.68;
  const earth = [0.4 * AU, 0.85 * AU, 0.37 * AU];
  const stop = 3.5 * 6378.137 / 1.495978707e8 * AU;
  ship.setTarget({ kind: 'body', id: 'earth', name: 'Earth', locate: () => earth, stop }, true);
  let arrived = false, t = 0;
  for (; t < 90 && !arrived; t += DT) { ship.update(DT); arrived = ship.events.some((e) => e.type === 'arrived'); }
  assert.ok(arrived, 'arrived');
  assert.ok(t < 45, `took ${t.toFixed(1)} s`);
  const d = v3.len(v3.sub(ship.pos, earth));
  assert.ok(Math.abs(d / stop - 1) < 0.02, `parked at ${(d / stop).toFixed(4)} x the viewing distance`);
});

test('flying into the Solar System at warp, the ship drops out of warp at its edge', () => {
  const R_SUN = 695700 / 1.495978707e8 * AU;
  for (const [dt, boost] of [[DT, false], [0.1, false], [0.1, true]]) {
    const ship = new Ship();
    ship.pos = [3, 0.0005, 0];
    ship.lookAlong([-1, 0, 0]);
    ship.throttle = 1; // 60 pc/s: a whole Solar System per frame without the limiter
    ship.boostHeld = boost;
    let minD = Infinity, entered = -1, inside = 0, t = 0;
    for (; t < 30; t += dt) {
      const d = v3.len(ship.pos);
      ship.speedCap = solarSpeedCap(ship.pos, ship.forward, Math.max(d - R_SUN, R_SUN * 0.5), ship.boostFactor);
      ship.update(dt);
      const d1 = v3.len(ship.pos);
      minD = Math.min(minD, d1);
      if (d1 < SOLAR_OUTER_PC) { inside++; if (entered < 0) entered = t; }
    }
    const what = `(dt ${dt}, boost ${boost})`;
    assert.ok(entered >= 0 && entered < 6, `entered the Solar System after ${entered.toFixed(1)} s ${what}`);
    assert.ok(inside * dt > 1.5, `spent ${(inside * dt).toFixed(1)} s inside it, not a frame or two ${what}`);
    // the path passes 103 AU from the Sun: the ship really flew that close
    assert.ok(minD < 0.0005 * 1.01 && minD > R_SUN, `closest approach ${(minD / AU).toFixed(0)} AU ${what}`);
  }
  // heading away, or passing well clear, nothing is limited
  assert.equal(solarSpeedCap([3, 0, 0], [1, 0, 0], 3), Infinity);
  assert.equal(solarSpeedCap([3, 0, 0], v3.norm([-1, 0.1, 0]), 3), Infinity);
  // the autopilot keeps its own braking curve
  const ship = new Ship();
  ship.pos = [0.05, 0, 0];
  ship.lookAlong([1, 0, 0]);
  ship.speedCap = 1e-6;
  ship.setTarget({ kind: 'point', pos: [5, 0, 0], name: 'x', stop: 0 }, true);
  for (let t = 0; t < 2; t += DT) ship.update(DT);
  assert.ok(ship.speed > 0.1, `autopilot not capped (${ship.speed})`);
});

test('speedScale shrinks the throttle range near planets', () => {
  const ship = new Ship();
  ship.throttle = 0.7;
  ship.speedScale = 1e-6;
  for (let t = 0; t < 5; t += DT) ship.update(DT);
  assert.ok(Math.abs(ship.speed / (throttleToSpeed(0.7) * 1e-6) - 1) < 0.02);
  ship.throttle = 0;
  for (let t = 0; t < 30; t += DT) ship.update(DT);
  assert.equal(ship.speed, 0);
});
