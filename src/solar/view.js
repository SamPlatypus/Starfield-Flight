// Turns the Solar System state into what the GPU and the HUD need for one frame:
// camera-relative positions (computed in float64, handed over in AU or body radii), the
// disc / point cross-fade by apparent size, quad bounds, orbit and belt fades, and the
// screen positions of the bodies for labels and tapping.
import { OBLIQUITY_J2000, J2000 } from './astro.js';
import { KM_PER_AU } from './ephemeris.js';
import { logRamp } from './transition.js';

const ATMOSPHERE = {
  earth: [[0.45, 0.65, 1.0], 0.9], venus: [[1.0, 0.94, 0.82], 0.6], mars: [[0.95, 0.65, 0.45], 0.25],
  jupiter: [[0.92, 0.86, 0.76], 0.25], saturn: [[0.94, 0.88, 0.7], 0.2], uranus: [[0.6, 0.9, 1.0], 0.45],
  neptune: [[0.45, 0.62, 1.0], 0.45], titan: [[0.96, 0.7, 0.36], 0.9], pluto: [[0.7, 0.8, 1.0], 0.15],
};
const ORBIT_COLOUR = { planet: [0.48, 0.62, 0.9], 'dwarf planet': [0.62, 0.56, 0.8], moon: [0.58, 0.62, 0.72] };
const SELECTED_ORBIT = [0.9, 0.82, 0.5];
const cosE = Math.cos(OBLIQUITY_J2000), sinE = Math.sin(OBLIQUITY_J2000);
const ECL_TO_EQ = new Float32Array([1, 0, 0, 0, cosE, sinE, 0, -sinE, cosE]); // column-major
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// How large an orbit looks: its radius over half the shorter side of the view, so 1 is a
// ring that just spans the screen, whatever the resolution it is drawn at. A ring fades in
// as it grows from a speck, is drawn in full while it reads as a ring, and fades out again
// once it is so much larger than the view that only near-straight arcs of it cross the
// screen (flying among Jupiter's moons, Neptune's orbit is not a ring any more).
const RING_IN = [0.055, 0.19];   // planets: 20 -> 70 px on a 720 px wide view
const MOON_IN = [0.11, 0.31];    // moons: 40 -> 110 px
const RING_FULL = 3;             // up to here in full ...
const RING_GONE = 10;            // ... gone by here (smooth in log size)
const BELT_IN = [0.11, 0.39];    // the asteroid belt (2.8 AU): 40 -> 140 px
// A body too small to resolve is drawn as a star of its true magnitude. Close to resolving,
// that is far too much: a million km from Io it is magnitude -7, which as a star swells to
// a halo larger than the disc of the Jupiter it sits beside, and then collapses into a
// 3-pixel disc as it resolves. So the glare (the swollen core and the halo) tapers away as
// the body's true radius grows from GLARE_FULL to GLARE_NONE pixels, leaving a crisp dot
// about the size of the disc it is about to become. A moon is judged by its planet's size
// when that is larger, so it never shows more glare than the planet it circles. Seen from
// Earth every planet is under GLARE_FULL and looks as before; the Sun keeps its glare.
const GLARE_FULL = 0.1, GLARE_NONE = 1.0;
const DOT_SIGMA = 1.6; // the crisp dot's core, in units of the narrowest: as bold as a bright star, without the halo

// Inside a planet's own system the scene is the planet and its moons: the Sun's rings step
// back to this fraction, over the inner nine tenths of the planet's neighbourhood.
const HOST_KEEP = 0.4;

/**
 * Opacity (0..1) of an orbit `rView` large (see above): `into` is RING_IN or MOON_IN. A
 * selected ring is kept however large it gets.
 */
export function ringFade(rView, into, selected = false) {
  const lower = smooth(into[0], into[1], rView);
  return selected ? lower : lower * logRamp(rView, RING_GONE, RING_FULL); // 1 up to RING_FULL, 0 from RING_GONE
}

/**
 * Where a body (relative position x, y, z) sits along its orbit polyline: the fractional
 * segment index of the closest point, and the offset from that point to the body.
 */
export function closestOnRing(pts, x, y, z, out = new Float32Array(3)) {
  const n = pts.length / 3 - 1;
  let best = Infinity, at = 0, ox = 0, oy = 0, oz = 0;
  for (let k = 0; k < n; k++) {
    const ax = pts[k * 3], ay = pts[k * 3 + 1], az = pts[k * 3 + 2];
    const dx = pts[k * 3 + 3] - ax, dy = pts[k * 3 + 4] - ay, dz = pts[k * 3 + 5] - az;
    const dd = dx * dx + dy * dy + dz * dz;
    let t = dd > 0 ? ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / dd : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = x - (ax + dx * t), ey = y - (ay + dy * t), ez = z - (az + dz * t);
    const e = ex * ex + ey * ey + ez * ez;
    if (e < best) { best = e; at = k + t; ox = ex; oy = ey; oz = ez; }
  }
  out[0] = ox; out[1] = oy; out[2] = oz;
  return { at, offset: out };
}

const normals = new WeakMap();
/** Unit normal of an orbit polyline's plane. */
function ringNormal(pts) {
  let n = normals.get(pts);
  if (!n) {
    const q = Math.floor((pts.length / 3 - 1) / 4) * 3;
    const a = [pts[0], pts[1], pts[2]], b = [pts[q], pts[q + 1], pts[q + 2]];
    const x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0];
    const l = Math.hypot(x, y, z) || 1;
    n = [x / l, y / l, z / l];
    normals.set(pts, n);
  }
  return n;
}

export class SolarView {
  constructor(system) {
    this.ss = system;
    this.frame = { bodies: [], orbits: [], belt: null };
    this.screen = []; // { body, x, y (CSS px), r (CSS px), visible, behind, dist (AU) }
    this.slots = new Map(); // per-body uniform sets, reused frame to frame (no garbage at 60 fps)
    this.sizes = {};
    this.orbitSlots = new Map();
  }

  slot(b) {
    let o = this.slots.get(b.id);
    if (!o) {
      const atm = ATMOSPHERE[b.id];
      o = {
        id: b.id, dist: 0, rect: new Float32Array(4), centre: new Float32Array(3), rot: new Float32Array(9),
        sun: new Float32Array(3), polar: 1 - (b.flat || 0), style: b.style, colour: new Float32Array(b.colour),
        rings: new Float32Array(b.rings || [0, 0]), disc: 0, point: new Float32Array(4), centrePx: new Float32Array(2),
        atmos: atm ? atm[1] : 0, atmosColour: new Float32Array(atm ? atm[0] : [0, 0, 0]), alpha: 1,
      };
      this.slots.set(b.id, o);
    }
    return o;
  }

  orbitSlot(id) {
    let o = this.orbitSlots.get(id);
    if (!o) {
      o = { id, points: null, origin: new Float32Array(3), colour: new Float32Array(3), alpha: 0, near: 0, fix: null, fixAt: 0 };
      this.orbitSlots.set(id, o);
    }
    return o;
  }

  /**
   * @param c { camAU (float64 [3]), view (Float32 col-major world->view), camToWorld,
   *            tanX, tanY, w, h (device px), dpr, px, magLimit, gain, s (Solar System fade),
   *            orbits (bool), selected (body id) }
   */
  build(c) {
    const ss = this.ss, V = c.view, M = c.camToWorld;
    const fy = (c.h / 2) / c.tanY;
    const f = this.frame;
    f.view = V; f.tanX = c.tanX; f.tanY = c.tanY; f.w = c.w; f.h = c.h; f.px = c.px;
    f.bodies.length = 0;
    f.orbits.length = 0;
    this.screen = [];
    const cam = c.camAU;
    const v = [0, 0, 0];
    let host = 0; // how deep the camera is inside a planet's own system, 0..1
    const sizes = this.sizes; // true radius on screen (px) of each body this frame

    for (const b of ss.bodies) {
      const rx = b.pos[0] - cam[0], ry = b.pos[1] - cam[1], rz = b.pos[2] - cam[2];
      const d = Math.hypot(rx, ry, rz);
      if (b.region && b.type !== 'moon') host = Math.max(host, logRamp(d, b.region, b.region * 0.1));
      v[0] = V[0] * rx + V[3] * ry + V[6] * rz; v[1] = V[1] * rx + V[4] * ry + V[7] * rz; v[2] = V[2] * rx + V[5] * ry + V[8] * rz;
      const R = b.Req;
      const ang = Math.asin(Math.min(1, R / d));
      const rPx = Math.tan(ang) * fy;
      const behind = v[2] >= 0;
      let cx = 0, cy = 0;
      if (!behind) { cx = (v[0] / (-v[2] * c.tanX) * 0.5 + 0.5) * c.w; cy = (v[1] / (-v[2] * c.tanY) * 0.5 + 0.5) * c.h; }

      // brightness when unresolved, as the star shader does it, less the glare near resolving
      const m = ss.magnitude(b, cam);
      const dm = c.magLimit - m;
      const F = 10 ** (0.4 * Math.min(dm, 40));
      const fade = smooth(0, 0.8, dm);
      const raw = 0.13 * Math.sqrt(F) * c.gain;
      sizes[b.id] = rPx;
      const scene = b.type === 'moon' ? Math.max(rPx, sizes[b.parent] || 0) : rPx; // parents come first in BODIES
      const glare = b.id === 'sun' ? 1 : logRamp(scene, GLARE_NONE, GLARE_FULL);
      const swell = Math.min(6, Math.max(1, raw ** 0.4));
      const sigma = 0.72 * c.px * (glare * swell + (1 - glare) * Math.min(swell, DOT_SIGMA));
      let peak = Math.min(raw, 1.5) * fade;
      let glow = Math.min(0.6, Math.max(0, 0.012 * (Math.sqrt(F) - 5))) * fade * c.gain * glare;
      const rho = 0.72 * c.px * (2.2 + 1.3 * Math.log2(1 + F / 150));
      const disc = smooth(1.2, 3.0, rPx);
      peak *= 1 - disc;
      if (b.id !== 'sun') glow *= 1 - disc;
      const glowR = glow > 0.004 ? rho * Math.sqrt((glow / 0.004) ** (2 / 3) - 1) : 0;
      const pointR = Math.min(b.id === 'sun' ? 170 * c.px : 64 * c.px, Math.max(peak > 0.004 ? 3 * sigma : 0, glowR));
      const extent = b.rings ? b.rings[1] * 1.02 : b.id === 'sun' ? 7 : ATMOSPHERE[b.id] ? 1.06 : 1.0;

      const near = d < R * extent * 2.5;
      if (behind && !near) { this.screen.push({ body: b, behind: true, dist: d, visible: false }); continue; }
      const o = this.slot(b);
      const rect = o.rect;
      if (near) { rect[0] = -1; rect[1] = -1; rect[2] = 1; rect[3] = 1; }
      else {
        const nx = cx / c.w * 2 - 1, ny = cy / c.h * 2 - 1;
        const stretch = 1.15 + 0.6 * Math.min(1, nx * nx + ny * ny); // perspective widens off-axis discs
        const r = Math.max(rPx * extent * stretch, pointR) + 2;
        rect[0] = (cx - r) / c.w * 2 - 1; rect[1] = (cy - r) / c.h * 2 - 1; rect[2] = (cx + r) / c.w * 2 - 1; rect[3] = (cy + r) / c.h * 2 - 1;
      }
      const visible = disc > 0.02 || peak > 0.01 || glow > 0.01;
      const css = 1 / c.dpr;
      // half-height on screen, rings included: the ring ellipse's major axis lies across
      // the projected pole, its minor axis shrinks with the tilt to the line of sight
      let halfH = rPx, halfW = rPx;
      if (b.rings && b.poleVec) {
        const P = b.poleVec;
        const px = V[0] * P[0] + V[3] * P[1] + V[6] * P[2], py = V[1] * P[0] + V[4] * P[1] + V[7] * P[2];
        const pz = V[2] * P[0] + V[5] * P[1] + V[8] * P[2];
        const vl = Math.hypot(v[0], v[1], v[2]) || 1;
        const a = b.rings[1] * rPx, bb = a * Math.abs((px * v[0] + py * v[1] + pz * v[2]) / vl);
        const pl = Math.hypot(px, py) || 1;
        const nx = px / pl, ny = py / pl;
        halfH = Math.max(rPx, Math.sqrt(a * a * nx * nx + bb * bb * ny * ny));
        halfW = Math.max(rPx, Math.sqrt(a * a * ny * ny + bb * bb * nx * nx));
      }
      this.screen.push({ body: b, x: cx * css, y: (c.h - cy) * css, r: rPx * css, rx: halfW * css, ry: halfH * css, behind, dist: d, visible, mag: m });
      if (!visible || c.s <= 0.001) continue;
      if (rect[0] > 1 || rect[2] < -1 || rect[1] > 1 || rect[3] < -1) continue;

      // body-fixed frame: view -> body = (world -> body) x (view -> world)
      const Bf = ss.bodyFrame(b);
      const rot = o.rot;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          // (Bf * M)_{ij}; M is column-major: M_{kj} = M[j*3 + k]
          rot[j * 3 + i] = Bf[i * 3] * M[j * 3] + Bf[i * 3 + 1] * M[j * 3 + 1] + Bf[i * 3 + 2] * M[j * 3 + 2];
        }
      }
      const sl = Math.hypot(b.pos[0], b.pos[1], b.pos[2]) || 1;
      const swx = -b.pos[0] / sl, swy = -b.pos[1] / sl, swz = -b.pos[2] / sl;
      o.sun[0] = Bf[0] * swx + Bf[1] * swy + Bf[2] * swz;
      o.sun[1] = Bf[3] * swx + Bf[4] * swy + Bf[5] * swz;
      o.sun[2] = Bf[6] * swx + Bf[7] * swy + Bf[8] * swz;
      o.dist = d;
      o.centre[0] = v[0] / R; o.centre[1] = v[1] / R; o.centre[2] = v[2] / R;
      o.disc = disc;
      o.point[0] = peak; o.point[1] = sigma; o.point[2] = glow; o.point[3] = rho;
      o.centrePx[0] = cx; o.centrePx[1] = cy;
      o.alpha = c.s;
      f.bodies.push(o);
    }
    f.bodies.sort((a, b) => b.dist - a.dist);

    // orbits, shown while they are the right size on screen to read as rings
    const short = Math.min(c.tanX, c.tanY);
    f.host = host;
    if (c.orbits && c.s > 0.001) {
      for (const b of ss.bodies) {
        const o = ss.orbits.get(b.id);
        if (!o) continue;
        const parent = ss.get(b.parent);
        const pd = Math.hypot(parent.pos[0] - cam[0], parent.pos[1] - cam[1], parent.pos[2] - cam[2]);
        const rView = o.size / Math.max(pd, 1e-12) / short;
        const moon = b.type === 'moon';
        const sel = c.selected === b.id;
        let fade = ringFade(rView, moon ? MOON_IN : RING_IN, sel) * c.s;
        if (fade < 0.01) continue;
        if (!moon && !sel) fade *= 1 - (1 - HOST_KEEP) * host;
        // Seen edge-on (from near its plane, relative to its size) an orbit is just a line
        // along the ecliptic: dim it.
        const n = ringNormal(o.points);
        const ox = cam[0] - parent.pos[0], oy = cam[1] - parent.pos[1], oz = cam[2] - parent.pos[2];
        const hgt = Math.abs(ox * n[0] + oy * n[1] + oz * n[2]);
        const rho = Math.sqrt(Math.max(0, ox * ox + oy * oy + oz * oz - hgt * hgt));
        const open = hgt / (Math.hypot(hgt, Math.max(rho, o.size)) || 1);
        fade *= 0.3 + 0.7 * smooth(0.02, 0.2, open);
        if (fade < 0.03) continue; // under 1 % opacity: not worth a draw
        const col = ORBIT_COLOUR[b.type] || ORBIT_COLOUR.planet;
        const os = this.orbitSlot(b.id);
        const fix = closestOnRing(o.points, b.pos[0] - parent.pos[0], b.pos[1] - parent.pos[1], b.pos[2] - parent.pos[2], os.fixBuf || (os.fixBuf = new Float32Array(3)));
        os.points = o.points;
        os.origin[0] = parent.pos[0] - cam[0]; os.origin[1] = parent.pos[1] - cam[1]; os.origin[2] = parent.pos[2] - cam[2];
        os.colour.set(sel ? SELECTED_ORBIT : col);
        os.alpha = (sel ? 0.6 : moon ? 0.3 : 0.38) * fade;
        os.near = Math.max(o.size * 0.03, b.Req * 8);
        os.fix = fix.offset; os.fixAt = fix.at;
        f.orbits.push(os);
      }
    }

    // asteroid belt
    const ds = Math.hypot(cam[0], cam[1], cam[2]);
    const beltView = 2.8 / Math.max(ds, 1e-9) / short;
    const belt = f.belt || (f.belt = { alpha: 0, sun: new Float32Array(3), days: 0, ecl: ECL_TO_EQ });
    belt.alpha = 0.36 * c.s * smooth(BELT_IN[0], BELT_IN[1], beltView) * (c.orbits ? 1 : 0.6);
    belt.sun[0] = -cam[0]; belt.sun[1] = -cam[1]; belt.sun[2] = -cam[2];
    belt.days = ss.jdTT - J2000;
    return f;
  }

  /** Body under a tap (CSS px), or null. Prefers the nearest one on screen. */
  pick(x, y, radius = 30) {
    let best = null, bestScore = Infinity;
    for (const s of this.screen) {
      if (s.behind || !s.visible) continue;
      const dp = Math.hypot(s.x - x, s.y - y);
      if (dp > Math.max(radius, s.r * 1.1)) continue;
      const score = dp - s.r + Math.log10(s.dist) * 2;
      if (score < bestScore) { bestScore = score; best = s.body; }
    }
    return best;
  }
}

export const kmFromAU = (au) => au * KM_PER_AU;
