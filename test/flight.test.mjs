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
import { SolarSystem, ECLIPTIC_NORTH, SOLAR_OUTER_PC, solarSpeedCap } from '../src/solar/system.js';

test('flying home parks above the ecliptic at the parking point, facing the Sun', () => {
  const ss = new SolarSystem();
  for (const start of [[600, -200, 30], [3, 1, -2], [0.05, 0.01, 0.02], [20 * AU, 0, 0]]) {
    const ship = new Ship();
    ship.pos = [...start];
    ship.lookAlong(v3.norm([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]));
    ship.throttle = 0.6;
    const parkAU = ss.homeParking(start.map((x) => x / AU));
    const park = parkAU.map((x) => x * AU);
    ship.goHome(park);
    let arrived = false, t = 0;
    for (; t < 60 && !arrived; t += DT) { ship.update(DT); arrived = ship.events.some((e) => e.type === 'arrived'); }
    assert.ok(arrived, `no arrival from ${v3.len(start)} pc`);
    assert.ok(t < 35, `took ${t.toFixed(1)} s`);
    const miss = v3.len(v3.sub(ship.pos, park)) / AU;
    assert.ok(miss < 0.05, `parked ${miss.toFixed(3)} AU from the spot`);
    for (let s = 0; s < 3; s += DT) ship.update(DT);
    assert.ok(angle(ship.forward, v3.scale(ship.pos, -1)) < 0.01, 'facing the Sun');
    const elev = Math.asin(v3.dot(v3.norm(ship.pos), ECLIPTIC_NORTH)) * 180 / Math.PI;
    assert.ok(Math.abs(elev - 60) < 0.5, `elevation ${elev.toFixed(2)}`);
  }
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
