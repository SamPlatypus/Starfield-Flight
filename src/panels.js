// Search and Favourites panels. Both list targets ({ kind: 'star', index } or
// { kind: 'body', id }) with their live distance from the ship; choosing one hands it to
// the app, which turns the ship towards it (search) or flies there (favourites).
import { formatDistance } from './math.js';
import { FAVOURITES_LIMIT } from './favourites.js';

// Shown before anything is typed.
const SUGGESTIONS = ['Sun', 'Earth', 'Moon', 'Jupiter', 'Saturn', 'Alpha Centauri', 'Sirius', 'Betelgeuse', 'Polaris', 'Vega'];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class SearchPanel {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.input = root.querySelector('input');
    this.list = root.querySelector('.results');
    this.heading = root.querySelector('.heading');
    this.results = [];
    this.input.addEventListener('input', () => this.run());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (this.results[0]) this.choose(this.results[0]); }
      else if (e.key === 'Escape') { e.preventDefault(); this.close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); this.list.querySelector('button')?.focus(); }
    });
    this.list.addEventListener('keydown', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); b.parentElement.nextElementSibling?.querySelector('button')?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (b.parentElement.previousElementSibling?.querySelector('button') ?? this.input).focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    });
    this.list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (b) this.choose(this.results[+b.dataset.i]);
    });
    root.querySelector('.close').addEventListener('click', () => this.close());
  }

  get open() { return !this.root.hidden; }

  show() {
    this.root.hidden = false;
    this.input.value = '';
    this.run();
    // focus inside the tap itself: iOS only opens the keyboard then, and no keystroke is lost
    this.input.focus({ preventScroll: true });
  }

  close() {
    if (this.root.hidden) return false;
    this.root.hidden = true;
    this.input.blur();
    return true;
  }

  run() {
    const q = this.input.value.trim();
    const search = this.app.search;
    if (!q) {
      this.results = SUGGESTIONS.map((name) => search.query(name, 1)[0]?.entry).filter(Boolean);
      this.heading.textContent = 'Try a name like Sirius, a designation like α Cen, 61 Cyg or HR 7001, or a planet';
    } else {
      this.results = search.query(q, 8).map((r) => r.entry);
      this.heading.textContent = this.results.length ? '' : `Nothing found for “${q}”`;
    }
    this.render();
  }

  render() {
    const app = this.app;
    this.list.replaceChildren(...this.results.map((entry, i) => {
      const li = el('li');
      const b = el('button', 'result');
      b.type = 'button';
      b.dataset.i = i;
      const text = el('span', 'text');
      text.append(el('b', '', entry.display));
      if (entry.detail) text.append(el('span', 'detail', entry.detail));
      const p = app.targetPosition(entry.target);
      const s = app.ship.pos;
      b.append(text, el('span', 'dist', formatDistance(Math.hypot(p[0] - s[0], p[1] - s[1], p[2] - s[2]))));
      if (app.favourites.has(entry.target)) b.append(el('span', 'star', '★'));
      li.append(b);
      return li;
    }));
  }

  choose(entry) {
    this.close();
    this.app.select(entry.target);
  }
}

export class FavouritesPanel {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.list = root.querySelector('.favs');
    this.count = root.querySelector('.count');
    this.empty = root.querySelector('.empty');
    this.timer = 0;
    app.favourites.onChange(() => { if (this.open && !this.editing) this.render(); });
    this.list.addEventListener('click', (e) => {
      const row = e.target.closest('[data-id]');
      if (!row) return;
      const it = app.favourites.items.find((x) => x.id === row.dataset.id);
      if (!it) return;
      if (e.target.closest('.rename')) this.rename(row, it);
      else if (e.target.closest('.remove')) {
        app.favourites.remove(it.id);
        app.hud.syncFav();
        app.hud.toast(`Removed ${it.name} from favourites`);
      } else if (e.target.closest('.go')) {
        this.close();
        app.flyToTarget(app.favourites.target(it));
      }
    });
    root.querySelector('.close').addEventListener('click', () => this.close());
  }

  get open() { return !this.root.hidden; }

  show() {
    this.root.hidden = false;
    this.render();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.updateDistances(), 400);
  }

  close() {
    if (this.root.hidden) return false;
    this.root.hidden = true;
    this.editing = false;
    clearInterval(this.timer);
    return true;
  }

  describe(it) {
    if (it.kind === 'body') return this.app.solar.get(it.body)?.type ?? '';
    const info = this.app.starInfo(it.index);
    return it.name !== info.name ? info.name : '';
  }

  render() {
    const items = this.app.favourites.items;
    this.count.textContent = `${items.length} / ${FAVOURITES_LIMIT}`;
    this.empty.hidden = items.length > 0;
    this.list.replaceChildren(...items.map((it) => {
      const li = el('li', 'fav-row');
      li.dataset.id = it.id;
      const go = el('button', 'go');
      go.type = 'button';
      go.setAttribute('aria-label', `Fly to ${it.name}`);
      const text = el('span', 'text');
      text.append(el('b', 'name', it.name));
      const what = this.describe(it);
      if (what) text.append(el('span', 'detail', what));
      go.append(text, el('span', 'dist', ''));
      const ren = el('button', 'icon rename', '✎');
      ren.type = 'button';
      ren.setAttribute('aria-label', `Rename ${it.name}`);
      const rem = el('button', 'icon remove', '×');
      rem.type = 'button';
      rem.setAttribute('aria-label', `Remove ${it.name}`);
      li.append(go, ren, rem);
      return li;
    }));
    this.updateDistances();
  }

  updateDistances() {
    const app = this.app, s = app.ship.pos;
    for (const li of this.list.children) {
      const it = app.favourites.items.find((x) => x.id === li.dataset.id);
      if (!it) continue;
      const p = app.targetPosition(app.favourites.target(it));
      const d = formatDistance(Math.hypot(p[0] - s[0], p[1] - s[1], p[2] - s[2]));
      const span = li.querySelector('.dist');
      if (span.textContent !== d) span.textContent = d;
    }
  }

  rename(row, it) {
    if (this.editing) return;
    this.editing = true;
    const go = row.querySelector('.go');
    const input = el('input', 'rename-input');
    input.type = 'text';
    input.value = it.name;
    input.maxLength = 60;
    input.setAttribute('aria-label', 'Rename favourite');
    input.setAttribute('enterkeyhint', 'done');
    go.replaceWith(input);
    input.addEventListener('click', (e) => e.stopPropagation());
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      this.editing = false;
      if (save) this.app.favourites.rename(it.id, input.value); else this.render();
      this.app.hud.syncFav();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.focus();
    input.select();
  }
}
