// Star and planet search. Built once at load time from public/data/search.json (every
// designated star: IAU name, Bayer letter, Flamsteed number, HR and Gliese numbers) plus the
// Solar System bodies and a list of common aliases. Each entry gets every spelling people
// type: "Alpha Centauri", "alpha cen", "alf Cen", "α Cen", "61 Cygni", "HR 7001", "Gl 581".
// Matching is exact > prefix > word prefix > substring > one typo, ties broken by fame.

const GREEK = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu',
  'nu', 'xi', 'omicron', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega'];
const GREEK_SYMBOLS = 'αβγδεζηθικλμνξοπρστυφχψω';
const GREEK_ABBR = { alf: 'alpha', alp: 'alpha', bet: 'beta', gam: 'gamma', del: 'delta', eps: 'epsilon', zet: 'zeta',
  the: 'theta', iot: 'iota', kap: 'kappa', lam: 'lambda', omi: 'omicron', ups: 'upsilon', ome: 'omega', sig: 'sigma' };
const SUPERSCRIPTS = '⁰¹²³⁴⁵⁶⁷⁸⁹';

// People's names for stars that are not their IAU names. [alias, target name or HR number]
const ALIASES = [
  ['Alpha Centauri', 5459], ['Alpha Centauri A', 5459], ['Alpha Centauri B', 5460], ['Rigel Kentaurus', 5459],
  ['Rigil Kent', 5459], ['Proxima', 'Proxima Centauri'], ['Alpha Centauri C', 'Proxima Centauri'],
  ['North Star', 424], ['Pole Star', 424], ['Polar Star', 424], ['Lodestar', 424], ['Dog Star', 2491], ['Sirius A', 2491],
  ['Agena', 5267], ['Beta Centauri', 5267], ['Betelgeux', 2061], ['Alpha Orionis', 2061], ['Polaris Australis', 7228],
  ["Barnard's", "Barnard's Star"], ['Barnards Star', "Barnard's Star"], ['Eta Carinae', 4210], ['Algol', 936],
];
const BODY_ALIASES = { sun: ['Sol', 'The Sun'], moon: ['Luna', 'The Moon'], earth: ['Terra', 'Home'] };

/** Lower case, no accents or punctuation, Greek letters spelled out, numbers split from words. */
export function normalize(text) {
  let s = String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/[αβγδεζηθικλμνξοπρστυφχψω]/g, (c) => ` ${GREEK[GREEK_SYMBOLS.indexOf(c)]} `);
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (c) => SUPERSCRIPTS.indexOf(c));
  s = s.replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ');
  // "alpha1" / "pi2" -> "alpha 1" so superscripted components match either way
  s = s.replace(/\b([a-z]+)(\d)\b/g, '$1 $2');
  s = s.split(' ').filter(Boolean).map((w) => GREEK_ABBR[w] || w).join(' ');
  return s.trim();
}

/** Damerau-Levenshtein distance capped at `max` (returns max + 1 beyond it). */
export function editDistance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2 = new Array(b.length + 1), prev = new Array(b.length + 1), cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) { prev2[j] = prev[j]; prev[j] = cur[j]; }
  }
  return prev[b.length];
}

export class SearchIndex {
  /**
   * @param data     parsed search.json
   * @param catalog  decoded star catalogue (for fame: brightness seen from the Sun)
   * @param bodies   Solar System bodies [{ id, name, type }]
   */
  constructor(data, catalog, bodies = []) {
    this.entries = [];      // { keys: [normalized], display, detail, target, fame, named }
    this.byKey = new Map(); // normalized -> entries (exact matches)
    const sup = (n) => (n ? SUPERSCRIPTS[n] : '');
    const byHr = new Map(), byName = new Map();
    for (const row of data.stars) {
      const [index, name = '', greek = 0, supN = 0, con = -1, flam = 0, hr = 0, gl = ''] = row;
      const abbr = con >= 0 ? data.con[con] : '', gen = con >= 0 ? data.gen[con] : '';
      const spellings = [];
      const desigs = [];
      if (name) spellings.push(name);
      if (greek && abbr) {
        const g = GREEK[greek - 1];
        desigs.push(`${GREEK_SYMBOLS[greek - 1]}${sup(supN)} ${abbr}`);
        spellings.push(`${g} ${supN || ''} ${abbr}`, `${g} ${supN || ''} ${gen}`);
        // "Alpha Centauri" also finds alpha-1 / alpha-2 Centauri
        if (supN) spellings.push(`${g} ${abbr}`, `${g} ${gen}`);
      }
      if (flam && abbr) { desigs.push(`${flam} ${abbr}`); spellings.push(`${flam} ${abbr}`, `${flam} ${gen}`); }
      if (hr) { desigs.push(`HR ${hr}`); spellings.push(`HR ${hr}`); }
      if (gl) { desigs.push(gl); spellings.push(gl, gl.replace(/^Gl /, 'Gliese '), gl.replace(/^Gl /, 'GJ ')); }
      const p = catalog.position(index);
      const d = Math.hypot(p[0], p[1], p[2]);
      const mag = catalog.absMag(index) + 5 * Math.log10(Math.max(d, 1e-6)) - 5;
      const display = name || desigs[0] || `Star ${index}`;
      const entry = this.add(spellings, display, desigs.filter((x) => x !== display).slice(0, 2).join(' · '),
        { kind: 'star', index }, mag - (name ? 4 : 0), !!name);
      if (hr) byHr.set(hr, entry);
      if (name) byName.set(normalize(name), entry);
    }
    for (const b of bodies) {
      this.add([b.name, ...(BODY_ALIASES[b.id] || [])], b.name, b.type === 'star' ? 'our star' : b.type, { kind: 'body', id: b.id }, -50, true);
    }
    for (const [alias, to] of ALIASES) {
      const target = typeof to === 'number' ? byHr.get(to) : byName.get(normalize(to));
      if (!target) continue;
      const k = normalize(alias);
      target.keys.push(k);
      target.words.push(k.split(' '));
      this.addKey(k, target);
    }
  }

  add(spellings, display, detail, target, fame, named) {
    const keys = [...new Set(spellings.map(normalize).filter(Boolean))];
    const entry = { keys, words: keys.map((k) => k.split(' ')), display, detail, target, fame, named };
    this.entries.push(entry);
    for (const k of keys) this.addKey(k, entry);
    return entry;
  }

  addKey(k, entry) {
    const list = this.byKey.get(k);
    if (!list) this.byKey.set(k, [entry]); else if (!list.includes(entry)) list.push(entry);
  }

  /** Best matches for `query`: [{ entry, score }] sorted best first. */
  query(query, limit = 8) {
    const q = normalize(query);
    if (!q) return [];
    const best = new Map();
    // Tiers: exact 0, prefix 1, word prefix 2, substring 3, typo 4+; inside a tier the more
    // famous (brighter seen from the Sun, named, or a planet) wins.
    const consider = (entry, tier) => {
      const s = tier + Math.min(0.9, Math.max(0, (entry.fame + 60) / 100));
      const prev = best.get(entry);
      if (prev === undefined || s < prev) best.set(entry, s);
    };
    for (const e of this.byKey.get(q) || []) consider(e, 0);
    const single = !q.includes(' ');
    let strong = best.size > 0;
    for (const e of this.entries) {
      const { keys, words } = e;
      for (let j = 0; j < keys.length; j++) {
        const k = keys[j];
        if (k === q) continue;
        if (k.startsWith(q)) { consider(e, 1); strong = true; }
        else if (single && words[j].some((w) => w.startsWith(q))) consider(e, 2);
        else if (q.length >= 3 && k.includes(q)) consider(e, 3);
      }
    }
    // One or two typos in a name ("betelguese", "acturus"): only for proper names, and only
    // when nothing matched exactly or as a prefix.
    if (!strong && q.length >= 4) {
      const maxEdits = q.length >= 7 ? 2 : 1;
      for (const e of this.entries) {
        if (!e.named) continue;
        for (const k of e.keys) {
          const head = k.slice(0, q.length + 1);
          const d = Math.min(editDistance(q, k, maxEdits), editDistance(q, head, maxEdits));
          if (d <= maxEdits) consider(e, 4 + d);
        }
      }
    }
    return [...best.entries()].sort((a, b) => a[1] - b[1]).slice(0, limit).map(([entry, score]) => ({ entry, score }));
  }

  /** Entry for a target ({ kind: 'star', index } or { kind: 'body', id }), if indexed. */
  lookup(target) {
    return this.entries.find((e) => (target.kind === 'star' ? e.target.index === target.index : e.target.id === target.id));
  }
}
