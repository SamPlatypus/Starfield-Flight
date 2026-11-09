// Physical data for the Solar System bodies (IAU WGCCRE 2015 rotation models, JPL radii)
// and their visual magnitudes, used when a body is too small to show a disc.
//
//   R       mean radius [km]; Req / flat for the oblate giants
//   pole    north pole RA, Dec [deg] (ICRF); W = prime meridian W0 + rate * days [deg]
//   park    autopilot parking distance in radii
//   region  radius [AU] inside which a ship moves with the body (about its Hill sphere)
//   style   surface shader: see SURFACE_STYLES in render/solar.js
import { DEG } from './astro.js';

export const BODIES = [
  { id: 'sun', name: 'Sun', type: 'star', R: 695700, pole: [286.13, 63.87], W: [84.176, 14.1844], park: 40, style: 0,
    colour: [1.0, 0.93, 0.82], facts: { Type: 'G2V main-sequence star', Rotation: '25.4 days (equator)' } },
  { id: 'mercury', name: 'Mercury', type: 'planet', parent: 'sun', order: 1, R: 2439.7, pole: [281.0103, 61.4155], W: [329.5988, 6.1385108],
    park: 3.5, region: 0.0012, style: 1, colour: [0.62, 0.59, 0.56], facts: { Year: '88.0 days', Day: '58.6 days (sidereal)' } },
  { id: 'venus', name: 'Venus', type: 'planet', parent: 'sun', order: 2, R: 6051.8, pole: [272.76, 67.16], W: [160.2, -1.4813688],
    park: 3.5, region: 0.0067, style: 2, colour: [0.96, 0.89, 0.72], facts: { Year: '224.7 days', Day: '243 days, retrograde' } },
  { id: 'earth', name: 'Earth', type: 'planet', parent: 'sun', order: 3, R: 6371.0, Req: 6378.137, flat: 0.00335, pole: [0, 90], W: [190.147, 360.9856235],
    park: 3.5, region: 0.0098, style: 3, colour: [0.35, 0.5, 0.78], facts: { Year: '365.26 days', Day: '23 h 56 min' } },
  { id: 'moon', name: 'Moon', type: 'moon', parent: 'earth', R: 1737.4, pole: [269.9949, 66.5392], W: [38.3213, 13.17635815],
    park: 3.5, region: 0.00041, style: 4, colour: [0.62, 0.61, 0.6], facts: { Orbit: '27.32 days', Day: 'same face to Earth' } },
  { id: 'mars', name: 'Mars', type: 'planet', parent: 'sun', order: 4, R: 3389.5, Req: 3396.2, flat: 0.00589, pole: [317.269, 54.432], W: [176.049, 350.891983],
    park: 3.5, region: 0.0066, style: 5, colour: [0.78, 0.42, 0.24], facts: { Year: '687.0 days', Day: '24 h 37 min' } },
  { id: 'jupiter', name: 'Jupiter', type: 'planet', parent: 'sun', order: 5, R: 69911, Req: 71492, flat: 0.06487, pole: [268.0566, 64.4953], W: [284.95, 870.536],
    park: 4.5, region: 0.355, style: 6, colour: [0.84, 0.76, 0.64], facts: { Year: '11.86 years', Day: '9 h 56 min' } },
  { id: 'io', name: 'Io', type: 'moon', parent: 'jupiter', R: 1821.6, tidal: true, park: 3.5, region: 0.00007, style: 11, colour: [0.92, 0.84, 0.45],
    facts: { Orbit: '1.77 days', Note: 'most volcanic body known' } },
  { id: 'europa', name: 'Europa', type: 'moon', parent: 'jupiter', R: 1560.8, tidal: true, park: 3.5, region: 0.00009, style: 10, colour: [0.86, 0.82, 0.74],
    facts: { Orbit: '3.55 days', Note: 'ice shell over an ocean' } },
  { id: 'ganymede', name: 'Ganymede', type: 'moon', parent: 'jupiter', R: 2634.1, tidal: true, park: 3.5, region: 0.00021, style: 4, colour: [0.62, 0.58, 0.52],
    facts: { Orbit: '7.15 days', Note: 'largest moon in the Solar System' } },
  { id: 'callisto', name: 'Callisto', type: 'moon', parent: 'jupiter', R: 2410.3, tidal: true, park: 3.5, region: 0.00033, style: 1, colour: [0.42, 0.38, 0.34],
    facts: { Orbit: '16.69 days' } },
  { id: 'saturn', name: 'Saturn', type: 'planet', parent: 'sun', order: 6, R: 58232, Req: 60268, flat: 0.09796, pole: [40.589, 83.537], W: [38.9, 810.7939024],
    park: 8, region: 0.436, style: 7, colour: [0.89, 0.81, 0.62], rings: [1.239, 2.27], facts: { Year: '29.46 years', Day: '10 h 39 min' } },
  { id: 'titan', name: 'Titan', type: 'moon', parent: 'saturn', R: 2574.7, tidal: true, park: 3.5, region: 0.00035, style: 12, colour: [0.86, 0.62, 0.32],
    facts: { Orbit: '15.95 days', Note: 'thick nitrogen atmosphere' } },
  { id: 'uranus', name: 'Uranus', type: 'planet', parent: 'sun', order: 7, R: 25362, Req: 25559, flat: 0.02293, pole: [257.311, -15.175], W: [203.81, -501.1600928],
    park: 3.5, region: 0.447, style: 8, colour: [0.63, 0.86, 0.9], facts: { Year: '84.0 years', Day: '17 h 14 min, retrograde' } },
  { id: 'neptune', name: 'Neptune', type: 'planet', parent: 'sun', order: 8, R: 24622, Req: 24764, flat: 0.01708, pole: [299.36, 43.46], W: [249.978, 541.1397757],
    park: 3.5, region: 0.769, style: 9, colour: [0.32, 0.5, 0.95], facts: { Year: '164.8 years', Day: '16 h 6 min' } },
  { id: 'pluto', name: 'Pluto', type: 'dwarf planet', parent: 'sun', order: 9, R: 1188.3, pole: [132.993, -6.163], W: [302.695, 56.3625225],
    park: 3.5, region: 0.04, style: 13, colour: [0.82, 0.72, 0.6], facts: { Year: '248 years', Day: '6.39 days, retrograde' } },
];

const ORDINAL = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'];
export function describeBody(b) {
  if (b.type === 'star') return 'Our star · G2V';
  if (b.type === 'moon') return `Moon of ${b.parent[0].toUpperCase()}${b.parent.slice(1)}`;
  if (b.type === 'dwarf planet') return 'Dwarf planet · Kuiper belt';
  return `Planet · ${ORDINAL[b.order]} from the Sun`;
}

// Absolute magnitudes V(1,0) and phase coefficients [mag/deg] (Meeus ch. 41, Mallama et al.).
const V10 = {
  earth: [-3.99, 0.01], pluto: [-1.0, 0.04], io: [-1.68, 0.02], europa: [-1.41, 0.02], ganymede: [-2.09, 0.02],
  callisto: [-1.05, 0.02], titan: [-1.28, 0.02],
};

/**
 * Apparent visual magnitude of a body for an observer: r = Sun-body, delta = observer-body
 * distances (AU), phase = Sun-body-observer angle (deg), ringTilt = sin of the ring opening
 * angle for Saturn.
 */
export function visualMagnitude(id, r, delta, phase, ringTilt = 0) {
  const base = 5 * Math.log10(Math.max(r * delta, 1e-30));
  const i = phase;
  switch (id) {
    case 'sun': return -26.74 + 5 * Math.log10(Math.max(delta, 1e-30));
    case 'mercury': return -0.42 + base + 0.038 * i - 0.000273 * i * i + 0.000002 * i * i * i;
    case 'venus': return -4.4 + base + 0.0009 * i + 0.000239 * i * i - 0.00000065 * i * i * i;
    case 'mars': return -1.52 + base + 0.016 * i;
    case 'jupiter': return -9.4 + base + 0.005 * i;
    case 'saturn': { const s = Math.abs(ringTilt); return -8.88 + base - 2.6 * s + 1.25 * s * s + 0.044 * i; }
    case 'uranus': return -7.19 + base + 0.002 * i;
    case 'neptune': return -6.87 + base;
    case 'moon': return 0.21 + base + 0.026 * i + 4e-9 * i ** 4;
    default: { const [h, k] = V10[id]; return h + base + k * i; }
  }
}

/** Unit vector of a pole given as [RA, Dec] in degrees. */
export function poleVector([ra, dec]) {
  const a = ra * DEG, d = dec * DEG;
  return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
}
