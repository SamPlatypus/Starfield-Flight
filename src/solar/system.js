// Live state of the Solar System: body positions at the simulated time, which body's
// neighbourhood the ship is in, how close it is to anything, and the geometry used by
// the autopilot and the renderer. Positions are heliocentric equatorial J2000 in AU
// (float64); the ship lives in parsecs, so conversions go through AU_PER_PC.
import { bodyPositions, orbitPoints, orbitSize, AU_PER_PC, KM_PER_AU } from './ephemeris.js';
import { BODIES, visualMagnitude, poleVector } from './bodies.js';
import { ttFromUt, DEG, OBLIQUITY_J2000, J2000 } from './astro.js';

export { AU_PER_PC, KM_PER_AU };
const LY_PER_PC = 3.261563777;

// The Solar System fades in between 0.2 and 0.08 light-years from the Sun.
export const SOLAR_OUTER_PC = 0.2 / LY_PER_PC;
export const SOLAR_INNER_PC = 0.08 / LY_PER_PC;
export function solarIntensity(distPc) {
  const t = Math.min(1, Math.max(0, (SOLAR_OUTER_PC - distPc) / (SOLAR_OUTER_PC - SOLAR_INNER_PC)));
  return t * t * (3 - 2 * t);
}

// Speed limits near the Sun (manual flight; the autopilot brakes on its own).
const CAP_TIME = 1.2;    // s: inside the Solar System, never faster than the distance to the nearest surface in 1.2 s
const ENTRY_TIME = 0.5;  // s: heading in from outside, ease down so the edge is always > 0.5 s away

/**
 * Fastest the ship may fly (pc/s). Heading into the Solar System at warp it eases down
 * before the edge (so no frame can jump across it), and inside it is limited by the
 * distance to the nearest surface, `nearPc`. Boost raises the limit only inside.
 */
export function solarSpeedCap(pos, forward, nearPc, boostFactor = 1) {
  const d = Math.hypot(pos[0], pos[1], pos[2]);
  const R = SOLAR_OUTER_PC;
  if (d < R) return (nearPc / CAP_TIME) * boostFactor;
  const cosT = -(forward[0] * pos[0] + forward[1] * pos[1] + forward[2] * pos[2]) / d;
  if (cosT <= 0) return Infinity;                 // heading away
  const b2 = d * d * (1 - cosT * cosT);           // squared miss distance
  if (b2 >= R * R) return Infinity;               // passing by outside the zone
  const entry = d * cosT - Math.sqrt(R * R - b2); // distance to the edge along the path
  return Math.max(0, entry) / ENTRY_TIME + R / CAP_TIME;
}

/** Ecliptic north pole in the equatorial J2000 frame. */
export const ECLIPTIC_NORTH = [0, -Math.sin(OBLIQUITY_J2000), Math.cos(OBLIQUITY_J2000)];

const unit = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const PARK_PHASE = 35 * DEG;          // sunlit, with enough shadow to look round
const PARK_MAX_TURN = 75 * DEG;       // from the line of approach: the path never crosses the body

/**
 * Unit vector from a body (heliocentric AU) to where the autopilot parks by it, for a ship
 * at `shipAU`: on the sunlit side at a phase angle of ~35 degrees, a little above the
 * ecliptic, as far as staying within 75 degrees of the line of approach allows (then the
 * straight path in never comes closer to the body than the parking distance).
 */
export function parkingSide(bodyAU, shipAU) {
  const u = unit([shipAU[0] - bodyAU[0], shipAU[1] - bodyAU[1], shipAU[2] - bodyAU[2]]); // body -> ship
  const w = unit([-bodyAU[0], -bodyAU[1], -bodyAU[2]]);                                  // body -> Sun
  let side = [u[0] - w[0] * dot(u, w), u[1] - w[1] * dot(u, w), u[2] - w[2] * dot(u, w)];
  if (Math.hypot(side[0], side[1], side[2]) < 1e-6) {
    const n = ECLIPTIC_NORTH, k = dot(n, w);
    side = [n[0] - w[0] * k, n[1] - w[1] * k, n[2] - w[2] * k];
  }
  side = unit(side);
  const c0 = Math.cos(PARK_PHASE), s0 = Math.sin(PARK_PHASE), n = ECLIPTIC_NORTH;
  let d = unit([w[0] * c0 + side[0] * s0 + n[0] * 0.25, w[1] * c0 + side[1] * s0 + n[1] * 0.25, w[2] * c0 + side[2] * s0 + n[2] * 0.25]);
  const minCos = Math.cos(PARK_MAX_TURN), c = dot(d, u);
  if (c < minCos) {
    const q = unit([d[0] - u[0] * c, d[1] - u[1] * c, d[2] - u[2] * c]);
    const sn = Math.sqrt(1 - minCos * minCos);
    d = [u[0] * minCos + q[0] * sn, u[1] * minCos + q[1] * sn, u[2] * minCos + q[2] * sn];
  }
  return d;
}

export class SolarSystem {
  constructor() {
    this.bodies = BODIES.map((b) => ({
      ...b, pos: [0, 0, 0], prev: [0, 0, 0], poleVec: b.pole ? poleVector(b.pole) : null,
      Rau: b.R / KM_PER_AU, Req: (b.Req || b.R) / KM_PER_AU,
    }));
    this.byId = new Map(this.bodies.map((b) => [b.id, b]));
    this.orbits = new Map();
    this.orbitJd = -Infinity;
    this.jdUT = 0;
    this.jdTT = 0;
  }

  /** Recompute every body for a UT Julian date. Keeps the previous positions for co-moving. */
  update(jdUT) {
    this.jdUT = jdUT;
    this.jdTT = ttFromUt(jdUT);
    const p = bodyPositions(this.jdTT);
    for (const b of this.bodies) {
      b.prev[0] = b.pos[0]; b.prev[1] = b.pos[1]; b.prev[2] = b.pos[2];
      const q = p[b.id];
      b.pos[0] = q[0]; b.pos[1] = q[1]; b.pos[2] = q[2];
    }
    // Orbits change slowly (precession): refresh after a simulated day.
    if (Math.abs(this.jdTT - this.orbitJd) > 1) {
      this.orbitJd = this.jdTT;
      for (const b of this.bodies) {
        if (b.id === 'sun') continue;
        this.orbits.set(b.id, { points: orbitPoints(b.id, this.jdTT, b.type === 'moon' ? 160 : 360), size: orbitSize(b.id, this.jdTT) });
      }
    }
  }

  get(id) { return this.byId.get(id); }
  positionPc(id) { const p = this.byId.get(id).pos; return [p[0] / AU_PER_PC, p[1] / AU_PER_PC, p[2] / AU_PER_PC]; }

  /** Innermost body whose neighbourhood contains `au` (null: the Sun's frame). */
  frameBody(au) {
    let best = null;
    for (const b of this.bodies) {
      if (!b.region) continue;
      const d = Math.hypot(au[0] - b.pos[0], au[1] - b.pos[1], au[2] - b.pos[2]);
      if (d < b.region && (!best || b.region < best.region)) best = b;
    }
    return best;
  }

  /** Nearest body surface to `au`: { body, dist (AU, to the surface) }. */
  nearest(au) {
    let best = null, bestD = Infinity;
    for (const b of this.bodies) {
      const d = Math.hypot(au[0] - b.pos[0], au[1] - b.pos[1], au[2] - b.pos[2]) - b.Rau;
      if (d < bestD) { bestD = d; best = b; }
    }
    return { body: best, dist: bestD };
  }

  /** Pushes a point (AU) out of any body it is inside; returns true when it moved. */
  keepOutside(au, margin = 1.02) {
    let moved = false;
    for (const b of this.bodies) {
      const dx = au[0] - b.pos[0], dy = au[1] - b.pos[1], dz = au[2] - b.pos[2];
      const d = Math.hypot(dx, dy, dz), min = b.Req * margin;
      if (d < min) {
        const k = d > 0 ? min / d : 1;
        au[0] = b.pos[0] + (d > 0 ? dx : min) * k;
        au[1] = b.pos[1] + dy * k;
        au[2] = b.pos[2] + dz * k;
        moved = true;
      }
    }
    return moved;
  }

  /**
   * Where "fly home" parks: `distAU` from the Sun, `elevDeg` above the ecliptic (6 AU at 60
   * degrees is 5.2 AU above the plane), on the side the ship is coming from, so the approach
   * never crosses the planets' orbits head-on and the inner planets spread out around the Sun.
   */
  homeParking(shipAU, distAU = 6, elevDeg = 60) {
    const n = ECLIPTIC_NORTH;
    const l = Math.hypot(shipAU[0], shipAU[1], shipAU[2]) || 1;
    const u = [shipAU[0] / l, shipAU[1] / l, shipAU[2] / l];
    const along = u[0] * n[0] + u[1] * n[1] + u[2] * n[2];
    let h = [u[0] - along * n[0], u[1] - along * n[1], u[2] - along * n[2]];
    let hl = Math.hypot(h[0], h[1], h[2]);
    if (hl < 0.05) { h = [1, 0, 0]; hl = 1; } // arriving over a pole: any direction will do
    const c = Math.cos(elevDeg * DEG), s = Math.sin(elevDeg * DEG);
    return [(h[0] / hl * c + n[0] * s) * distAU, (h[1] / hl * c + n[1] * s) * distAU, (h[2] / hl * c + n[2] * s) * distAU];
  }

  /** Apparent magnitude of a body seen from `au`. */
  magnitude(b, au) {
    const dx = b.pos[0] - au[0], dy = b.pos[1] - au[1], dz = b.pos[2] - au[2];
    const delta = Math.hypot(dx, dy, dz);
    if (b.id === 'sun') return visualMagnitude('sun', 0, delta, 0);
    const r = Math.hypot(b.pos[0], b.pos[1], b.pos[2]);
    // phase angle Sun-body-observer: between body->Sun (-pos) and body->observer (-d)
    const cosP = (b.pos[0] * dx + b.pos[1] * dy + b.pos[2] * dz) / (r * delta || 1);
    const phase = Math.acos(Math.max(-1, Math.min(1, cosP))) / DEG;
    let tilt = 0;
    if (b.id === 'saturn') tilt = (-(dx * b.poleVec[0] + dy * b.poleVec[1] + dz * b.poleVec[2])) / (delta || 1);
    return visualMagnitude(b.id, r, delta, phase, tilt);
  }

  /**
   * Body-fixed frame (row-major 3x3, world -> body) with +z along the north pole and +x
   * at the prime meridian, after the IAU rotation model. Tidally locked moons keep +x
   * pointed at their planet.
   */
  bodyFrame(b) {
    let z, x;
    if (b.tidal) {
      const p = this.byId.get(b.parent).pos;
      const t = [p[0] - b.pos[0], p[1] - b.pos[1], p[2] - b.pos[2]];
      const pole = this.byId.get(b.parent).poleVec;
      z = pole;
      const k = t[0] * z[0] + t[1] * z[1] + t[2] * z[2];
      x = [t[0] - k * z[0], t[1] - k * z[1], t[2] - k * z[2]];
    } else {
      z = b.poleVec;
      // node of the equator on the ICRF equator, then rotate by W about the pole
      const node = [-z[1], z[0], 0];
      const nl = Math.hypot(node[0], node[1]) || 1;
      const n = nl > 1e-9 ? [node[0] / nl, node[1] / nl, 0] : [1, 0, 0];
      const m = [z[1] * n[2] - z[2] * n[1], z[2] * n[0] - z[0] * n[2], z[0] * n[1] - z[1] * n[0]];
      const W = ((b.W[0] + b.W[1] * (this.jdTT - J2000)) % 360) * DEG;
      const c = Math.cos(W), s = Math.sin(W);
      x = [n[0] * c + m[0] * s, n[1] * c + m[1] * s, n[2] * c + m[2] * s];
    }
    const xl = Math.hypot(x[0], x[1], x[2]) || 1;
    x = [x[0] / xl, x[1] / xl, x[2] / xl];
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    return [x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]];
  }
}
