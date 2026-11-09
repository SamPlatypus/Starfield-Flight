// Colours, maths helpers, formatting and the performance governor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bvToTemperature, starColour, buildColourLut } from '../src/render/colour.js';
import { quat, v3, transpose3, formatDistance, formatSpeed, apparentMag } from '../src/math.js';
import { PerfGovernor } from '../src/perf.js';
import { describeStar } from '../src/hud.js';
import { bvFromTeff, gMinusV } from '../tools/photometry.mjs';

test('B-V to temperature (Ballesteros) and back', () => {
  assert.ok(Math.abs(bvToTemperature(0.65) - 5800) < 150, 'Sun');
  assert.ok(Math.abs(bvToTemperature(0.0) - 10070) < 300, 'Vega-like');
  for (const bv of [-0.3, 0, 0.65, 1.2, 1.9]) assert.ok(Math.abs(bvFromTeff(bvToTemperature(bv)) - bv) < 1e-9);
});

test('star colours: blue, white, yellow-white, orange, red', () => {
  const [vr, , vb] = starColour(-0.25);
  assert.ok(vb > vr, 'hot stars are blue');
  const sun = starColour(0.65);
  assert.ok(sun[0] >= sun[1] && sun[1] >= sun[2], 'the Sun is warm white');
  assert.ok(sun[2] > 0.8, 'but still nearly white');
  const [br, bg, bb] = starColour(1.85);
  assert.ok(br > bg && bg > bb, 'Betelgeuse is orange-red');
  const lut = buildColourLut(-0.5, 3 / 255);
  assert.equal(lut.length, 1024);
});

test('Gaia G-V colour term matches published values', () => {
  assert.ok(Math.abs(gMinusV(0.82) + 0.13) < 0.03, 'solar colour');
  assert.ok(Math.abs(gMinusV(3.8) + 2.2) < 0.15, 'Proxima-like M dwarf');
});

test('quaternions: look rotation, matrices and their inverse', () => {
  const f = v3.norm([0.3, -0.5, 0.8]);
  const q = quat.lookRotation(f, [0, 0, 1]);
  const fw = quat.rotate(q, [0, 0, -1]);
  assert.ok(v3.len(v3.sub(fw, f)) < 1e-12);
  const m = quat.toMat3(q, new Float64Array(9));
  const back = quat.fromBasis([m[0], m[1], m[2]], [m[3], m[4], m[5]], [m[6], m[7], m[8]]);
  assert.ok(Math.abs(Math.abs(v3.dot(back, q) + back[3] * q[3] - back[3] * q[3]) + Math.abs(back[3] * q[3]) - 1) < 1e-9 ||
    Math.abs(Math.abs(back[0] * q[0] + back[1] * q[1] + back[2] * q[2] + back[3] * q[3]) - 1) < 1e-9);
  const t = transpose3(m, new Float64Array(9));
  // view * world-forward = (0, 0, -1)
  const v = [t[0] * f[0] + t[3] * f[1] + t[6] * f[2], t[1] * f[0] + t[4] * f[1] + t[7] * f[2], t[2] * f[0] + t[5] * f[1] + t[8] * f[2]];
  assert.ok(Math.abs(v[2] + 1) < 1e-12 && Math.abs(v[0]) < 1e-12 && Math.abs(v[1]) < 1e-12);
});

test('formatting distances and speeds', () => {
  assert.equal(formatDistance(0.0153), '3,156 AU');
  assert.equal(formatDistance(2.64), '8.61 ly');
  assert.equal(formatDistance(264.55), '863 ly');
  assert.equal(formatSpeed(0), '0 km/s');
  // Solar System scales
  assert.equal(formatDistance(7 / 206264.806), '7.00 AU');
  assert.equal(formatDistance(384400 / 3.0856775814913673e13), '384,400 km');
  assert.equal(formatDistance(0.5 / 206264.806), '0.500 AU');
  assert.equal(formatSpeed(30 / 3.0856775814913673e13), '30.0 km/s');
  assert.equal(formatSpeed(250000 / 3.0856775814913673e13), '250,000 km/s');
  assert.equal(formatSpeed(3 * 149597870.7 / 3.0856775814913673e13), '3.00 AU/s');
  assert.equal(formatSpeed(3.1), '10 ly/s');
  assert.equal(formatSpeed(0.4), '1.3 ly/s');
  assert.equal(formatSpeed(0.1), '0.33 ly/s');
  assert.ok(Math.abs(apparentMag(4.83, 10) - 4.83) < 1e-12);
});

test('describing stars from colour and luminosity', () => {
  assert.equal(describeStar(0.65, 4.83), 'yellow dwarf');
  assert.equal(describeStar(1.85, -5.4), 'red supergiant');
  assert.equal(describeStar(0.0, 11.5), 'white dwarf');
  assert.equal(describeStar(1.5, 0), 'red giant');
});

test('performance governor lowers resolution first, then star depth, and recovers', () => {
  const g = new PerfGovernor();
  let now = 0;
  const run = (ms, seconds) => { for (let i = 0; i < seconds * 1000 / ms; i++) { now += ms; g.frame(now, ms); } };
  run(16.7, 3);
  assert.equal(g.scale, 1);
  run(25, 12); // a slow device
  assert.ok(g.scale <= 0.56, `scale ${g.scale}`);
  assert.ok(g.magCap < 12, 'then fewer stars');
  run(8.3, 60); // plenty of headroom again (120 Hz)
  assert.ok(g.scale > 0.9 && g.magCap === 12, `recovered to scale ${g.scale}, cap ${g.magCap}`);
});
