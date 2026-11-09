#!/usr/bin/env node
// Builds the 3D star catalogue the app flies through.
//
//   bash tools/fetch-sources.sh && node tools/build-stars.mjs
//
// Inputs (see NOTICE.md for credits and licences)
//   tools/sources/yale/stars.json, constellations.json
//       The Yale Bright Star Catalogue (5th rev. ed., Hoffleit & Warren 1991) as packaged by
//       the Star-Sky app: J2000 positions, V magnitudes, B-V colours, spectral types, IAU
//       names and Bayer / Flamsteed designations for the 8,404 stars down to V = 6.5.
//   tools/raw/athyg_40_reduced_m10.csv.gz
//       AT-HYG v4.0 (Tycho-2 + Hipparcos + Yale + Gliese, distances from Gaia DR3 or the
//       Hipparcos new reduction): every star to V = 10 plus everything within 100 ly.
//   tools/raw/gcns_main.csv.gz
//       Gaia Catalogue of Nearby Stars (Gaia EDR3): the census of stars within 100 pc.
//
// Every Yale star keeps its own position, magnitude, colour, name and designation; AT-HYG
// supplies its distance (matched one-to-one by HR number, position and magnitude). The
// remaining AT-HYG stars and the GCNS stars that are not already present fill in the
// fainter population. Output:
//   public/data/stars.bin   per-magnitude-band octrees + quantised stars (format below)
//   public/data/names.json  labels for named / designated stars

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { teffFromBpRp, bvFromTeff, gMinusV, bpRpFromMG, bvFromSpectrum } from './photometry.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const RAW = process.argv[2] || join(here, 'raw');
const SRC = join(here, 'sources');
const OUT = join(here, '..', 'public', 'data');
mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------ tunables
export const BAND_EDGES = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const M_FAINTEST = 17.5;      // visible from < 0.5 pc even at the deepest setting; fainter is never seen
const MAX_DIST = 10000;       // pc; beyond this Gaia/Hipparcos distances are noise
const M_BRIGHTEST = -10;      // brighter absolute magnitudes are parallax errors
const LEAF_MAX = 256;         // stars per octree leaf
const LEAF_MAX_HALF = 256;    // pc; caps quantisation error at half/32767 = 0.008 pc
const MAX_DEPTH = 20;
const BV_MIN = -0.5, BV_STEP = 3.0 / 255;
const DEG = Math.PI / 180;

const log = (...a) => console.log(...a);
const round = (x, d) => { const p = 10 ** d; return Math.round(x * p) / p; };

// ------------------------------------------------------------------ CSV
function readCsv(file) {
  const text = gunzipSync(readFileSync(file)).toString('utf8');
  const lines = text.split('\n');
  const header = splitCsvLine(lines[0]);
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (line) rows.push(line.includes('"') ? splitCsvLine(line) : line.split(','));
  }
  return { col, rows };
}
function splitCsvLine(line) {
  const out = []; let field = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(field); field = ''; } else field += c;
  }
  out.push(field);
  return out;
}
const num = (s) => (s === undefined || s === '' ? NaN : +s);

// ------------------------------------------------------------------ geometry helpers
const unit = (raDeg, decDeg) => {
  const a = raDeg * DEG, d = decDeg * DEG, c = Math.cos(d);
  return [c * Math.cos(a), c * Math.sin(a), Math.sin(d)];
};
const ARCSEC = DEG / 3600;

// Spatial hash on the unit sphere for positional matching (cells of ~0.3 deg).
class SkyHash {
  constructor(cell = 0.005) { this.cell = cell; this.map = new Map(); }
  key(ix, iy, iz) { return `${ix},${iy},${iz}`; }
  add(v, item) {
    const k = this.key(...v.map((c) => Math.floor(c / this.cell)));
    let list = this.map.get(k);
    if (!list) this.map.set(k, (list = []));
    list.push([v, item]);
  }
  // Items within `radius` (radians, << cell) of unit vector v: [sepRadians, item]
  near(v, radius) {
    const out = [];
    const [cx, cy, cz] = v.map((c) => Math.floor(c / this.cell));
    const cosR = Math.cos(radius);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = this.map.get(this.key(cx + dx, cy + dy, cz + dz));
      if (!list) continue;
      for (const [w, item] of list) {
        const dot = v[0] * w[0] + v[1] * w[1] + v[2] * w[2];
        if (dot >= cosR) out.push([Math.acos(Math.min(1, dot)), item]);
      }
    }
    return out;
  }
}

// ------------------------------------------------------------------ 1. Yale (Star-Sky)
const yale = JSON.parse(readFileSync(join(SRC, 'yale', 'stars.json'), 'utf8'));
const cons = JSON.parse(readFileSync(join(SRC, 'yale', 'constellations.json'), 'utf8'));
const GREEK = 'αβγδεζηθικλμνξοπρστυφχψω';
const yaleName = new Map();
for (let i = 0; i < yale.names.length; i += 2) yaleName.set(yale.names[i], yale.names[i + 1]);
const yaleDesig = new Map();
for (let i = 0; i < yale.flam.length; i += 3) yaleDesig.set(yale.flam[i], `${yale.flam[i + 1]} ${cons.abbr[yale.flam[i + 2]]}`);
for (let i = 0; i < yale.bayer.length; i += 4) {
  const sup = yale.bayer[i + 2] ? '¹²³⁴⁵⁶⁷⁸⁹'[yale.bayer[i + 2] - 1] : '';
  yaleDesig.set(yale.bayer[i], `${GREEK[yale.bayer[i + 1] - 1]}${sup} ${cons.abbr[yale.bayer[i + 3]]}`);
}
log(`Yale: ${yale.count} stars, ${yaleName.size} proper names, ${yaleDesig.size} designations`);

// ------------------------------------------------------------------ 2. AT-HYG
const at = readCsv(join(RAW, 'athyg_40_reduced_m10.csv.gz'));
const A = at.col;
const atRows = [];
for (const r of at.rows) {
  const dist = num(r[A.dist]);
  const proper = r[A.proper];
  if (proper === 'Sol') continue; // added explicitly below
  const row = {
    gaia: r[A.gaia], hr: r[A.hr] ? +r[A.hr] : 0, gl: r[A.gl], proper, bayer: r[A.bayer], flam: +r[A.flam] || 0, con: r[A.con],
    ra: num(r[A.ra]) * 15, dec: num(r[A.dec]), dist, mag: num(r[A.mag]), ci: num(r[A.ci]),
    x: num(r[A.x0]), y: num(r[A.y0]), z: num(r[A.z0]), spect: r[A.spect], used: false,
  };
  row.v = unit(row.ra, row.dec);
  atRows.push(row);
}
const atHash = new SkyHash();
for (const row of atRows) atHash.add(row.v, row);
log(`AT-HYG: ${atRows.length} rows (${atRows.filter((r) => r.dist > 0).length} with distances)`);

// ------------------------------------------------------------------ 3. match Yale <-> AT-HYG
// One-to-one greedy assignment on a score that prefers the same HR number, small
// separation and similar magnitude. Handles double stars whose HR ids are swapped or
// carried by only one component in AT-HYG.
const validDist = (d) => d > 0 && d < MAX_DIST;
const cand = [];
const yv = [];
for (let i = 0; i < yale.count; i++) {
  const v = unit(yale.ra[i], yale.dec[i]);
  yv.push(v);
  for (const [sep, row] of atHash.near(v, 60 * ARCSEC)) {
    if (!validDist(row.dist)) continue;
    const sameHr = row.hr === yale.hr[i];
    if (!sameHr && sep > 15 * ARCSEC) continue;
    const score = sep / (5 * ARCSEC) + Math.abs(yale.mag[i] - row.mag) / 0.75 - (sameHr ? 2 : 0);
    cand.push([score, i, row, sep]);
  }
}
cand.sort((a, b) => a[0] - b[0]);
const yaleMatch = new Array(yale.count).fill(null);
for (const [, i, row] of cand) {
  if (yaleMatch[i] || row.used) continue;
  yaleMatch[i] = row; row.used = true; row.yaleV = yale.mag[i];
}
// Yale stars whose Hipparcos and Gaia parallaxes are unusable (none, or pure noise) are placed
// by spectroscopic parallax: the absolute magnitude of their MK class (Schmidt-Kaler 1982
// calibration) with extinction from their colour excess, A_V = 3.1 E(B-V).
// HR: [MK type, M_V, intrinsic (B-V)0]. The variables T CrB (HR 5958) and the Miras HR 1707
// and HR 2063 stay out: Yale lists them at maximum light, and they normally sit near V = 10.
const SPECTROSCOPIC = {
  6812: ['B8Ia', -7.1, -0.03],   // Polis, mu Sgr
  6823: ['O9.5II', -5.6, -0.30],
  7486: ['B5V', -1.2, -0.17],
};
const ESTIMATED_NOTE = 'Distance estimated from spectral type (no reliable parallax)';
let companions = 0, estimated = 0; const dropped = [];
for (let i = 0; i < yale.count; i++) {
  if (yaleMatch[i]) continue;
  // Component of a double whose AT-HYG entry is already taken: same system, same distance.
  const best = cand.filter((c) => c[1] === i && c[3] < 15 * ARCSEC).sort((a, b) => a[3] - b[3])[0];
  const sp = SPECTROSCOPIC[yale.hr[i]];
  if (best) { yaleMatch[i] = { ...best[2], companion: true }; companions++; }
  else if (sp) {
    const av = 3.1 * Math.max(0, (yale.bv[i] ?? sp[2]) - sp[2]);
    yaleMatch[i] = { dist: 10 ** ((yale.mag[i] - sp[1] - av + 5) / 5), estimated: true, proper: '' };
    estimated++;
  } else dropped.push(yale.hr[i]);
}
log(`Yale matched: ${yale.count - companions - estimated - dropped.length} one-to-one, ${companions} double-star companions, ` +
  `${estimated} by spectroscopic parallax, ${dropped.length} left out (HR ${dropped.join(', ')})`);

// ------------------------------------------------------------------ 4. assemble stars
const stars = [];
const names = []; // [starObj, name, designation, spectral type]
const pushStar = (s) => { stars.push(s); return s; };
const absMag = (V, d) => V - 5 * Math.log10(d / 10);

const sol = pushStar({ x: 0, y: 0, z: 0, M: 4.83, bv: 0.65, src: 'sun' });
names.push([sol, 'Sol', 'the Sun', 'G2V']);

let srcCount = { yale: 0, athyg: 0, gcns: 0 };
const yaleStar = new Array(yale.count).fill(null);
const yaleBayer = new Map(), yaleFlam = new Map();
for (let i = 0; i < yale.bayer.length; i += 4) yaleBayer.set(yale.bayer[i], [yale.bayer[i + 1], yale.bayer[i + 2], yale.bayer[i + 3]]);
for (let i = 0; i < yale.flam.length; i += 3) yaleFlam.set(yale.flam[i], [yale.flam[i + 1], yale.flam[i + 2]]);
const conIndex = new Map(cons.abbr.map((a, i) => [a.toUpperCase(), i]));
const GREEK3 = ['ALP', 'BET', 'GAM', 'DEL', 'EPS', 'ZET', 'ETA', 'THE', 'IOT', 'KAP', 'LAM', 'MU', 'NU', 'XI', 'OMI', 'PI', 'RHO', 'SIG', 'TAU', 'UPS', 'PHI', 'CHI', 'PSI', 'OME'];
for (let i = 0; i < yale.count; i++) {
  const m = yaleMatch[i];
  if (!m) continue;
  const [vx, vy, vz] = yv[i];
  const d = m.dist;
  const bv = yale.bv[i] ?? (Number.isFinite(m.ci) ? m.ci : bvFromSpectrum(yale.sp[i]));
  const s = pushStar({ x: vx * d, y: vy * d, z: vz * d, M: absMag(yale.mag[i], d), bv, src: 'yale', hr: yale.hr[i] });
  srcCount.yale++;
  yaleStar[i] = s;
  const name = yaleName.get(i) || (m.proper && !m.companion ? m.proper : '');
  const bay = yaleBayer.get(i), fl = yaleFlam.get(i);
  s.search = { name, greek: bay ? bay[0] : 0, sup: bay ? bay[1] : 0, con: bay ? bay[2] : fl ? fl[1] : -1, flam: fl ? fl[0] : 0, hr: yale.hr[i], gl: '' };
  const desig = yaleDesig.get(i) || `HR ${yale.hr[i]}`;
  // Label every IAU-named Yale star, plus designated stars bright enough to stand out.
  const note = m.estimated ? ESTIMATED_NOTE : '';
  const second = name ? desig : desig.startsWith('HR ') ? '' : `HR ${yale.hr[i]}`;
  if (name || note || (yaleDesig.has(i) && yale.mag[i] < 4.0)) names.push([s, name || desig, second, yale.sp[i], note]);
}

// Yale gives the combined magnitude of close doubles it does not resolve; AT-HYG lists the
// components. Fold such a companion (within 12", same distance, within 2.5 mag) into its Yale
// primary so its light is not counted twice. Resolved pairs (both in Yale) are unaffected.
const isFoldedCompanion = (row) => atHash.near(row.v, 12 * ARCSEC).some(([, o]) =>
  o !== row && o.yaleV !== undefined && Math.abs(o.dist - row.dist) / o.dist < 0.2 && row.mag - o.yaleV < 2.5);
let folded = 0;
const nearestGl = [];
for (const row of atRows) {
  if (row.used || !validDist(row.dist)) continue;
  if (isFoldedCompanion(row)) { folded++; continue; }
  const M = absMag(row.mag, row.dist);
  if (!(M >= M_BRIGHTEST)) continue;
  const bv = Number.isFinite(row.ci) ? row.ci : bvFromSpectrum(row.spect);
  const s = pushStar({ x: row.x, y: row.y, z: row.z, M, bv, src: 'athyg', gaia: row.gaia, v: row.v, dist: row.dist, V: row.mag });
  srcCount.athyg++;
  if (row.proper || row.bayer || row.flam || row.gl) {
    const [g3, supText] = (row.bayer || '').toUpperCase().split('-');
    const con = row.con ? conIndex.get(row.con.toUpperCase()) ?? -1 : -1;
    s.search = { name: row.proper || '', greek: GREEK3.indexOf(g3) + 1, sup: +supText || 0, con, flam: row.flam, hr: 0, gl: row.gl ? `Gl ${row.gl}` : '' };
  }
  if (row.proper) names.push([s, row.proper, row.gl ? `Gl ${row.gl}` : '', row.spect]);
  else if (row.gl && row.dist < 6) nearestGl.push([s, `Gl ${row.gl}`, '', row.spect]);
}
names.push(...nearestGl);
log(`AT-HYG: ${folded} close companions folded into Yale combined magnitudes`);

// Positional index of everything so far, for GCNS de-duplication.
const finalHash = new SkyHash();
for (const s of stars) {
  if (s.src === 'sun') continue;
  const d = Math.hypot(s.x, s.y, s.z);
  if (!s.v) s.v = [s.x / d, s.y / d, s.z / d];
  if (!s.dist) s.dist = d;
  if (s.V === undefined) s.V = s.M + 5 * Math.log10(d / 10);
  finalHash.add(s.v, s);
}
const atGaia = new Set(atRows.filter((r) => r.gaia).map((r) => r.gaia));

// ------------------------------------------------------------------ 5. GCNS
const g = readCsv(join(RAW, 'gcns_main.csv.gz'));
const G = g.col;
let gDupId = 0, gDupPos = 0, gFaint = 0, gNoColour = 0, gNoMag = 0;
for (const r of g.rows) {
  if (atGaia.has(r[G.source_id])) { gDupId++; continue; }
  if (!(num(r[G.gcns_prob]) > 0.38)) continue;
  const dist = num(r[G.dist_50]) * 1000;
  if (!validDist(dist)) continue;
  const gmag = num(r[G.phot_g_mean_mag]);
  if (!Number.isFinite(gmag)) { gNoMag++; continue; } // no photometry: brightness unknown
  const bp = num(r[G.phot_bp_mean_mag]), rp = num(r[G.phot_rp_mean_mag]);
  let x = bp - rp;
  if (!Number.isFinite(x)) {
    gNoColour++;
    x = num(r[G.wd_prob]) > 0.5 ? 0.3 : bpRpFromMG(gmag - 5 * Math.log10(dist / 10));
  }
  const V = gmag - gMinusV(x);
  const M = absMag(V, dist);
  if (M > M_FAINTEST) { gFaint++; continue; }
  const v = unit(num(r[G.ra]), num(r[G.dec]));
  // Bright Gaia sources are saturated duplicates of Hipparcos stars; fainter ones are
  // duplicates when position, distance and brightness all agree.
  const dup = finalHash.near(v, 60 * ARCSEC).some(([sep, s]) =>
    (gmag < 5 && Math.abs(s.V - V) < 2) ||
    (sep < 10 * ARCSEC && Math.abs(s.dist - dist) / dist < 0.25 && Math.abs(s.V - V) < 1.5));
  if (dup) { gDupPos++; continue; }
  pushStar({ x: v[0] * dist, y: v[1] * dist, z: v[2] * dist, M, bv: bvFromTeff(teffFromBpRp(x)), src: 'gcns' });
  srcCount.gcns++;
}
log(`GCNS: ${g.rows.length} rows; ${gDupId} already in AT-HYG by Gaia id, ${gDupPos} positional duplicates, ${gFaint} fainter than M=${M_FAINTEST}, ${gNoMag} without G, ${gNoColour} without BP/RP`);
log(`stars: ${stars.length} (Yale ${srcCount.yale}, AT-HYG ${srcCount.athyg}, GCNS ${srcCount.gcns}, Sun 1)`);

// ------------------------------------------------------------------ 6. bands + octrees
function bandOf(M) {
  let b = 0;
  while (b < BAND_EDGES.length && M >= BAND_EDGES[b]) b++;
  return b; // 0 .. BAND_EDGES.length
}
const bandStars = Array.from({ length: BAND_EDGES.length + 1 }, () => []);
for (const s of stars) {
  if (![s.x, s.y, s.z, s.M, s.bv].every(Number.isFinite)) throw new Error(`non-finite star ${JSON.stringify(s)}`);
  s.M = Math.max(M_BRIGHTEST, s.M);
  s.bv = Math.max(BV_MIN, Math.min(BV_MIN + 255 * BV_STEP, s.bv));
  bandStars[bandOf(s.M)].push(s);
}

const nodes = [];   // {min:[3], max:[3], start, count, firstChild, childCount, leafStars?}
const order = [];   // final star order
function bounds(list) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const s of list) {
    if (s.x < min[0]) min[0] = s.x; if (s.x > max[0]) max[0] = s.x;
    if (s.y < min[1]) min[1] = s.y; if (s.y > max[1]) max[1] = s.y;
    if (s.z < min[2]) min[2] = s.z; if (s.z > max[2]) max[2] = s.z;
  }
  return { min, max };
}
function makeNode(list, depth) {
  const { min, max } = bounds(list);
  const half = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;
  const node = { min, max, list, depth, start: 0, count: list.length, firstChild: 0, childCount: 0 };
  node.leaf = depth >= MAX_DEPTH || (list.length <= LEAF_MAX && half <= LEAF_MAX_HALF) || half === 0;
  return node;
}
function split(node) {
  const c = node.min.map((m, k) => (m + node.max[k]) / 2);
  const parts = Array.from({ length: 8 }, () => []);
  for (const s of node.list) parts[(s.x >= c[0] ? 1 : 0) | (s.y >= c[1] ? 2 : 0) | (s.z >= c[2] ? 4 : 0)].push(s);
  return parts.filter((p) => p.length);
}
// Children of a node are stored contiguously; stars of every subtree are contiguous.
function layout(index) {
  const node = nodes[index];
  node.start = order.length;
  if (node.leaf) {
    node.list.sort((a, b) => a.M - b.M); // brightest first inside a leaf
    for (const s of node.list) order.push(s);
  } else {
    const parts = split(node);
    node.firstChild = nodes.length; node.childCount = parts.length;
    for (const p of parts) nodes.push(makeNode(p, node.depth + 1));
    for (let k = 0; k < parts.length; k++) layout(node.firstChild + k);
  }
  node.count = order.length - node.start;
  if (!node.leaf) delete node.list;
}
const bands = [];
for (let b = 0; b < bandStars.length; b++) {
  const list = bandStars[b];
  if (!list.length) continue;
  let mMin = Infinity, mMax = -Infinity;
  for (const s of list) { if (s.M < mMin) mMin = s.M; if (s.M > mMax) mMax = s.M; }
  const root = nodes.length;
  nodes.push(makeNode(list, 0));
  layout(root);
  bands.push({ mMin: round(mMin, 4), mMax: round(mMax, 4), root, start: nodes[root].start, count: nodes[root].count });
}
const N = order.length;
if (N !== stars.length) throw new Error('layout lost stars');

// ------------------------------------------------------------------ 7. quantise + write
const nodeBounds = new Float32Array(nodes.length * 6);
const nodeLinks = new Uint32Array(nodes.length * 4);
const qx = new Int16Array(N), qy = new Int16Array(N), qz = new Int16Array(N);
const qm = new Uint8Array(N), qc = new Uint8Array(N);
const bandIndexOf = new Uint8Array(N);
bands.forEach((band, bi) => bandIndexOf.fill(bi, band.start, band.start + band.count));
let maxErr = 0;
nodes.forEach((n, i) => {
  nodeBounds.set([...n.min, ...n.max], i * 6);
  nodeLinks.set([n.start, n.count, n.firstChild, n.childCount], i * 4);
  if (!n.leaf) return;
  // Decode exactly as the app does: from the float32 bounds.
  const lo = nodeBounds.subarray(i * 6, i * 6 + 3), hi = nodeBounds.subarray(i * 6 + 3, i * 6 + 6);
  const mid = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  const half = [0, 1, 2].map((k) => Math.max((hi[k] - lo[k]) / 2, 1e-9));
  for (let j = n.start; j < n.start + n.count; j++) {
    const s = order[j];
    const p = [s.x, s.y, s.z];
    const q = p.map((v, k) => Math.max(-32767, Math.min(32767, Math.round((v - mid[k]) / half[k] * 32767))));
    qx[j] = q[0]; qy[j] = q[1]; qz[j] = q[2];
    for (let k = 0; k < 3; k++) maxErr = Math.max(maxErr, Math.abs(mid[k] + q[k] / 32767 * half[k] - p[k]));
    const band = bands[bandIndexOf[j]];
    const span = band.mMax - band.mMin;
    qm[j] = span > 0 ? Math.round((s.M - band.mMin) / span * 255) : 0;
    qc[j] = Math.round((s.bv - BV_MIN) / BV_STEP);
  }
});

const sections = [];
const addSection = (name, arr) => sections.push([name, arr]);
addSection('nodeBounds', nodeBounds);
addSection('nodeLinks', nodeLinks);
addSection('qx', qx); addSection('qy', qy); addSection('qz', qz);
addSection('mag', qm); addSection('bv', qc);

// Fingerprint of the star data: saved favourites remember it, so a rebuilt catalogue (new
// star order) is detected and favourites are re-resolved by position.
const idHash = createHash('sha256');
for (const [, arr] of sections) idHash.update(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
const dataId = idHash.digest('hex').slice(0, 16);
const header = {
  format: 'starfield-flight/stars', version: 1, dataId,
  starCount: N, nodeCount: nodes.length,
  bands, bv: { min: BV_MIN, step: BV_STEP }, quant: 32767,
  sources: {
    yale: 'Yale Bright Star Catalogue 5th rev. ed. (Hoffleit & Warren 1991), via Star-Sky',
    athyg: 'AT-HYG v4.0 reduced m10 subset (D. Nash / astronexus, CC BY-SA 4.0); distances: Gaia DR3 (ESA/Gaia/DPAC), Hipparcos (ESA 1997; van Leeuwen 2007)',
    gcns: 'Gaia Catalogue of Nearby Stars (Gaia Collaboration, Smart et al. 2021, A&A 649, A6), ESA/Gaia/DPAC',
  },
  counts: { ...srcCount, yaleSpectroscopic: estimated },
};
let offset = 0;
const layoutSec = {};
const align = (n) => (n + 3) & ~3;
// header is written after the 8-byte prefix; compute section offsets relative to file start
let headerText = '';
for (let pass = 0; pass < 2; pass++) {
  header.sections = layoutSec;
  headerText = JSON.stringify(header);
  const headerBytes = align(Buffer.byteLength(headerText) + 64);
  offset = 8 + headerBytes;
  for (const [name, arr] of sections) {
    offset = align(offset);
    layoutSec[name] = [offset, arr.byteLength];
    offset += arr.byteLength;
  }
}
headerText = JSON.stringify(header);
const headerBytes = align(Buffer.byteLength(headerText) + 64);
const file = Buffer.alloc(align(offset));
file.write('SFC1', 0, 'ascii');
file.writeUInt32LE(headerBytes, 4);
file.write(headerText.padEnd(headerBytes, ' '), 8, 'utf8');
for (const [name, arr] of sections) Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).copy(file, layoutSec[name][0]);
writeFileSync(join(OUT, 'stars.bin'), file);
log(`wrote public/data/stars.bin: ${(file.length / 1048576).toFixed(2)} MB, ${N} stars, ${nodes.length} nodes, ${bands.length} bands; max quantisation error ${(maxErr * 206265).toFixed(0)} AU`);
bands.forEach((b) => log(`  band M ${b.mMin.toFixed(2)}..${b.mMax.toFixed(2)}: ${b.count} stars`));

// ------------------------------------------------------------------ 8. names
const indexOf = new Map(order.map((s, i) => [s, i]));
const seen = new Set();
const labels = [];
for (const [s, name, desig, sp, note] of names) {
  const i = indexOf.get(s);
  if (i === undefined || seen.has(i)) continue;
  seen.add(i);
  const entry = [i, name, desig || '', (sp || '').replace(/\s+/g, '')];
  if (note) entry.push(note);
  labels.push(entry);
}
labels.sort((a, b) => a[0] - b[0]);
writeFileSync(join(OUT, 'names.json'), JSON.stringify({ fields: ['index', 'name', 'designation', 'spectrum', 'note?'], labels }) + '\n');
log(`wrote public/data/names.json: ${labels.length} labels`);

// ------------------------------------------------------------------ 9. search index
// Every designated star: [index, proper name, Bayer letter (1-24), superscript, constellation,
// Flamsteed number, HR number, Gliese id]; trailing empty fields dropped. The app expands
// these into the spellings people type ("Alpha Centauri", "alf Cen", "61 Cyg", "HR 7001").
const searchRows = [];
for (const st of order) {
  const q = st.search;
  if (!q || st.src === 'sun') continue;
  const row = [indexOf.get(st), q.name || '', q.greek || 0, q.sup || 0, q.con ?? -1, q.flam || 0, q.hr || 0, q.gl || ''];
  while (row.length > 2 && (row[row.length - 1] === 0 || row[row.length - 1] === '' || row[row.length - 1] === -1)) row.pop();
  searchRows.push(row);
}
writeFileSync(join(OUT, 'search.json'), JSON.stringify({
  fields: ['index', 'name', 'bayer', 'sup', 'con', 'flamsteed', 'hr', 'gliese'],
  con: cons.abbr, gen: cons.gen, name: cons.name, stars: searchRows,
}) + '\n');
log(`wrote public/data/search.json: ${searchRows.length} designated stars`);

// ------------------------------------------------------------------ 10. constellation figures
// d3-celestial stick figures (as matched to Yale stars by Star-Sky), re-pointed at the 3D
// catalogue: segments join real stars, so the figures distort correctly as you fly.
const figures = [];
let segCount = 0, segDropped = 0;
for (const [con, polys] of cons.lines) {
  const pairs = [];
  for (const poly of polys) {
    for (let k = 0; k + 1 < poly.length; k++) {
      const a = poly[k] >= 0 ? yaleStar[poly[k]] : null, b = poly[k + 1] >= 0 ? yaleStar[poly[k + 1]] : null;
      if (!a || !b) { segDropped++; continue; }
      pairs.push(indexOf.get(a), indexOf.get(b));
      segCount++;
    }
  }
  figures.push([con, ...pairs]);
}
writeFileSync(join(OUT, 'constellations.json'), JSON.stringify({
  fields: ['constellation', 'star a', 'star b', '...'], abbr: cons.abbr, name: cons.name, rank: cons.rank, figures,
}) + '\n');
log(`wrote public/data/constellations.json: ${figures.length} figures, ${segCount} segments (${segDropped} dropped)`);
