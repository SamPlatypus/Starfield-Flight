// Heads-up display: the Sol direction marker, the selected-target bracket, labels for
// stars, planets and constellations, the speed / distance / clock readout, toasts and the
// info card. Everything is positioned with compositor-only transforms in the same
// animation frame as the WebGL draw.
import { formatDistance, formatSpeed, apparentMag } from './math.js';
import { AU_PER_PC } from './solar/system.js';
import { dateFromJulian } from './solar/astro.js';
import { TIME_RATES } from './settings.js';

const STAR_LABELS = 7;
const BODY_LABELS = 9;
const CON_LABELS = 12;
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

/** Angular size in degrees, arcminutes or arcseconds. */
export function formatAngle(rad) {
  const deg = rad * 180 / Math.PI;
  if (deg >= 1) return `${deg.toFixed(1)}°`;
  const min = deg * 60;
  if (min >= 1) return `${min.toFixed(1)}′`;
  const sec = min * 60;
  return sec >= 0.01 ? `${sec.toFixed(sec < 10 ? 2 : 1)}″` : '< 0.01″';
}

/** "2026-11-09 14:05 UTC" for a UT Julian date. */
export function formatClock(jd) {
  const d = dateFromJulian(jd);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** A pool of label elements reused frame to frame; a label keeps its element while it stays chosen. */
class LabelPool {
  constructor(parent, n, cls) {
    this.items = [];
    for (let i = 0; i < n; i++) {
      const el = document.createElement('div');
      el.className = `label ${cls}`;
      el.innerHTML = '<span class="n"></span><span class="d"></span>';
      parent.appendChild(el);
      this.items.push({ el, n: el.firstChild, d: el.lastChild, key: null, text: '', dist: '' });
    }
  }
  get keys() { return new Set(this.items.filter((l) => l.key !== null).map((l) => l.key)); }
  /** Hides the label showing `key` at once (no fade), e.g. when its marker takes over. */
  drop(key) {
    const l = this.items.find((x) => x.key === key);
    if (!l) return;
    l.key = null;
    l.el.classList.add('instant');
    l.el.classList.remove('on');
    requestAnimationFrame(() => l.el.classList.remove('instant'));
  }
  hideAll() { for (const l of this.items) if (l.key !== null) { l.key = null; l.el.classList.remove('on'); } }
  /** Shows `chosen` ([{ key, ... }]) with `place(label, item, fresh)`, hiding the rest. */
  assign(chosen, place) {
    const byKey = new Map(chosen.map((c) => [c.key, c]));
    const free = [];
    for (const l of this.items) {
      const c = l.key !== null ? byKey.get(l.key) : undefined;
      if (c) { place(l, c, false); byKey.delete(l.key); } else free.push(l);
    }
    for (const c of byKey.values()) {
      const l = free.pop();
      if (!l) break;
      l.key = c.key; l.text = null; l.dist = null; // forces the new label's text in
      place(l, c, true);
    }
    for (const l of free) if (l.key !== null) { l.key = null; l.el.classList.remove('on'); }
  }
}

function setText(el, text) { if (el.textContent !== text) el.textContent = text; }

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
    this.clock = $('#readout .clock');
    this.toastEl = $('#toast');
    this.card = $('#card');
    this.cardTitle = this.card.querySelector('.title');
    this.cardSubtitle = this.card.querySelector('.subtitle');
    this.facts = this.card.querySelector('.facts');
    this.favBtn = this.card.querySelector('.fav');
    this.flyBtn = this.card.querySelector('.fly');
    const labels = $('#labels');
    this.conLabels = new LabelPool(labels, CON_LABELS, 'con');
    this.starLabels = new LabelPool(labels, STAR_LABELS, 'star');
    this.bodyLabels = new LabelPool(labels, BODY_LABELS, 'body');
    this.v = [0, 0, 0];
    this.lastText = 0;
    this.showLabels = true;
    this.showConNames = false;
    this.cardTarget = null;
    this.cardInfo = null;
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

  /**
   * Places a marker on screen or as an arrow on the screen edge, keeping an edge arrow's
   * caption off any planet disc in `bodies`. Returns { edge, x, y }.
   */
  placeMarker(el, arrow, tag, worldPos, proj, bodies = null) {
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
      // Put the tag beside the arrow, on the side facing the middle of the screen; if a
      // planet is in the way, above or below the arrow instead.
      const tx = Math.abs(dx) < 0.45 ? 0 : dx > 0 ? -1 : 1;
      const ty = Math.abs(dy) < 0.45 ? 0 : dy > 0 ? -1 : 1;
      const T = (a) => (a === 0 ? '-50%' : a < 0 ? 'calc(-100% - 20px)' : '20px');
      let transform = `translate(${T(tx)}, ${T(ty)})`;
      if (bodies && bodies.length) {
        const w = 8 + 7.5 * tag.textContent.length, h = 16;
        const x0 = tx === 0 ? x - w / 2 : tx < 0 ? x - 20 - w : x + 20;
        const y0 = ty === 0 ? y - h / 2 : ty < 0 ? y - 20 - h : y + 20;
        if (this.overDisc({ x0, x1: x0 + w, y0, y1: y0 + h }, bodies, null)) {
          // stack it under (or over) the arrow, kept on screen
          const cx0 = Math.min(Math.max(x - w / 2, 4), proj.w - 4 - w);
          for (const cy0 of [y + 20, y - 20 - h, y + 44, y - 44 - h]) {
            const b = { x0: cx0, x1: cx0 + w, y0: cy0, y1: cy0 + h };
            if (b.y0 >= 0 && b.y1 <= proj.h && !this.overDisc(b, bodies, null)) {
              transform = `translate(${(cx0 - x).toFixed(1)}px, ${(cy0 - y).toFixed(1)}px)`;
              break;
            }
          }
        }
      }
      tag.style.transform = transform;
    } else {
      tag.style.transform = '';
    }
    el.classList.toggle('edge', edge);
    el.classList.add('on');
    el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    return { edge, x, y };
  }

  /** Screen box a marker and its tag cover, for keeping labels clear of it. */
  markerBox(m, r, tag) {
    if (m.edge) return { x0: m.x - 70, x1: m.x + 70, y0: m.y - 40, y1: m.y + 40 };
    // the tag under the reticle (or under the disc it brackets)
    const w = 10 + 6.5 * tag.length;
    const top = m.y + Math.max(13, r + 4);
    return { x0: m.x - w / 2, x1: m.x + w / 2, y0: top, y1: top + 18 };
  }

  /** A marker over a big disc drops its reticle and moves its tag below the disc (and rings). */
  setDisc(el, r, below = r) {
    const big = r > 15;
    el.classList.toggle('big', big);
    if (big) {
      const px = Math.min(below, 2000);
      if (Math.abs((el.discR || 0) - px) > 0.5) { el.discR = px; el.style.setProperty('--r', `${px.toFixed(1)}px`); }
    }
  }

  update(f) {
    const { proj, ship } = f;
    const app = this.app;
    const now = f.now;
    const textTick = now - this.lastText > 120;
    if (textTick) this.lastText = now;
    const sS = f.solarS || 0;
    const bodies = sS > 0 ? f.bodies || [] : [];
    const screenOf = (id) => bodies.find((b) => b.body.id === id);

    // ---- Sol: always there (it is also the "fly home" button); it steps aside for the Sun's disc
    const solDistPc = Math.hypot(ship.pos[0], ship.pos[1], ship.pos[2]);
    const sun = screenOf('sun');
    const sunR = sun && !sun.behind ? sun.r : 0;
    this.setDisc(this.sol, sunR, sunR);
    const solM = this.placeMarker(this.sol, this.solArrow, this.solTag, [0, 0, 0], proj, bodies);
    // Among the planets (within ~50 AU) the Sun needs no caption, the readout has its
    // distance: just the ring, so the planets crowded round it keep their names.
    const quiet = sS > 0.5 && solDistPc * AU_PER_PC < 50 && !solM.edge && sunR <= 15;
    this.sol.classList.toggle('quiet', quiet);
    const taken = [quiet ? { x0: solM.x - 12, x1: solM.x + 12, y0: solM.y - 12, y1: solM.y + 12 } : this.markerBox(solM, sunR, `SOL ${this.solDist.textContent}`)];
    this.sol.classList.toggle('autopilot', ship.autopilot && !!ship.target?.home);
    if (textTick) {
      const d = formatDistance(solDistPc);
      setText(this.solDist, d);
      setText(this.solReadout, `Sol ${d}`);
      setText(this.speed, formatSpeed(ship.speed));
      setText(this.mode, ship.autopilot ? 'Autopilot' : ship.boost > 0.5 ? 'Boost' : '');
      setText(this.clock, sS > 0.02 ? this.clockText() : '');
    }

    // ---- the selected star or body
    const st = ship.target;
    const t = st && (st.kind === 'star' || st.kind === 'body') ? st : app.selected;
    let skipStar = -1, skipBody = null;
    if (t && (t.kind === 'star' || t.kind === 'body')) {
      const p = app.targetPosition(t);
      let r = 0, below = 0;
      if (t.kind === 'body') {
        skipBody = t.id;
        const s = screenOf(t.id);
        if (s && !s.behind) { r = s.r; below = s.ry ?? s.r; }
      } else skipStar = t.index;
      this.setDisc(this.target, r, below);
      const m = this.placeMarker(this.target, this.targetArrow, this.targetTag, p, proj, bodies);
      taken.push(this.markerBox(m, below, `${t.name || ''} ${this.targetDist.textContent}`));
      if (textTick) {
        setText(this.targetName, t.name || '');
        setText(this.targetDist, formatDistance(Math.hypot(p[0] - ship.pos[0], p[1] - ship.pos[1], p[2] - ship.pos[2])));
      }
    } else {
      this.target.classList.remove('on');
    }

    if (this.showLabels) {
      if (sS > 0.3) this.updateBodyLabels(f, bodies, textTick, skipBody, taken); else this.bodyLabels.hideAll();
      // In the Solar System the planets get the labels; only the brightest stars keep theirs.
      this.updateStarLabels(f, bodies, textTick, skipStar, taken, Math.round(STAR_LABELS - 4 * Math.min(1, sS * 1.5)));
    }
    if (this.showConNames && app.constellations) this.updateConLabels(f, bodies, taken); else this.conLabels.hideAll();
    if (this.cardTarget && textTick) this.fillCard(f);
  }

  clockText() {
    const app = this.app;
    const rate = TIME_RATES.find((r) => r[1] === app.timeRate);
    const tail = app.timeRate === 1 ? '' : app.timeRate === 0 ? ' · paused' : ` · ${rate ? rate[0] : `${app.timeRate}×`}`;
    return formatClock(app.solar.jdUT) + tail;
  }

  /** Screen rectangles of the on-screen controls, which labels must not cover. */
  blockerRects(w, h) {
    const cinema = this.root.classList.contains('cinema');
    if (!this.blockers || this.blockW !== w || this.blockH !== h || this.blockCinema !== cinema) {
      this.blockW = w; this.blockH = h; this.blockCinema = cinema;
      this.blockers = cinema ? [] : ['#speed-slider', '#density-slider', '#boost', '#menu-btn', '#search-btn', '#readout']
        .map((sel) => document.querySelector(sel)?.getBoundingClientRect())
        .filter((b) => b && b.width > 0)
        .map((b) => [b.left - 8, b.top - 8, b.right + 8, b.bottom + 8]);
    }
    return this.blockers;
  }

  /**
   * Label box for a name at (x, y) with room for `extra` px of distance text: right of the
   * point, or left (forced, or near the right edge).
   */
  labelBox(x, y, off, text, w, side = 0, extra = 34) {
    const lw = 8 + 6.8 * text.length + extra;
    const left = side ? side < 0 : x + off + lw > w - 12;
    return { left, x0: left ? x - off - lw : x + off, x1: left ? x - off : x + off + lw, y0: y - 8, y1: y + 8 };
  }

  /** True when a box overlaps the disc or rings of any body but `self`. */
  overDisc(box, bodies, self) {
    for (const s of bodies) {
      if (s === self || s.behind || !(s.r > 3)) continue;
      const rx = s.rx ?? s.r, ry = s.ry ?? s.r;
      const nx = Math.max(box.x0, Math.min(s.x, box.x1)), ny = Math.max(box.y0, Math.min(s.y, box.y1));
      const dx = (nx - s.x) / rx, dy = (ny - s.y) / ry;
      if (dx * dx + dy * dy < 1) return true;
    }
    return false;
  }

  /** A label box that keeps clear of planet discs and on screen: the usual side, else the other, else null. */
  clearBox(x, y, off, text, w, bodies, self, extra = 34) {
    const box = this.labelBox(x, y, off, text, w, 0, extra);
    if (!bodies.length || !this.overDisc(box, bodies, self)) return box;
    const other = this.labelBox(x, y, off, text, w, box.left ? 1 : -1, extra);
    if (other.x0 < 4 || other.x1 > w - 4) return null;
    return this.overDisc(other, bodies, self) ? null : other;
  }

  blocked(box, blockers) {
    return blockers.some((b) => box.x1 > b[0] && box.x0 < b[2] && box.y1 > b[1] && box.y0 < b[3]);
  }

  overlaps(box, boxes) {
    return boxes.some((b) => box.x1 > b.x0 && box.x0 < b.x1 && box.y1 > b.y0 && box.y0 < b.y1);
  }

  /** True when (x, y) is hidden behind a planet's disc or rings. */
  occluded(x, y, bodies) {
    for (const s of bodies) {
      if (s.behind || !(s.r > 1.5)) continue;
      const dx = (x - s.x) / (s.rx ?? s.r), dy = (y - s.y) / (s.ry ?? s.r);
      if (dx * dx + dy * dy < 1) return true;
    }
    return false;
  }

  updateBodyLabels(f, bodies, textTick, skipId, taken) {
    const { proj } = f;
    const sun = bodies.find((o) => o.body.id === 'sun');
    if (skipId) this.bodyLabels.drop(skipId); // the target marker names it now
    const r = this.edgeRect(proj.w, proj.h);
    const blockers = this.blockerRects(proj.w, proj.h);
    const big = Math.min(proj.w, proj.h) * 0.6;
    const cands = [];
    for (const s of bodies) {
      const b = s.body;
      if (b.id === 'sun' || b.id === skipId || s.behind) continue; // the Sun has the SOL tag
      if (b.type === 'moon' && !s.visible) continue;
      if (s.x < r.x0 || s.x > r.x1 || s.y < r.y0 || s.y > r.y1 || s.r > big) continue;
      if (b.type !== 'moon' && sun && !sun.behind && Math.hypot(s.x - sun.x, s.y - sun.y) < sun.r + 24) continue; // lost in the Sun's glare
      if (b.type === 'moon') {
        // only once it stands clear of its planet (and its rings)
        const p = bodies.find((o) => o.body.id === b.parent);
        if (p && !p.behind && Math.hypot((s.x - p.x) / ((p.rx ?? p.r) + 24), (s.y - p.y) / ((p.ry ?? p.r) + 24)) < 1) continue;
      }
      const off = Math.max(9, (s.rx ?? s.r) + 5);
      const tries = [this.clearBox(s.x, s.y, off, b.name, proj.w, bodies, s, 70)]; // room for "694,702 km"
      if (s.r > 15) {
        // a big disc may have no room beside it: then centred under it (and its rings)
        const lw = 8 + 6.8 * b.name.length + 70, top = s.y + (s.ry ?? s.r) + 4;
        tries.push({ below: true, x0: s.x - lw / 2, x1: s.x + lw / 2, y0: top, y1: top + 16 });
      }
      const box = tries.find((t) => t && t.x0 >= 2 && t.x1 <= proj.w - 2 && t.y1 <= proj.h &&
        !this.blocked(t, blockers) && !this.overlaps(t, taken) && !(t.below && this.overDisc(t, bodies, s)));
      if (!box) continue;
      cands.push({ key: b.id, s, text: b.name, x: s.x, y: s.y, off, box, rank: (s.mag ?? 30) - 3 * Math.log2(1 + s.r) + (b.type === 'moon' ? 2 : 0) });
    }
    cands.sort((a, b) => a.rank - b.rank);
    const chosen = [];
    for (const c of cands) {
      if (chosen.length >= BODY_LABELS) break;
      if (chosen.some((o) => o.box.x1 > c.box.x0 && o.box.x0 < c.box.x1 && Math.abs(o.y - c.y) < 15)) continue;
      chosen.push(c);
      taken.push(c.box);
    }
    this.bodyLabels.assign(chosen, (l, c, fresh) => {
      if (l.text !== c.text) { l.text = c.text; l.n.textContent = c.text; }
      if (textTick || fresh) {
        const d = formatDistance(c.s.dist / AU_PER_PC);
        if (d !== l.dist) { l.dist = d; l.d.textContent = d; }
      }
      l.el.style.transform = c.box.below
        ? `translate3d(${c.x.toFixed(1)}px, ${c.box.y0.toFixed(1)}px, 0) translateX(-50%)`
        : c.box.left
          ? `translate3d(${(c.x - c.off).toFixed(1)}px, ${(c.y - 7).toFixed(1)}px, 0) translateX(-100%)`
          : `translate3d(${(c.x + c.off).toFixed(1)}px, ${(c.y - 7).toFixed(1)}px, 0)`;
      l.el.classList.add('on');
    });
  }

  updateStarLabels(f, bodies, textTick, skip, taken, max) {
    if (skip >= 0) this.starLabels.drop(skip);
    if (max <= 0) { this.starLabels.hideAll(); return; }
    const { proj, catalog, names, magLimit } = f;
    const v = this.v;
    const cands = [];
    const r = this.edgeRect(proj.w, proj.h);
    const blockers = this.blockerRects(proj.w, proj.h);
    const tex = catalog.tex;
    const takenR = taken.map((t) => [t.x0, t.y0, t.x1, t.y1]);
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
      if (bodies.length && this.occluded(x, y, bodies)) continue;
      const box = this.clearBox(x, y, 9, s.name, proj.w, bodies, null, d < 3 ? 52 : 8); // "8.60 ly" within 3 pc
      if (!box || this.blocked(box, blockers) || this.blocked(box, takenR)) continue;
      cands.push({ key: s.index, s, m: m - (d < 0.3 ? 5 : 0), x, y, d, box });
    }
    cands.sort((a, b) => a.m - b.m);
    // Keep labels that are still among the best few to avoid flicker.
    const shown = this.starLabels.keys;
    const chosen = [];
    for (const c of cands.slice(0, max + 3)) if (shown.has(c.key) && chosen.length < max) chosen.push(c);
    for (const c of cands) {
      if (chosen.length >= max) break;
      if (chosen.includes(c)) continue;
      // avoid stacking labels on top of each other
      if (chosen.some((o) => Math.abs(o.x - c.x) < 70 && Math.abs(o.y - c.y) < 16)) continue;
      chosen.push(c);
    }
    for (const c of chosen) taken.push(c.box);
    this.starLabels.assign(chosen, (l, c, fresh) => {
      if (l.text !== c.s.name) { l.text = c.s.name; l.n.textContent = c.s.name; }
      if (textTick || fresh) {
        const dist = c.d < 3 ? formatDistance(c.d) : '';
        if (dist !== l.dist) { l.dist = dist; l.d.textContent = dist; }
      }
      // Labels sit to the right of their star, or to the left near the right edge.
      l.el.style.transform = c.box.left
        ? `translate3d(${(c.x - 9).toFixed(1)}px, ${(c.y - 7).toFixed(1)}px, 0) translateX(-100%)`
        : `translate3d(${(c.x + 9).toFixed(1)}px, ${(c.y - 7).toFixed(1)}px, 0)`;
      l.el.classList.add('on');
    });
  }

  updateConLabels(f, bodies, taken) {
    const cons = this.app.constellations;
    const blockers = this.blockerRects(f.proj.w, f.proj.h);
    const chosen = [];
    for (const [c, x, y] of cons.labels(f.proj, f.magLimit, CON_LABELS)) {
      const text = cons.abbr[c];
      const box = { x0: x - 16, x1: x + 16, y0: y - 8, y1: y + 8 };
      if (this.blocked(box, blockers) || this.overlaps(box, taken)) continue;
      if (bodies.length && (this.occluded(x, y, bodies) || this.overDisc(box, bodies, null))) continue;
      if (chosen.some((o) => Math.abs(o.x - x) < 44 && Math.abs(o.y - y) < 16)) continue;
      chosen.push({ key: c, text, title: cons.name[c], x, y });
    }
    this.conLabels.assign(chosen, (l, c) => {
      if (l.text !== c.text) { l.text = c.text; l.n.textContent = c.text; l.el.title = c.title; }
      l.el.style.transform = `translate3d(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px, 0) translate(-50%, -50%)`;
      l.el.classList.add('on');
    });
  }

  setLabels(on) {
    this.showLabels = on;
    if (!on) { this.starLabels.hideAll(); this.bodyLabels.hideAll(); }
  }
  setConNames(on) {
    this.showConNames = on;
    if (!on) this.conLabels.hideAll();
  }

  toast(text, ms = 2600) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('on');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove('on'), ms);
  }

  // ---- info card (stars and Solar System bodies)
  openCard(t) {
    const app = this.app;
    this.cardTarget = t.kind === 'star' ? { kind: 'star', index: t.index } : { kind: 'body', id: t.id };
    this.cardInfo = t.kind === 'star' ? app.starInfo(t.index) : app.bodyInfo(t.id);
    setText(this.cardTitle, this.cardInfo.name);
    setText(this.cardSubtitle, this.cardInfo.subtitle);
    this.card.hidden = false;
    this.syncFav();
    this.fillCard(app.lastFrame);
  }
  closeCard() { this.cardTarget = null; this.card.hidden = true; }

  syncFav() {
    if (!this.cardTarget) return;
    const on = this.app.favourites.has(this.cardTarget);
    this.favBtn.classList.toggle('on', on);
    setText(this.favBtn, on ? '★ Saved' : '☆ Save');
    this.favBtn.setAttribute('aria-pressed', String(on));
  }

  fillCard(f) {
    if (!f || !this.cardTarget) return;
    const app = this.app, t = this.cardTarget, ship = f.ship;
    const p = app.targetPosition(t);
    const dHere = Math.hypot(p[0] - ship.pos[0], p[1] - ship.pos[1], p[2] - ship.pos[2]);
    let facts;
    if (t.kind === 'star') {
      const cat = f.catalog;
      const M = cat.absMag(t.index);
      const dSol = Math.hypot(p[0], p[1], p[2]);
      const m = apparentMag(M, dHere);
      facts = [
        ['From you', formatDistance(dHere)],
        ['From Sol', dSol < 1e-6 ? '—' : formatDistance(dSol)],
        ['Brightness here', `mag ${m.toFixed(1)}`],
        ['Luminosity', `${(10 ** (0.4 * (4.83 - M))).toLocaleString('en-US', { maximumSignificantDigits: 2 })} × Sun (visual)`],
        ['Colour index', `B−V ${cat.bv(t.index).toFixed(2)}`],
      ];
      if (m > f.magLimit) facts.push(['Visibility', `fainter than your density limit (mag ${f.magLimit.toFixed(1)}): it appears as you get closer`]);
      if (this.cardInfo.note) facts.push(['Note', this.cardInfo.note]);
    } else {
      const b = app.solar.get(t.id);
      const au = [ship.pos[0] * AU_PER_PC, ship.pos[1] * AU_PER_PC, ship.pos[2] * AU_PER_PC];
      const dAU = Math.max(dHere * AU_PER_PC, b.Rau);
      const size = formatAngle(2 * Math.asin(Math.min(1, b.Rau / dAU)));
      facts = [['From you', formatDistance(dHere)]];
      if (b.id !== 'sun') facts.push(['From the Sun', formatDistance(Math.hypot(p[0], p[1], p[2]))]);
      facts.push(['Radius', `${Math.round(b.R).toLocaleString('en-US')} km`]);
      facts.push(['Seen from here', `${size} · mag ${app.solar.magnitude(b, au).toFixed(1)}`]);
      for (const [k, v] of Object.entries(b.facts || {})) facts.push([k, v]);
    }
    const html = facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    if (html !== this.factsHtml) { this.factsHtml = html; this.facts.innerHTML = html; }
  }
}
