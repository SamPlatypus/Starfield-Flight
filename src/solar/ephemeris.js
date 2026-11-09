// Solar System ephemerides. Every function returns positions in the app's world frame,
// equatorial J2000 (ICRF), in astronomical units. Heliocentric unless noted.
//
//   Planets   Keplerian mean elements: JPL "Keplerian Elements for Approximate Positions of
//             the Major Planets" (E. M. Standish, Table 1, 1800-2050) for Mercury, Venus,
//             the Earth-Moon barycentre, Mars, Neptune and Pluto; P. Schlyter's elements plus
//             the main mutual perturbations (the Jupiter-Saturn great inequality etc.) for
//             Jupiter, Saturn and Uranus. Same code and accuracy as the Star-Sky app
//             (arcminutes over 1950-2100).
//   Moon      Truncated ELP-2000/82 series, Meeus ch. 47 (well under an arcminute).
//   Moons     JPL planetary satellite mean elements (epoch J2000, JUP365 / SAT441
//             ephemerides) in each satellite's Laplace plane, with mean motions from
//             Lieske's E5 theory (Galilean moons) and JPL (Titan).
import {
  DEG, ARCSEC, wrap360, solveKepler, fromSpherical, centuries, J2000,
  eclipticToEquatorial, meanObliquity, precessionMatrix, mulTransposed,
} from './astro.js';

export const AU_PER_PC = 206264.80624709636;
export const KM_PER_AU = 149597870.7;
const MOON_MASS_RATIO = 0.0121505856; // M_moon / (M_earth + M_moon)

// ---------------------------------------------------------------- planets
// Standish Table 1: a [AU], e, I, L, long. perihelion, long. node [deg]; then rates per century.
const STANDISH = {
  mercury: [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593,
    0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
  venus: [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255,
    0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418],
  emb: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0,
    0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0],
  mars: [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891,
    0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
  neptune: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574,
    0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664],
  pluto: [39.48211675, 0.2488273, 17.14001206, 238.92903833, 224.06891629, 110.30393684,
    -0.00031596, 0.0000517, 0.00004818, 145.20780515, -0.04062942, -0.01183482],
};
// Schlyter: N, dN, i, di, w, dw, a, da, e, de, M, dM per day since 2000 Jan 0.0 (ecliptic of date).
const SCHLYTER = {
  jupiter: [100.4542, 2.76854e-5, 1.303, -1.557e-7, 273.8777, 1.64505e-5, 5.20256, 0, 0.048498, 4.469e-9, 19.895, 0.0830853001],
  saturn: [113.6634, 2.3898e-5, 2.4886, -1.081e-7, 339.3939, 2.97661e-5, 9.55475, 0, 0.055546, -9.499e-9, 316.967, 0.0334442282],
  uranus: [74.0005, 1.3978e-5, 0.7733, 1.9e-8, 96.6612, 3.0565e-5, 19.18171, -1.55e-8, 0.047318, 7.45e-9, 142.5905, 0.011725806],
};
export const PLANET_IDS = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'];

/** General precession in longitude since J2000 (radians); ecliptic of date -> J2000. */
const precessionInLongitude = (jdTT) => { const T = centuries(jdTT); return (5029.0966 * T + 1.11113 * T * T) * ARCSEC; };

/**
 * Mean orbital elements at jdTT in the J2000 ecliptic frame:
 * { a [AU], e, i, node, peri (argument of perihelion), M } with angles in radians.
 */
export function planetElements(id, jdTT) {
  const key = id === 'earth' ? 'emb' : id;
  if (SCHLYTER[key]) {
    const d = jdTT - 2451543.5;
    const p = SCHLYTER[key];
    const shift = precessionInLongitude(jdTT); // the node is measured on the ecliptic of date
    return {
      node: (p[0] + p[1] * d) * DEG - shift, i: (p[2] + p[3] * d) * DEG, peri: (p[4] + p[5] * d) * DEG,
      a: p[6] + p[7] * d, e: p[8] + p[9] * d, M: wrap360(p[10] + p[11] * d) * DEG,
    };
  }
  const el = STANDISH[key];
  const T = centuries(jdTT);
  const L = el[3] + el[9] * T, longPeri = el[4] + el[10] * T, node = el[5] + el[11] * T;
  return {
    a: el[0] + el[6] * T, e: el[1] + el[7] * T, i: (el[2] + el[8] * T) * DEG,
    node: node * DEG, peri: (longPeri - node) * DEG, M: wrap360(L - longPeri) * DEG,
  };
}

/** Position in the orbit's frame -> J2000 ecliptic, for elements { i, node, peri }. */
function orbitToEcliptic(el, xp, yp) {
  const cw = Math.cos(el.peri), sw = Math.sin(el.peri), cO = Math.cos(el.node), sO = Math.sin(el.node);
  const cI = Math.cos(el.i), sI = Math.sin(el.i);
  return [
    (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
    (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
    sw * sI * xp + cw * sI * yp,
  ];
}

function keplerPosition(el) {
  const E = solveKepler(el.M, el.e);
  const xp = el.a * (Math.cos(E) - el.e);
  const yp = el.a * Math.sqrt(1 - el.e * el.e) * Math.sin(E);
  return orbitToEcliptic(el, xp, yp);
}

// Schlyter's perturbation terms for Jupiter, Saturn and Uranus (longitude / latitude, degrees).
function schlyterPerturbations(id, jdTT) {
  const d = jdTT - 2451543.5;
  const Mj = (19.895 + 0.0830853001 * d) * DEG, Ms = (316.967 + 0.0334442282 * d) * DEG;
  const Mu = (142.5905 + 0.011725806 * d) * DEG;
  const s = Math.sin, c = Math.cos;
  if (id === 'jupiter') {
    return [-0.332 * s(2 * Mj - 5 * Ms - 67.6 * DEG) - 0.056 * s(2 * Mj - 2 * Ms + 21 * DEG) +
      0.042 * s(3 * Mj - 5 * Ms + 21 * DEG) - 0.036 * s(Mj - 2 * Ms) + 0.022 * c(Mj - Ms) +
      0.023 * s(2 * Mj - 3 * Ms + 52 * DEG) - 0.016 * s(Mj - 5 * Ms - 69 * DEG), 0];
  }
  if (id === 'saturn') {
    return [0.812 * s(2 * Mj - 5 * Ms - 67.6 * DEG) - 0.229 * c(2 * Mj - 4 * Ms - 2 * DEG) +
      0.119 * s(Mj - 2 * Ms - 3 * DEG) + 0.046 * s(2 * Mj - 6 * Ms - 69 * DEG) + 0.014 * s(Mj - 3 * Ms + 32 * DEG),
    -0.02 * c(2 * Mj - 4 * Ms - 2 * DEG) + 0.018 * s(2 * Mj - 6 * Ms - 49 * DEG)];
  }
  return [0.04 * s(Ms - 2 * Mu + 6 * DEG) + 0.035 * s(Ms - 3 * Mu + 33 * DEG) - 0.015 * s(Mj - Mu + 20 * DEG), 0];
}

/** Heliocentric J2000 ecliptic position (AU) of a planet or of 'emb' (Earth-Moon barycentre). */
export function planetEcliptic(id, jdTT) {
  const key = id === 'earth' ? 'emb' : id;
  const v = keplerPosition(planetElements(key, jdTT));
  if (!SCHLYTER[key]) return v;
  const [dl, db] = schlyterPerturbations(key, jdTT);
  const r = Math.hypot(v[0], v[1], v[2]);
  const lon = Math.atan2(v[1], v[0]) + dl * DEG;
  const lat = Math.atan2(v[2], Math.hypot(v[0], v[1])) + db * DEG;
  const u = fromSpherical(lon, lat);
  return [u[0] * r, u[1] * r, u[2] * r];
}

// ---------------------------------------------------------------- Moon (Meeus ch. 47)
const LR = [
  0, 0, 1, 0, 6288774, -20905355, 2, 0, -1, 0, 1274027, -3699111, 2, 0, 0, 0, 658314, -2955968,
  0, 0, 2, 0, 213618, -569925, 0, 1, 0, 0, -185116, 48888, 0, 0, 0, 2, -114332, -3149,
  2, 0, -2, 0, 58793, 246158, 2, -1, -1, 0, 57066, -152138, 2, 0, 1, 0, 53322, -170733,
  2, -1, 0, 0, 45758, -204586, 0, 1, -1, 0, -40923, -129620, 1, 0, 0, 0, -34720, 108743,
  0, 1, 1, 0, -30383, 104755, 2, 0, 0, -2, 15327, 10321, 0, 0, 1, 2, -12528, 0,
  0, 0, 1, -2, 10980, 79661, 4, 0, -1, 0, 10675, -34782, 0, 0, 3, 0, 10034, -23210,
  4, 0, -2, 0, 8548, -21636, 2, 1, -1, 0, -7888, 24208, 2, 1, 0, 0, -6766, 30824,
  1, 0, -1, 0, -5163, -8379, 1, 1, 0, 0, 4987, -16675, 2, -1, 1, 0, 4036, -12831,
  2, 0, 2, 0, 3994, -10445, 4, 0, 0, 0, 3861, -11650, 2, 0, -3, 0, 3665, 14403,
  0, 1, -2, 0, -2689, -7003, 2, 0, -1, 2, -2602, 0, 2, -1, -2, 0, 2390, 10056,
  1, 0, 1, 0, -2348, 6322, 2, -2, 0, 0, 2236, -9884, 0, 1, 2, 0, -2120, 5751,
  0, 2, 0, 0, -2069, 0, 2, -2, -1, 0, 2048, -4950, 2, 0, 1, -2, -1773, 4130,
  2, 0, 0, 2, -1595, 0, 4, -1, -1, 0, 1215, -3958, 0, 0, 2, 2, -1110, 0,
  3, 0, -1, 0, -892, 3258, 2, 1, 1, 0, -810, 2616, 4, -1, -2, 0, 759, -1897,
  0, 2, -1, 0, -713, -2117, 2, 2, -1, 0, -700, 2354, 2, 1, -2, 0, 691, 0,
  2, -1, 0, -2, 596, 0, 4, 0, 1, 0, 549, -1423, 0, 0, 4, 0, 537, -1117,
  4, -1, 0, 0, 520, -1571, 1, 0, -2, 0, -487, -1739, 2, 1, 0, -2, -399, 0,
  0, 0, 2, -2, -381, -4421, 1, 1, 1, 0, 351, 0, 3, 0, -2, 0, -340, 0,
  4, 0, -3, 0, 330, 0, 2, -1, 2, 0, 327, 0, 0, 2, 1, 0, -323, 1165,
  1, 1, -1, 0, 299, 0, 2, 0, 3, 0, 294, 0, 2, 0, -1, -2, 0, 8752,
];
const B = [
  0, 0, 0, 1, 5128122, 0, 0, 1, 1, 280602, 0, 0, 1, -1, 277693, 2, 0, 0, -1, 173237,
  2, 0, -1, 1, 55413, 2, 0, -1, -1, 46271, 2, 0, 0, 1, 32573, 0, 0, 2, 1, 17198,
  2, 0, 1, -1, 9266, 0, 0, 2, -1, 8822, 2, -1, 0, -1, 8216, 2, 0, -2, -1, 4324,
  2, 0, 1, 1, 4200, 2, 1, 0, -1, -3359, 2, -1, -1, 1, 2463, 2, -1, 0, 1, 2211,
  2, -1, -1, -1, 2065, 0, 1, -1, -1, -1870, 4, 0, -1, -1, 1828, 0, 1, 0, 1, -1794,
  0, 0, 0, 3, -1749, 0, 1, -1, 1, -1565, 1, 0, 0, 1, -1491, 0, 1, 1, 1, -1475,
  0, 1, 1, -1, -1410, 0, 1, 0, -1, -1344, 1, 0, 0, -1, -1335, 0, 0, 3, 1, 1107,
  4, 0, 0, -1, 1021, 4, 0, -1, 1, 833, 0, 0, 1, -3, 777, 4, 0, -2, 1, 671,
  2, 0, 0, -3, 607, 2, 0, 2, -1, 596, 2, -1, 1, -1, 491, 2, 0, -2, 1, -451,
  0, 0, 3, -1, 439, 2, 0, 2, 1, 422, 2, 0, -3, -1, 421, 2, 1, -1, 1, -366,
  2, 1, 0, 1, -351, 4, 0, 0, 1, 331, 2, -1, 1, 1, 315, 2, -2, 0, -1, 302,
  0, 0, 1, 3, -283, 2, 1, 1, -1, -229, 1, 1, 0, -1, 223, 1, 1, 0, 1, 223,
  0, 1, -2, -1, -220, 2, 1, -1, -1, -220, 1, 0, 1, 1, -185, 2, -1, -2, -1, 181,
  0, 1, 2, 1, -177, 4, 0, -2, -1, 176, 4, -1, -1, -1, 166, 1, 0, 1, -1, -164,
  4, 0, 1, -1, 132, 1, 0, -1, -1, -119, 4, -1, 0, -1, 115, 2, -2, 0, 1, 107,
];

/** Geocentric Moon, J2000 equatorial (AU). */
export function moonGeocentric(jdTT) {
  const T = centuries(jdTT);
  const T2 = T * T, T3 = T2 * T, T4 = T3 * T;
  const Lp = wrap360(218.3164477 + 481267.88123421 * T - 0.0015786 * T2 + T3 / 538841 - T4 / 65194000);
  const D = wrap360(297.8501921 + 445267.1114034 * T - 0.0018819 * T2 + T3 / 545868 - T4 / 113065000) * DEG;
  const M = wrap360(357.5291092 + 35999.0502909 * T - 0.0001536 * T2 + T3 / 24490000) * DEG;
  const Mp = wrap360(134.9633964 + 477198.8675055 * T + 0.0087414 * T2 + T3 / 69699 - T4 / 14712000) * DEG;
  const F = wrap360(93.272095 + 483202.0175233 * T - 0.0036539 * T2 - T3 / 3526000 + T4 / 863310000) * DEG;
  const A1 = (119.75 + 131.849 * T) * DEG, A2 = (53.09 + 479264.29 * T) * DEG, A3 = (313.45 + 481266.484 * T) * DEG;
  const E = 1 - 0.002516 * T - 0.0000074 * T2, E2 = E * E;
  const LpR = Lp * DEG;
  let sl = 0, sr = 0, sb = 0;
  for (let i = 0; i < LR.length; i += 6) {
    const m = LR[i + 1];
    const arg = LR[i] * D + m * M + LR[i + 2] * Mp + LR[i + 3] * F;
    const ef = m === 0 ? 1 : (m === 1 || m === -1) ? E : E2;
    sl += LR[i + 4] * ef * Math.sin(arg);
    sr += LR[i + 5] * ef * Math.cos(arg);
  }
  for (let i = 0; i < B.length; i += 5) {
    const m = B[i + 1];
    const arg = B[i] * D + m * M + B[i + 2] * Mp + B[i + 3] * F;
    const ef = m === 0 ? 1 : (m === 1 || m === -1) ? E : E2;
    sb += B[i + 4] * ef * Math.sin(arg);
  }
  sl += 3958 * Math.sin(A1) + 1962 * Math.sin(LpR - F) + 318 * Math.sin(A2);
  sb += -2235 * Math.sin(LpR) + 382 * Math.sin(A3) + 175 * Math.sin(A1 - F) +
    175 * Math.sin(A1 + F) + 127 * Math.sin(LpR - Mp) - 115 * Math.sin(LpR + Mp);
  const lon = wrap360(Lp + sl / 1e6) * DEG, lat = (sb / 1e6) * DEG;
  const dist = (385000.56 + sr / 1000) / KM_PER_AU;
  const ofDate = eclipticToEquatorial(fromSpherical(lon, lat), meanObliquity(jdTT));
  const j2000 = mulTransposed(precessionMatrix(jdTT), ofDate);
  return [j2000[0] * dist, j2000[1] * dist, j2000[2] * dist];
}

// Mean orbit of the Moon for drawing (JPL mean elements, ecliptic frame, epoch J2000; the
// argument of perigee advances with a 5.997 yr period, the node regresses in 18.600 yr).
function moonElements(jdTT) {
  const d = jdTT - J2000;
  return {
    a: 384400 / KM_PER_AU, e: 0.0554, i: 5.16 * DEG,
    node: (125.08 - (360 / (18.6 * 365.25)) * d) * DEG,
    peri: (318.15 + (360 / (5.997 * 365.25)) * d) * DEG,
    M: 0,
  };
}

// ---------------------------------------------------------------- satellites
// JPL mean elements (Laplace plane, epoch 2000-01-01.5 TDB): a [km], e, arg. periapsis,
// mean anomaly, inclination, node [deg]; periods of apsidal / nodal precession [yr];
// Laplace pole RA / Dec [deg]. n = mean motion of the mean longitude [deg/day].
const SATELLITES = {
  io: { parent: 'jupiter', a: 421800, e: 0.004, w: 49.1, M: 330.9, i: 0.0, node: 0.0, Pw: 1.333, Pn: 0, ra: 268.1, dec: 64.5, n: 203.488955790 },
  europa: { parent: 'jupiter', a: 671100, e: 0.009, w: 45.0, M: 345.4, i: 0.5, node: 184.0, Pw: 1.394, Pn: 30.202, ra: 268.1, dec: 64.5, n: 101.374724735 },
  ganymede: { parent: 'jupiter', a: 1070400, e: 0.001, w: 198.3, M: 324.8, i: 0.2, node: 58.5, Pw: 68.301, Pn: 137.812, ra: 268.2, dec: 64.6, n: 50.317609207 },
  callisto: { parent: 'jupiter', a: 1882700, e: 0.007, w: 43.8, M: 87.4, i: 0.3, node: 309.1, Pw: 277.921, Pn: 577.264, ra: 268.7, dec: 64.8, n: 21.571071177 },
  titan: { parent: 'saturn', a: 1221900, e: 0.029, w: 78.3, M: 11.7, i: 0.3, node: 78.6, Pw: 346.68, Pn: 687.37, ra: 36.4, dec: 84.0, n: 22.57697855 },
};
export const SATELLITE_IDS = Object.keys(SATELLITES);

/** Basis of a Laplace plane with pole (ra, dec): x = its ascending node on the ICRF equator. */
function laplaceBasis(raDeg, decDeg) {
  const a = raDeg * DEG, d = decDeg * DEG;
  const x = [-Math.sin(a), Math.cos(a), 0];
  const z = [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return [x, y, z];
}

function satelliteElements(id, jdTT) {
  const s = SATELLITES[id];
  const d = jdTT - J2000;
  // JPL's precession periods: the node regresses, the argument of periapsis advances.
  const node = s.node - (s.Pn ? 360 / (s.Pn * 365.25) : 0) * d;
  const peri = s.w + (s.Pw ? 360 / (s.Pw * 365.25) : 0) * d;
  const lambda = s.node + s.w + s.M + s.n * d; // mean longitude
  return {
    a: s.a / KM_PER_AU, e: s.e, i: s.i * DEG, node: node * DEG,
    peri: peri * DEG, M: wrap360(lambda - node - peri) * DEG, basis: laplaceBasis(s.ra, s.dec),
  };
}

const fromBasis = (b, v) => [
  b[0][0] * v[0] + b[1][0] * v[1] + b[2][0] * v[2],
  b[0][1] * v[0] + b[1][1] * v[1] + b[2][1] * v[2],
  b[0][2] * v[0] + b[1][2] * v[1] + b[2][2] * v[2],
];

/** Planetocentric J2000 equatorial position (AU) of a satellite. */
export function satellitePosition(id, jdTT) {
  const el = satelliteElements(id, jdTT);
  return fromBasis(el.basis, keplerPosition(el));
}
export const satelliteParent = (id) => SATELLITES[id].parent;

// ---------------------------------------------------------------- all bodies
/**
 * Heliocentric J2000 equatorial positions (AU) of every body at jdTT:
 * { sun, mercury, venus, earth, moon, mars, jupiter, io, europa, ganymede, callisto,
 *   saturn, titan, uranus, neptune, pluto }.
 */
export function bodyPositions(jdTT) {
  const out = { sun: [0, 0, 0] };
  for (const id of PLANET_IDS) out[id] = eclipticToEquatorial(planetEcliptic(id, jdTT));
  const emb = out.earth;
  const moon = moonGeocentric(jdTT);
  out.earth = [emb[0] - MOON_MASS_RATIO * moon[0], emb[1] - MOON_MASS_RATIO * moon[1], emb[2] - MOON_MASS_RATIO * moon[2]];
  out.moon = [out.earth[0] + moon[0], out.earth[1] + moon[1], out.earth[2] + moon[2]];
  for (const id of SATELLITE_IDS) {
    const p = out[SATELLITES[id].parent], s = satellitePosition(id, jdTT);
    out[id] = [p[0] + s[0], p[1] + s[1], p[2] + s[2]];
  }
  return out;
}

/**
 * The orbit of a body as `n` points (Float32Array, xyz) relative to its parent, J2000
 * equatorial AU, from its mean elements at jdTT. The ring closes (point n equals point 0).
 */
export function orbitPoints(id, jdTT, n = 256) {
  let el, basis = null;
  if (id === 'moon') el = moonElements(jdTT);
  else if (SATELLITES[id]) { el = satelliteElements(id, jdTT); basis = el.basis; }
  else el = planetElements(id, jdTT);
  const out = new Float32Array((n + 1) * 3);
  const b = Math.sqrt(1 - el.e * el.e);
  for (let k = 0; k <= n; k++) {
    const E = (k % n) / n * 2 * Math.PI;
    const ecl = orbitToEcliptic(el, el.a * (Math.cos(E) - el.e), el.a * b * Math.sin(E));
    const v = basis ? fromBasis(basis, ecl) : eclipticToEquatorial(ecl);
    out[k * 3] = v[0]; out[k * 3 + 1] = v[1]; out[k * 3 + 2] = v[2];
  }
  return out;
}

/** Semi-major axis of a body's orbit (AU), for scaling orbit-line fades. */
export function orbitSize(id, jdTT) {
  if (id === 'moon') return 384400 / KM_PER_AU;
  if (SATELLITES[id]) return SATELLITES[id].a / KM_PER_AU;
  return planetElements(id, jdTT).a;
}
