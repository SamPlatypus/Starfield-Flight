// Star search: names, designations, aliases, prefixes, typos and Solar System bodies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCatalog } from '../src/catalog.js';
import { SearchIndex, normalize, editDistance } from '../src/search.js';
import { BODIES } from '../src/solar/bodies.js';

const buf = readFileSync(new URL('../public/data/stars.bin', import.meta.url));
const cat = parseCatalog(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const data = JSON.parse(readFileSync(new URL('../public/data/search.json', import.meta.url), 'utf8'));
const t0 = performance.now();
const index = new SearchIndex(data, cat, BODIES);
const buildMs = performance.now() - t0;

// HR number of each star from its search.json row, to check results against the catalogue.
const hrOf = new Map(data.stars.map((r) => [r[0], r[6] || 0]));
const top = (q) => index.query(q, 8)[0]?.entry;
const topHr = (q) => { const e = top(q); return e && e.target.kind === 'star' ? hrOf.get(e.target.index) : null; };

test('normalisation folds case, accents, Greek letters and abbreviations', () => {
  assert.equal(normalize('α¹ Cen'), 'alpha 1 cen');
  assert.equal(normalize('Alf Cen'), 'alpha cen');
  assert.equal(normalize("Barnard's Star"), 'barnards star');
  assert.equal(normalize('Añañuca'), 'ananuca');
  assert.equal(normalize('  Pi2  ORI '), 'pi 2 ori');
  assert.equal(editDistance('betelguese', 'betelgeuse'), 1);
});

test('the index builds quickly and covers the catalogue designations', () => {
  assert.ok(buildMs < 1500, `built in ${buildMs.toFixed(0)} ms`);
  assert.ok(index.entries.length > 11000);
});

test('every well-known star resolves to the right catalogue entry', () => {
  // name -> HR number in the Yale Bright Star Catalogue
  const expect = {
    Sirius: 2491, Canopus: 2326, 'Alpha Centauri': 5459, Arcturus: 5340, Vega: 7001, Capella: 1708, Rigel: 1713,
    Procyon: 2943, Betelgeuse: 2061, Achernar: 472, Hadar: 5267, Altair: 7557, Acrux: 4730, Aldebaran: 1457,
    Spica: 5056, Antares: 6134, Pollux: 2990, Fomalhaut: 8728, Deneb: 7924, Mimosa: 4853, Regulus: 3982,
    Adhara: 2618, Castor: 2891, Gacrux: 4763, Shaula: 6527, Bellatrix: 1790, Elnath: 1791, Alnilam: 1903,
    Alnitak: 1948, Mirfak: 1017, Dubhe: 4301, Alkaid: 5191, Polaris: 424, Mizar: 5054, Algol: 936,
  };
  for (const [name, hr] of Object.entries(expect)) assert.equal(topHr(name), hr, `${name}`);
});

test('designations and aliases', () => {
  assert.equal(topHr('alpha centauri'), 5459);
  assert.equal(topHr('Rigil Kentaurus'), 5459);
  assert.equal(topHr('Toliman'), 5460);
  assert.equal(topHr('α CMa'), 2491);
  assert.equal(topHr('alf CMa'), 2491);
  assert.equal(topHr('Alpha Canis Majoris'), 2491);
  assert.equal(topHr('9 CMa'), 2491);
  assert.equal(topHr('HR 7001'), 7001);
  assert.equal(topHr('61 Cygni'), 8085);
  assert.equal(topHr('North Star'), 424);
  assert.equal(topHr('Dog Star'), 2491);
  assert.equal(topHr('Agena'), 5267);
  assert.equal(top('Proxima').display, 'Proxima Centauri');
  assert.equal(top("Barnard's Star").display, "Barnard's Star");
  assert.match(top('Gliese 581')?.display ?? '', /581/);
});

test('prefixes, typos and planets', () => {
  assert.equal(topHr('betelg'), 2061);
  assert.equal(topHr('betelguese'), 2061);
  assert.equal(topHr('acturus'), 5340);
  assert.equal(topHr('aldebren'), 1457);
  assert.deepEqual(top('Jupiter').target, { kind: 'body', id: 'jupiter' });
  assert.deepEqual(top('sun').target, { kind: 'body', id: 'sun' });
  assert.deepEqual(top('Sol').target, { kind: 'body', id: 'sun' });
  assert.deepEqual(top('moon').target, { kind: 'body', id: 'moon' });
  assert.deepEqual(top('titan').target, { kind: 'body', id: 'titan' });
  // "Sa" lists Saturn before obscure stars
  assert.equal(index.query('sat', 3)[0].entry.display, 'Saturn');
  assert.deepEqual(index.query('', 5), []);
  assert.deepEqual(index.query('zzzzqqq', 5), []);
});

test('queries are fast', () => {
  const t = performance.now();
  for (const q of ['s', 'si', 'sir', 'siri', 'sirius', 'alpha c', 'betelgu', 'hr 1', '61 cy', 'xyzzy']) index.query(q, 8);
  const ms = (performance.now() - t) / 10;
  assert.ok(ms < 40, `${ms.toFixed(1)} ms per query`);
});
