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
