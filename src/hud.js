// Heads-up display: the Sol direction marker, the selected-star bracket, star name labels,
// the speed / distance readout, toasts and the star info card. Everything is positioned
// with compositor-only transforms in the same animation frame as the WebGL draw.
import { formatDistance, formatSpeed, apparentMag } from './math.js';

const LABELS = 7;
const EDGE = 34;

export class Projector {
  constructor() {
    this.view = new Float32Array(9);
    this.cam = [0, 0, 0];
    this.tanX = 1; this.tanY = 1; this.w = 1; this.h = 1;
  }
  /** View-space position of a world point (camera looks down -z). */
  toView(p, out = [0, 0, 0]) {
    return this.toViewXYZ(p[0], p[1], p[2], out);
  }
  toViewXYZ(px, py, pz, out) {
    const x = px - this.cam[0], y = py - this.cam[1], z = pz - this.cam[2];
    const v = this.view;
    out[0] = v[0] * x + v[3] * y + v[6] * z;
    out[1] = v[1] * x + v[4] * y + v[7] * z;
    out[2] = v[2] * x + v[5] * y + v[8] * z;
    return out;
  }
  /** CSS pixel position of a view-space point in front of the camera. */
  toScreen(v) {
    return [
      (v[0] / (-v[2] * this.tanX) * 0.5 + 0.5) * this.w,
      (0.5 - v[1] / (-v[2] * this.tanY) * 0.5) * this.h,
    ];
  }
  /** World direction of a CSS pixel. */
  ray(x, y) {
    const vx = ((x / this.w) * 2 - 1) * this.tanX, vy = (1 - (y / this.h) * 2) * this.tanY, vz = -1;
    const v = this.view; // world = V^T * view
    const d = [v[0] * vx + v[1] * vy + v[2] * vz, v[3] * vx + v[4] * vy + v[5] * vz, v[6] * vx + v[7] * vy + v[8] * vz];
    const l = Math.hypot(d[0], d[1], d[2]);
    return [d[0] / l, d[1] / l, d[2] / l];
  }
}

/** Describes a star from its colour and luminosity, e.g. "orange dwarf". */
export function describeStar(bv, M) {
  const colour = bv < -0.1 ? 'blue' : bv < 0.15 ? 'blue-white' : bv < 0.45 ? 'white' : bv < 0.8 ? 'yellow' : bv < 1.35 ? 'orange' : 'red';
  let kind;
  if (M > 10 && bv < 0.5) kind = 'white dwarf';
  else if (M < -5) kind = 'supergiant';
  else if (M < -1.5) kind = 'giant';
  else if (bv > 0.85 && M < 2.5) kind = 'giant';
  else kind = 'dwarf';
  return kind === 'white dwarf' ? kind : `${colour} ${kind}`;
}

export class Hud {
  constructor(app) {
    this.app = app;
    const $ = (s) => document.querySelector(s);
    this.root = $('#hud');
    this.sol = $('#sol');
    this.solDist = this.sol.querySelector('.dist');
    this.solTag = this.sol.querySelector('.tag');
    this.solArrow = this.sol.querySelector('.arrow');
    this.target = $('#target');
    this.targetName = this.target.querySelector('.name');
    this.targetDist = this.target.querySelector('.dist');
    this.targetTag = this.target.querySelector('.tag');
    this.targetArrow = this.target.querySelector('.arrow');
    this.speed = $('#readout .value');
    this.solReadout = $('#readout .sol-dist');
    this.mode = $('#readout .mode');
    this.toastEl = $('#toast');
    this.card = $('#card');
    this.labelsEl = $('#labels');
    this.labels = [];
    for (let i = 0; i < LABELS; i++) {
      const el = document.createElement('div');
      el.className = 'label';
      el.innerHTML = '<span class="n"></span><span class="d"></span>';
      this.labelsEl.appendChild(el);
      this.labels.push({ el, n: el.firstChild, d: el.lastChild, index: -1, text: '', dist: '' });
    }
    this.v = [0, 0, 0];
    this.lastText = 0;
    this.showLabels = true;
    this.cardStar = -1;
  }

  /** Safe-area-aware rectangle the edge arrows run along. */
  edgeRect(w, h) {
    if (!this.insets || this.insetsW !== w || this.insetsH !== h) {
      // env() values are only exposed through computed styles; measure once per size.
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;visibility:hidden;padding:var(--sat) var(--sar) var(--sab) var(--sal)';
      document.body.appendChild(probe);
      const s = getComputedStyle(probe);
      this.insets = [parseFloat(s.paddingTop) || 0, parseFloat(s.paddingRight) || 0, parseFloat(s.paddingBottom) || 0, parseFloat(s.paddingLeft) || 0];
      probe.remove();
      this.insetsW = w; this.insetsH = h;
    }
    const [t, r, b, l] = this.insets;
    return { x0: l + EDGE, x1: w - r - EDGE, y0: t + EDGE + 24, y1: h - b - EDGE - 10 };
  }

  /** Places a marker on screen or as an arrow on the screen edge. Returns view-space distance. */
  placeMarker(el, arrow, tag, worldPos, proj) {
    const v = proj.toView(worldPos, this.v);
    const r = this.edgeRect(proj.w, proj.h);
    let x, y, edge = false;
    if (v[2] < 0) {
      [x, y] = proj.toScreen(v);
      edge = x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1;
    } else {
      edge = true;
    }
    if (edge) {
      // Direction on screen towards the target (also correct when it is behind us).
      let dx = v[0] / proj.tanX, dy = -v[1] / proj.tanY;
      if (v[2] < 0 && Math.hypot(dx, dy) < 1e-9) dy = 1;
      if (v[2] >= 0 && Math.hypot(dx, dy) < 1e-6 * Math.abs(v[2])) dy = 1;
      const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
      const hx = (r.x1 - r.x0) / 2, hy = (r.y1 - r.y0) / 2;
      const l = Math.hypot(dx, dy); dx /= l; dy /= l;
      const t = Math.min(Math.abs(dx) > 1e-9 ? hx / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-9 ? hy / Math.abs(dy) : Infinity);
      x = cx + dx * t; y = cy + dy * t;
      arrow.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
      // Put the tag beside the arrow, on the side facing the middle of the screen.
      const tx = Math.abs(dx) < 0.45 ? '-50%' : dx > 0 ? 'calc(-100% - 20px)' : '20px';
      const ty = Math.abs(dy) < 0.45 ? '-50%' : dy > 0 ? 'calc(-100% - 20px)' : '20px';
      tag.style.transform = `translate(${tx}, ${ty})`;
    } else {
      tag.style.transform = '';
    }
    el.classList.toggle('edge', edge);
    el.classList.add('on');
    el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    return edge;
  }

  update(f) {
    const { proj, ship, catalog } = f;
    const now = f.now;
    const textTick = now - this.lastText > 120;
    if (textTick) this.lastText = now;

    // ---- Sol
    const solDistPc = Math.hypot(ship.pos[0], ship.pos[1], ship.pos[2]);
    this.placeMarker(this.sol, this.solArrow, this.solTag, [0, 0, 0], proj);
    this.sol.classList.toggle('autopilot', ship.autopilot && ship.target?.kind === 'sol');
    if (textTick) {
      const d = formatDistance(solDistPc);
      this.solDist.textContent = d;
      this.solReadout.textContent = `Sol ${d}`;
      this.speed.textContent = formatSpeed(ship.speed);
      const mode = ship.autopilot ? 'Autopilot' : ship.boost > 0.5 ? 'Boost' : '';
      if (this.mode.textContent !== mode) this.mode.textContent = mode;
    }

    // ---- selected star
    const t = ship.target && ship.target.kind === 'star' ? ship.target : this.app.selected;
    if (t && t.kind === 'star') {
      const p = catalog.position(t.index);
      this.placeMarker(this.target, this.targetArrow, this.targetTag, p, proj);
      if (textTick) {
        this.targetName.textContent = t.name;
        this.targetDist.textContent = formatDistance(Math.hypot(p[0] - ship.pos[0], p[1] - ship.pos[1], p[2] - ship.pos[2]));
      }
    } else {
      this.target.classList.remove('on');
    }

    if (this.showLabels) this.updateLabels(f, textTick, t ? t.index : -1);
    if (this.cardStar >= 0 && textTick) this.fillCard(this.cardStar, f);
  }

  /** Screen rectangles of the on-screen controls, which labels must not cover. */
  blockerRects(w, h) {
    const cinema = this.root.classList.contains('cinema');
    if (!this.blockers || this.blockW !== w || this.blockH !== h || this.blockCinema !== cinema) {
      this.blockW = w; this.blockH = h; this.blockCinema = cinema;
      this.blockers = cinema ? [] : ['#speed-slider', '#density-slider', '#boost', '#menu-btn', '#readout']
        .map((sel) => document.querySelector(sel)?.getBoundingClientRect())
        .filter((b) => b && b.width > 0)
        .map((b) => [b.left - 8, b.top - 8, b.right + 8, b.bottom + 8]);
    }
    return this.blockers;
  }

  updateLabels(f, textTick, skip) {
    const { proj, catalog, names, magLimit } = f;
    const v = this.v;
    const cands = [];
    const r = this.edgeRect(proj.w, proj.h);
    const blockers = this.blockerRects(proj.w, proj.h);
    const tex = catalog.tex;
    for (const s of names) {
      if (s.index === skip || s.name === 'Sol') continue;
      const k = s.index * 4;
      proj.toViewXYZ(tex[k], tex[k + 1], tex[k + 2], v);
      if (v[2] >= 0) continue;
      const d = Math.hypot(v[0], v[1], v[2]);
      const m = apparentMag(catalog.absMag(s.index), d);
      if (m > magLimit - 1.6 && d > 0.3) continue;
      const [x, y] = proj.toScreen(v);
      if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue;
      // label box (it flips to the left of its star near the right edge)
      const lw = 8 + 6.5 * s.name.length;
      const lx0 = x > proj.w - 120 ? x - 9 - lw : x, lx1 = x > proj.w - 120 ? x : x + 9 + lw;
      if (blockers.some((b) => lx1 > b[0] && lx0 < b[2] && y + 8 > b[1] && y - 8 < b[3])) continue;
      cands.push({ s, m: m - (d < 0.3 ? 5 : 0), x, y, d });
    }
    cands.sort((a, b) => a.m - b.m);
    // Keep labels that are still among the best few to avoid flicker.
    const keep = new Map();
    const shown = new Set(this.labels.filter((l) => l.index >= 0).map((l) => l.index));
    const top = cands.slice(0, LABELS + 3);
    const chosen = [];
    for (const c of top) if (shown.has(c.s.index) && chosen.length < LABELS) { chosen.push(c); keep.set(c.s.index, c); }
    for (const c of cands) {
      if (chosen.length >= LABELS) break;
      if (!keep.has(c.s.index)) {
        // avoid stacking labels on top of each other
        if (chosen.some((o) => Math.abs(o.x - c.x) < 70 && Math.abs(o.y - c.y) < 16)) continue;
        chosen.push(c); keep.set(c.s.index, c);
      }
    }
    const free = [];
    for (const l of this.labels) {
      const c = keep.get(l.index);
      if (c) { this.placeLabel(l, c, textTick); keep.delete(l.index); } else { free.push(l); }
    }
    for (const c of keep.values()) {
      const l = free.pop();
      if (!l) break;
      l.index = c.s.index;
      l.text = '';
      this.placeLabel(l, c, true);
    }
    for (const l of free) { l.index = -1; l.el.classList.remove('on'); }
  }

  placeLabel(l, c, textTick) {
    if (l.text !== c.s.name) { l.text = c.s.name; l.n.textContent = c.s.name; }
    if (textTick) {
      const dist = c.d < 3 ? formatDistance(c.d) : '';
      if (dist !== l.dist) { l.dist = dist; l.d.textContent = dist; }
    }
    // Labels sit to the right of their star, or to the left near the right edge.
    const left = c.x > this.app.proj.w - 120;
    l.el.style.transform = left
      ? `translate3d(${(c.x - 9).toFixed(1)}px, ${(c.y - 7).toFixed(1)}px, 0) translateX(-100%)`
      : `translate3d(${(c.x + 9).toFixed(1)}px, ${(c.y - 7).toFixed(1)}px, 0)`;
    l.el.classList.add('on');
  }

  setLabels(on) {
    this.showLabels = on;
    if (!on) for (const l of this.labels) { l.index = -1; l.el.classList.remove('on'); }
  }

  toast(text, ms = 2600) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('on');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove('on'), ms);
  }

  // ---- star info card
  openCard(index) {
    this.cardStar = index;
    this.card.hidden = false;
    this.fillCard(index, this.app.lastFrame);
  }
  closeCard() { this.cardStar = -1; this.card.hidden = true; }

  fillCard(index, f) {
    if (!f) return;
    const { catalog, ship } = f;
    const info = this.app.starInfo(index);
    const p = catalog.position(index);
    const dHere = Math.hypot(p[0] - ship.pos[0], p[1] - ship.pos[1], p[2] - ship.pos[2]);
    const dSol = Math.hypot(p[0], p[1], p[2]);
    const M = catalog.absMag(index);
    this.card.querySelector('.title').textContent = info.name;
    this.card.querySelector('.subtitle').textContent = info.subtitle;
    const facts = [
      ['From you', formatDistance(dHere)],
      ['From Sol', dSol < 1e-6 ? '—' : formatDistance(dSol)],
      ['Brightness here', `mag ${apparentMag(M, dHere).toFixed(1)}`],
      ['Luminosity', `${(10 ** (0.4 * (4.83 - M))).toLocaleString('en-US', { maximumSignificantDigits: 2 })} × Sun (visual)`],
      ['Colour index', `B−V ${catalog.bv(index).toFixed(2)}`],
    ];
    if (info.note) facts.push(['Note', info.note]);
    const html = facts.map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join('');
    const dl = this.card.querySelector('.facts');
    if (dl.innerHTML !== html) dl.innerHTML = html;
  }
}
