// Culling must be conservative: every star that is bright enough and on screen (or whose
// streak tail is on screen) has to be inside the ranges handed to the GPU.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCatalog } from '../src/catalog.js';
import { Culler, frustumPlanes, visibilityRadius } from '../src/culling.js';
import { quat, transpose3 } from '../src/math.js';

const buf = readFileSync(new URL('../public/data/stars.bin', import.meta.url));
const cat = parseCatalog(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const randomQuat = () => quat.normalize([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]);

function inFrustum(v, tanX, tanY) {
  return v[2] < 0 && Math.abs(v[0]) <= -v[2] * tanX && Math.abs(v[1]) <= -v[2] * tanY;
}

test('visibility radius follows the distance modulus', () => {
  // A star of M = 1.44 (Sirius) at the radius is exactly at the limit.
  const R = visibilityRadius(6.5, 1.44);
  assert.ok(Math.abs(1.44 + 5 * Math.log10(R) - 5 - 6.5) < 1e-9);
});

test('no visible star is ever culled (random cameras)', () => {
  const culler = new Culler(cat);
  const planes = new Float64Array(15);
  const covered = new Uint8Array(cat.count);
  const cases = [];
  for (let k = 0; k < 14; k++) {
    const r = k < 3 ? rnd() * 2 : k < 9 ? rnd() * 120 : rnd() * 900;
    const dir = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
    const l = Math.hypot(...dir);
    cases.push({
      cam: dir.map((x) => (x / l) * r), q: randomQuat(),
      fov: 40 + rnd() * 70, aspect: 0.45 + rnd() * 1.8, mag: 4.5 + rnd() * 6.5, sweep: rnd() < 0.3 ? 0 : rnd() * 3,
    });
  }
  let visibleTotal = 0, submittedTotal = 0;
  for (const c of cases) {
    const camToWorld = quat.toMat3(c.q);
    const view = transpose3(camToWorld);
    const fwd = quat.rotate(c.q, [0, 0, -1]);
    const t = Math.tan((c.fov * Math.PI) / 360);
    const tanX = c.aspect < 1 ? t : t * c.aspect, tanY = c.aspect < 1 ? t / c.aspect : t;
    const n = frustumPlanes(view, tanX, tanY, 0.04, planes);
    const ranges = culler.collect(c.cam, planes, n, fwd, c.sweep, c.mag);
    covered.fill(0);
    for (let r = 0; r < ranges; r++) covered.fill(1, culler.starts[r], culler.starts[r] + culler.counts[r]);
    let visible = 0, missed = 0;
    const head = [0, 0, 0], tail = [0, 0, 0];
    for (let i = 0; i < cat.count; i++) {
      const p = cat.position(i);
      const x = p[0] - c.cam[0], y = p[1] - c.cam[1], z = p[2] - c.cam[2];
      const d = Math.hypot(x, y, z);
      if (cat.absMag(i) + 5 * Math.log10(Math.max(d, 1e-9)) - 5 >= c.mag) continue;
      for (let a = 0; a < 3; a++) {
        head[a] = view[a] * x + view[3 + a] * y + view[6 + a] * z;
        const tx = x + fwd[0] * c.sweep, ty = y + fwd[1] * c.sweep, tz = z + fwd[2] * c.sweep;
        tail[a] = view[a] * tx + view[3 + a] * ty + view[6 + a] * tz;
      }
      if (!inFrustum(head, tanX, tanY) && !inFrustum(tail, tanX, tanY)) continue;
      visible++;
      if (!covered[i]) missed++;
    }
    assert.equal(missed, 0, `${missed} of ${visible} visible stars culled for ${JSON.stringify(c)}`);
    visibleTotal += visible;
    submittedTotal += culler.starsSubmitted;
  }
  // And it has to actually cull: far fewer stars submitted than exist.
  assert.ok(submittedTotal / cases.length < cat.count * 0.25, `submitted ${submittedTotal / cases.length} per frame on average`);
  assert.ok(visibleTotal > 0);
});
