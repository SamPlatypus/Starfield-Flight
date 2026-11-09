// Astronomy helpers shared by the Solar System ephemerides: angles, Kepler's equation,
// time scales and precession. Ported from the Star-Sky app (js/astro/*), where they are
// validated against astronomy-engine and Meeus' worked examples.

export const DEG = Math.PI / 180;
export const ARCSEC = DEG / 3600;
export const TAU = Math.PI * 2;

export const wrap360 = (d) => ((d % 360) + 360) % 360;
export const wrap2pi = (a) => ((a % TAU) + TAU) % TAU;
export const wrapPi = (a) => wrap2pi(a + Math.PI) - Math.PI;

/** Unit vector from spherical angles (radians): lon from +x towards +y, lat from the xy plane. */
export function fromSpherical(lon, lat) {
  const c = Math.cos(lat);
  return [c * Math.cos(lon), c * Math.sin(lon), Math.sin(lat)];
}

/** Solve Kepler's equation E - e sin E = M (radians). */
export function solveKepler(M, e) {
  M = wrapPi(M);
  let E = e < 0.8 ? M : Math.PI * Math.sign(M || 1);
  for (let i = 0; i < 30; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  return E;
}

// ---------------------------------------------------------------- time
export const J2000 = 2451545.0;
const UNIX_EPOCH_JD = 2440587.5;

/** Julian date (UT) of epoch milliseconds or a Date. */
export function julianDay(date) {
  const ms = typeof date === 'number' ? date : date.getTime();
  return ms / 86400000 + UNIX_EPOCH_JD;
}
export const dateFromJulian = (jd) => new Date((jd - UNIX_EPOCH_JD) * 86400000);
export const decimalYear = (jd) => 2000 + (jd - J2000) / 365.25;

// Delta T = TT - UT (seconds): observed values 1972-2026 joined to the Morrison &
// Stephenson long-term parabola.
const DT_TABLE = [
  [1972, 42.2], [1980, 50.5], [1990, 56.9], [2000, 63.8], [2005, 64.7],
  [2010, 66.1], [2015, 67.6], [2017, 68.6], [2020, 69.4], [2026, 69.2],
];
const longTerm = (y) => { const u = (y - 1820) / 100; return -20 + 32 * u * u; };
export function deltaT(year) {
  const first = DT_TABLE[0], last = DT_TABLE[DT_TABLE.length - 1];
  if (year <= first[0]) {
    if (year < 1900) return longTerm(year);
    const t = (year - 1900) / (first[0] - 1900);
    return longTerm(1900) + (first[1] - longTerm(1900)) * t;
  }
  if (year >= last[0]) {
    if (year > 2150) return longTerm(year);
    const t = (year - last[0]) / (2150 - last[0]);
    return last[1] + (longTerm(2150) - last[1]) * t * t;
  }
  for (let i = 1; i < DT_TABLE.length; i++) {
    const [y1, v1] = DT_TABLE[i];
    if (year <= y1) {
      const [y0, v0] = DT_TABLE[i - 1];
      return v0 + ((v1 - v0) * (year - y0)) / (y1 - y0);
    }
  }
  return last[1];
}
/** Terrestrial Time Julian date from a UT Julian date. */
export const ttFromUt = (jdUT) => jdUT + deltaT(decimalYear(jdUT)) / 86400;
/** Julian centuries of TT since J2000. */
export const centuries = (jdTT) => (jdTT - J2000) / 36525;

// ---------------------------------------------------------------- frames
export const OBLIQUITY_J2000 = 23.4392911 * DEG;

/** Ecliptic -> equatorial rectangular coordinates for obliquity eps. */
export function eclipticToEquatorial(v, eps = OBLIQUITY_J2000) {
  const c = Math.cos(eps), s = Math.sin(eps);
  return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]];
}

/** Mean obliquity of the ecliptic of date (radians), Meeus eq. 22.2. */
export function meanObliquity(jdTT) {
  const T = centuries(jdTT);
  return (23.4392911 * 3600 - 46.815 * T - 0.00059 * T * T + 0.001813 * T * T * T) * ARCSEC;
}

/** Precession matrix (row-major) J2000 -> mean equator of date, IAU 1976 (Meeus eq. 21.2). */
export function precessionMatrix(jdTT) {
  const T = centuries(jdTT);
  const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) * ARCSEC;
  const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) * ARCSEC;
  const theta = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) * ARCSEC;
  const cz = Math.cos(zeta), sz = Math.sin(zeta);
  const cZ = Math.cos(z), sZ = Math.sin(z);
  const ct = Math.cos(theta), st = Math.sin(theta);
  return [
    cz * ct * cZ - sz * sZ, -sz * ct * cZ - cz * sZ, -st * cZ,
    cz * ct * sZ + sz * cZ, -sz * ct * sZ + cz * cZ, -st * sZ,
    cz * st, -sz * st, ct,
  ];
}

/** Transposed (inverse) row-major 3x3 times a vector. */
export const mulTransposed = (m, v) => [
  m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
  m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
  m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
];
