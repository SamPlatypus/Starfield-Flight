// The hand-off between interstellar flight and the Solar System: its curves, its states
// (with hysteresis) and the easing of the view's level.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SolarTransition, logRamp, SYSTEM_FAR_AU, SYSTEM_NEAR_AU, VOLUME_AU, NEIGHBOURHOOD_AU, LEAVE, LEVEL_RATE } from '../src/solar/transition.js';
import { SolarSystem, AU_PER_PC, SOLAR_INNER_PC } from '../src/solar/system.js';

const pc = (au) => au / AU_PER_PC;
const DT = 1 / 60;

test('the log ramp is smooth in log distance and flat outside its range', () => {
  assert.equal(logRamp(5000, 2000, 150), 0);
  assert.equal(logRamp(2000, 2000, 150), 0);
  assert.equal(logRamp(150, 2000, 150), 1);
  assert.equal(logRamp(1e-6, 2000, 150), 1);
  assert.equal(logRamp(0, 2000, 150), 1, 'defined at the Sun itself');
  assert.ok(Math.abs(logRamp(Math.sqrt(2000 * 150), 2000, 150) - 0.5) < 1e-12, 'half way at the geometric mean');
  let prev = 0;
  for (let d = 2500; d > 100; d *= 0.97) {
    const v = logRamp(d, 2000, 150);
    assert.ok(v >= prev && v - prev < 0.06, `monotonic and gradual at ${d.toFixed(0)} AU`);
    prev = v;
  }
});

test('on the way in the neighbourhood fades in first, then the planets resolve', () => {
  const tr = new SolarTransition();
  let fade = 0, system = 0;
  for (let d = 30000; d > 1; d *= 0.98) {
    tr.update(pc(d), null, 0);
    assert.ok(tr.fade >= fade && tr.system >= system, `both rise at ${d.toFixed(0)} AU`);
    if (tr.system > 0) assert.equal(tr.fade, 1, `the neighbourhood is fully in before the planets resolve (${d.toFixed(0)} AU)`);
    ({ fade, system } = tr);
  }
  assert.ok(SOLAR_INNER_PC * AU_PER_PC > SYSTEM_FAR_AU, 'the two ranges do not overlap');
  tr.update(pc(SYSTEM_FAR_AU * 1.01), null, 0);
  assert.equal(tr.system, 0);
  tr.update(pc(SYSTEM_NEAR_AU * 0.99), null, 0);
  assert.equal(tr.system, 1);
});

test('states follow the distance from the Sun, and each edge has hysteresis', () => {
  const tr = new SolarTransition(pc(50000));
  assert.equal(tr.state, 'interstellar');
  assert.ok(!tr.near && !tr.arrived);
  const seen = [];
  const at = (au) => { tr.update(pc(au), null, DT); for (const e of tr.events.splice(0)) seen.push(`${e.from}>${e.to}`); return tr.state; };

  assert.equal(at(NEIGHBOURHOOD_AU * 1.01), 'interstellar');
  assert.equal(at(NEIGHBOURHOOD_AU * 0.99), 'approach');
  assert.ok(tr.near && !tr.arrived);
  assert.equal(at(NEIGHBOURHOOD_AU * 1.2), 'approach', 'not left until well outside');
  assert.equal(at(VOLUME_AU * 1.01), 'approach');
  assert.equal(at(VOLUME_AU * 0.99), 'system');
  assert.ok(tr.near && tr.arrived);
  // hovering about the edge does not flicker
  for (let k = 0; k < 200; k++) at(VOLUME_AU * (1 + 0.2 * Math.sin(k)));
  assert.equal(tr.state, 'system');
  assert.deepEqual(seen, ['interstellar>approach', 'approach>system']);

  assert.equal(at(VOLUME_AU * LEAVE * 0.99), 'system');
  assert.equal(at(VOLUME_AU * LEAVE * 1.01), 'approach');
  assert.equal(at(NEIGHBOURHOOD_AU * LEAVE * 0.99), 'approach');
  assert.equal(at(NEIGHBOURHOOD_AU * LEAVE * 1.01), 'interstellar');
  assert.deepEqual(seen.slice(2), ['system>approach', 'approach>interstellar']);

  // crossing everything in one step is one change, to where the ship now is
  seen.length = 0;
  assert.equal(at(5), 'system');
  assert.equal(at(1e6), 'interstellar');
  assert.deepEqual(seen, ['interstellar>system', 'system>interstellar']);
});

test('a body\'s neighbourhood is a state of its own, announced when the body changes', () => {
  const ss = new SolarSystem();
  ss.update(2461354.6);
  const jupiter = ss.get('jupiter'), io = ss.get('io');
  const tr = new SolarTransition(pc(5.2));
  assert.equal(tr.state, 'system');
  const hosts = [];
  const step = (host) => { tr.update(pc(5.2), host, DT); for (const e of tr.events.splice(0)) hosts.push(`${e.to}:${e.host ? e.host.id : '-'}`); };
  step(jupiter); step(jupiter); step(io); step(jupiter); step(null); step(null);
  assert.deepEqual(hosts, ['body:jupiter', 'body:io', 'body:jupiter', 'system:-']);
  assert.equal(tr.state, 'system');
  assert.equal(tr.host, null);

  // the system keeps the body the ship is with until 20 % beyond its neighbourhood
  const out = (k) => [jupiter.pos[0], jupiter.pos[1], jupiter.pos[2] + jupiter.region * k];
  assert.equal(ss.frameBody(out(0.9))?.id, 'jupiter');
  assert.equal(ss.frameBody(out(1.1)), null);
  assert.equal(ss.frameBody(out(1.1), jupiter)?.id, 'jupiter');
  assert.equal(ss.frameBody(out(1.25), jupiter), null);
  assert.equal(ss.frameBody(out(1.1), io), null, 'only the body it is already with');
});

test('the level eases at a bounded rate, and the autopilot levels for its destination from the start', () => {
  // by hand: follows the planets resolving, never faster than LEVEL_RATE
  const tr = new SolarTransition(pc(5000));
  assert.equal(tr.level, 0);
  let t = 0, prev = 0;
  for (; tr.level < 1 && t < 20; t += DT) {
    tr.update(pc(10), null, DT); // dropped straight among the planets
    assert.ok(tr.level - prev <= LEVEL_RATE * DT + 1e-12);
    prev = tr.level;
  }
  assert.ok(Math.abs(t - 1 / LEVEL_RATE) < 0.05, `took ${t.toFixed(2)} s to swing over`);
  for (let s = 0; s < 2; s += DT) tr.update(pc(5000), null, DT);
  assert.ok(Math.abs(tr.level - (1 - 2 * LEVEL_RATE)) < 0.01, 'and eases back out the same way');

  // slowly flown, the level simply tracks `system`
  const slow = new SolarTransition(pc(3000));
  for (let d = 3000; d > 100; d *= 0.9995) { slow.update(pc(d), null, DT); assert.ok(Math.abs(slow.level - slow.system) < 0.02); }

  // autopilot bound for the Solar System, still light-years out
  const home = new SolarTransition(pc(3e6));
  for (let s = 0; s < 5; s += DT) home.update(pc(3e6), null, DT, 1);
  assert.equal(home.system, 0);
  assert.equal(home.level, 1, 'levelled to the planets\' plane before it arrives');
  // autopilot bound for a star, still among the planets
  const away = new SolarTransition(pc(5));
  assert.equal(away.level, 1);
  for (let s = 0; s < 5; s += DT) away.update(pc(5), null, DT, -1);
  assert.equal(away.level, 0);
  // released, it returns to where the ship actually is
  for (let s = 0; s < 5; s += DT) away.update(pc(5), null, DT, 0);
  assert.equal(away.level, 1);
});

test('a jump resets the hand-off without easing or announcing anything', () => {
  const tr = new SolarTransition(pc(5));
  assert.equal(tr.state, 'system');
  assert.equal(tr.level, 1);
  tr.reset(pc(4e7));
  assert.equal(tr.state, 'interstellar');
  assert.equal(tr.level, 0);
  assert.equal(tr.fade, 0);
  assert.equal(tr.events.length, 0);
  tr.reset(pc(300));
  assert.equal(tr.state, 'approach');
  assert.ok(tr.level > 0.5 && tr.level < 1 && tr.level === tr.system);
  assert.equal(tr.events.length, 0);
});
