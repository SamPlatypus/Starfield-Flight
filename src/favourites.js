// Favourite stars and Solar System bodies, kept in localStorage.
//
// A star is stored by catalogue index *and* by what it is: the catalogue's dataId plus the
// star's position and absolute magnitude. While the dataId matches, the index is used as
// is; after a catalogue rebuild (new star order) favourites are found again by position.
const KEY = 'starfield-flight.favourites.v1';
export const FAVOURITES_LIMIT = 100;

export class Favourites {
  /**
   * @param catalog  decoded star catalogue (position(), absMag(), header.dataId, bands)
   * @param storage  localStorage-like object (injectable for tests)
   */
  constructor(catalog, storage = globalThis.localStorage) {
    this.catalog = catalog;
    this.storage = storage;
    this.dataId = catalog.header.dataId || '';
    this.items = [];
    this.listeners = new Set();
    this.load();
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this.items); }

  load() {
    let saved = [];
    try { saved = JSON.parse(this.storage?.getItem(KEY) || '{"items":[]}').items || []; } catch { saved = []; }
    this.items = [];
    let migrated = false;
    for (const it of saved) {
      if (it.kind === 'body' && typeof it.body === 'string') { this.items.push(it); continue; }
      if (it.kind !== 'star') continue;
      const index = this.resolve(it);
      if (index < 0) continue; // no longer in the catalogue
      if (index !== it.index || it.data !== this.dataId) { migrated = true; Object.assign(it, this.fingerprint(index)); }
      this.items.push(it);
    }
    if (migrated) this.save();
  }

  save() {
    try { this.storage?.setItem(KEY, JSON.stringify({ version: 1, items: this.items })); } catch { /* full or unavailable */ }
    this.emit();
  }

  fingerprint(index) {
    const p = this.catalog.position(index);
    return {
      index, data: this.dataId,
      ref: [+p[0].toFixed(6), +p[1].toFixed(6), +p[2].toFixed(6), +this.catalog.absMag(index).toFixed(3)],
    };
  }

  /** Current catalogue index of a saved star (-1 when it cannot be found). */
  resolve(it) {
    const cat = this.catalog;
    if (it.data === this.dataId && it.index >= 0 && it.index < cat.count) return it.index;
    if (!Array.isArray(it.ref)) return -1;
    const [x, y, z, M] = it.ref;
    // Search the magnitude band the star belongs to for the same point in space.
    let best = -1, bestD = 0.01 + 1e-4 * Math.hypot(x, y, z);
    for (const band of cat.bands) {
      if (M < band.mMin - 0.05 || M > band.mMax + 0.05) continue;
      for (let i = band.start, end = band.start + band.count; i < end; i++) {
        const p = cat.position(i);
        const d = Math.hypot(p[0] - x, p[1] - y, p[2] - z);
        if (d < bestD && Math.abs(cat.absMag(i) - M) < 0.1) { bestD = d; best = i; }
      }
    }
    return best;
  }

  key(target) { return target.kind === 'star' ? `s${target.index}` : `b${target.id}`; }
  find(target) {
    return this.items.find((it) => (target.kind === 'star' ? it.kind === 'star' && it.index === target.index : it.kind === 'body' && it.body === target.id));
  }
  has(target) { return !!this.find(target); }

  /** Adds a favourite; returns it, or null when the list is full. */
  add(target, name) {
    const existing = this.find(target);
    if (existing) return existing;
    if (this.items.length >= FAVOURITES_LIMIT) return null;
    const item = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      kind: target.kind, name, original: name, added: Date.now(),
      ...(target.kind === 'star' ? this.fingerprint(target.index) : { body: target.id }),
    };
    this.items.push(item);
    this.save();
    return item;
  }

  remove(id) {
    const n = this.items.length;
    this.items = this.items.filter((it) => it.id !== id);
    if (this.items.length !== n) this.save();
  }

  rename(id, name) {
    const it = this.items.find((x) => x.id === id);
    const clean = String(name || '').trim().slice(0, 60);
    if (!it) return;
    it.name = clean || it.original;
    this.save();
  }

  toggle(target, name) {
    const it = this.find(target);
    if (it) { this.remove(it.id); return false; }
    return this.add(target, name) ? true : null;
  }

  /** Target object for flying / selecting. */
  target(it) { return it.kind === 'star' ? { kind: 'star', index: it.index } : { kind: 'body', id: it.body }; }
}
