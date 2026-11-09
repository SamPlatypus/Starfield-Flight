// The generated star catalogue: format integrity and astronomical accuracy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCatalog, parseNames } from '../src/catalog.js';
import { apparentMag, PC_TO_LY } from '../src/math.js';

const buf = readFileSync(new URL('../public/data/stars.bin', import.meta.url));
const cat = parseCatalog(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const names = parseNames(JSON.parse(readFileSync(new URL('../public/data/names.json', import.meta.url), 'utf8')));
const yale = JSON.parse(readFileSync(new URL('../tools/sources/yale/stars.json', import.meta.url), 'utf8'));
const byName = new Map(names.map((n) => [n.name, n.index]));
const dist = (i) => Math.hypot(...cat.position(i));

test('header and sections are consistent', () => {
  assert.equal(cat.header.format, 'starfield-flight/stars');
  assert.ok(cat.count > 600000, `star count ${cat.count}`);
  assert.equal(cat.count, cat.header.counts.yale + cat.header.counts.athyg + cat.header.counts.gcns + 1);
  let next = 0;
  for (const b of cat.bands) {
    assert.equal(b.start, next, 'bands are contiguous');
    assert.ok(b.mMax >= b.mMin);
    next += b.count;
  }
  assert.equal(next, cat.count);
});

test('every star has a finite position, magnitude and colour', () => {
  for (let i = 0; i < cat.count; i++) {
    const p = cat.position(i);
    assert.ok(p.every(Number.isFinite) && Math.hypot(...p) <= 10000.5, `star ${i} position ${p}`);
    const M = cat.absMag(i);
    assert.ok(M >= -10 && M <= 20, `star ${i} absolute magnitude ${M}`);
    assert.ok(cat.colourIndex(i) >= 0 && cat.colourIndex(i) <= 255);
  }
});

test('octree: children partition their parent and leaves contain their stars', () => {
  const { nodeBounds: B, nodeLinks: L } = cat;
  for (const band of cat.bands) {
    const stack = [band.root];
    while (stack.length) {
      const n = stack.pop();
      const [start, count, first, children] = L.subarray(n * 4, n * 4 + 4);
      if (children === 0) {
        const eps = 1e-3 + 1e-6 * Math.max(...[0, 1, 2, 3, 4, 5].map((k) => Math.abs(B[n * 6 + k])));
        for (let i = start; i < start + count; i++) {
          const p = cat.position(i);
          for (let k = 0; k < 3; k++) {
            assert.ok(p[k] >= B[n * 6 + k] - eps && p[k] <= B[n * 6 + 3 + k] + eps, `star ${i} outside leaf ${n}`);
          }
        }
        continue;
      }
      let s = start;
      for (let c = first; c < first + children; c++) {
        assert.equal(L[c * 4], s, 'child ranges are contiguous and ordered');
        s += L[c * 4 + 1];
        stack.push(c);
      }
      assert.equal(s, start + count, 'children cover the parent');
    }
  }
});

test('the Sun is at the origin with M = 4.83', () => {
  const sol = byName.get('Sol');
  assert.ok(sol >= 0);
  assert.ok(dist(sol) < 1e-3);
  assert.ok(Math.abs(cat.absMag(sol) - 4.83) < 0.01);
});

test('distances of well-known stars (Hipparcos new reduction / Gaia DR3)', () => {
  const expectPc = {
    Sirius: 2.64, Procyon: 3.51, Altair: 5.13, Vega: 7.68, Fomalhaut: 7.70, Pollux: 10.36,
    Arcturus: 11.26, Capella: 13.12, Aldebaran: 20.43, Regulus: 24.31, Spica: 76.57,
    Canopus: 94.79, Polaris: 132.63, Betelgeuse: 152.67, Antares: 169.78, Rigel: 264.55, Deneb: 432.9,
    'Proxima Centauri': 1.30, "Barnard's Star": 1.83, 'Wolf 359': 2.41,
  };
  for (const [name, pc] of Object.entries(expectPc)) {
    const i = byName.get(name);
    assert.ok(i !== undefined, `${name} labelled`);
    const d = dist(i);
    assert.ok(Math.abs(d - pc) / pc < 0.015, `${name}: ${d.toFixed(3)} pc, expected ${pc}`);
  }
});

test('the sky seen from the Sun reproduces the Yale V magnitudes', () => {
  // Brightest naked-eye stars and their catalogue V magnitudes.
  const expectV = { Sirius: -1.46, Canopus: -0.72, Arcturus: -0.04, Vega: 0.03, Capella: 0.08, Rigel: 0.12, Procyon: 0.38, Betelgeuse: 0.5, Altair: 0.77, Aldebaran: 0.85, Antares: 0.96, Spica: 0.98, Deneb: 1.25 };
  for (const [name, V] of Object.entries(expectV)) {
    const i = byName.get(name);
    const m = apparentMag(cat.absMag(i), dist(i));
    assert.ok(Math.abs(m - V) < 0.02, `${name}: m=${m.toFixed(3)} expected ${V}`);
  }
});

test('the Yale catalogue is in, with its magnitudes and colours', () => {
  assert.ok(cat.header.counts.yale >= 8390, `${cat.header.counts.yale} Yale stars`);
  // Count catalogue stars brighter than V 4 seen from the Sun; Yale has 514 such entries.
  let bright = 0;
  for (let i = 0; i < cat.count; i++) {
    const d = dist(i);
    if (d > 1e-3 && apparentMag(cat.absMag(i), d) < 4) bright++;
  }
  const yaleBright = yale.mag.filter((m) => m < 4).length;
  assert.ok(Math.abs(bright - yaleBright) <= 8, `stars brighter than V=4 from the Sun: ${bright}, Yale: ${yaleBright}`);
});

test('nearby stars: the 100 ly census is complete enough to fly through', () => {
  let within10ly = 0, within100ly = 0;
  for (let i = 0; i < cat.count; i++) {
    const ly = dist(i) * PC_TO_LY;
    if (ly < 10 && ly > 0.01) within10ly++;
    if (ly < 100) within100ly++;
  }
  // 10 ly: Alpha Cen A/B, Proxima, Barnard's, Wolf 359, Lalande 21185, Sirius A/B, Luyten 726-8 A/B ...
  assert.ok(within10ly >= 9 && within10ly <= 16, `${within10ly} stars within 10 ly`);
  assert.ok(within100ly > 9000, `${within100ly} stars within 100 ly`);
});

test('stars without a usable parallax are placed by spectroscopic parallax and flagged', () => {
  const polis = names.find((n) => n.name === 'Polis');
  assert.ok(polis, 'Polis (mu Sgr) is in the catalogue');
  assert.match(polis.note, /estimated from spectral type/);
  const d = dist(polis.index);
  assert.ok(d > 700 && d < 2000, `Polis at ${d.toFixed(0)} pc`);
  const m = apparentMag(cat.absMag(polis.index), d);
  assert.ok(Math.abs(m - 3.86) < 0.02, `Polis seen from the Sun at m=${m.toFixed(3)}`);
  assert.equal(cat.header.counts.yaleSpectroscopic, 3);
  // Measured stars carry no note.
  assert.equal(names.find((n) => n.name === 'Sirius').note, '');
});

test('labels point at real stars', () => {
  assert.ok(names.length > 700);
  for (const n of names) {
    assert.ok(n.index >= 0 && n.index < cat.count);
    assert.ok(n.name && typeof n.name === 'string');
  }
});
