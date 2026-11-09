// Photometric conversions used by tools/build-stars.mjs (kept separate so tests can import them).
// Gaia BP-RP -> effective temperature along the dwarf sequence (after Mamajek's
// "Modern Mean Dwarf Stellar Color and Effective Temperature Sequence").
const BPRP_TEFF = [
  [-0.35, 31000], [-0.20, 17000], [-0.10, 12500], [0.00, 9700], [0.15, 8600], [0.30, 7700],
  [0.45, 7000], [0.60, 6450], [0.75, 5950], [0.82, 5770], [0.98, 5270], [1.10, 4950],
  [1.25, 4650], [1.43, 4400], [1.73, 4050], [1.84, 3850], [1.97, 3660], [2.09, 3560],
  [2.32, 3430], [2.73, 3210], [3.13, 3060], [3.60, 2810], [4.00, 2680], [4.30, 2570],
  [4.50, 2380], [4.80, 2200],
];
export function teffFromBpRp(x) {
  const t = BPRP_TEFF;
  if (x <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) {
    if (x <= t[i][0]) {
      const f = (x - t[i - 1][0]) / (t[i][0] - t[i - 1][0]);
      return t[i - 1][1] + f * (t[i][1] - t[i - 1][1]);
    }
  }
  return t[t.length - 1][1];
}
// Inverse of Ballesteros (2012), T = 4600 (1/(0.92 bv + 1.7) + 1/(0.92 bv + 0.62)),
// so every star is coloured by the same B-V -> temperature -> sRGB path in the shader.
export function bvFromTeff(T) {
  const k = T / 4600;
  const a = k, b = 2.32 * k - 2, c = 1.054 * k - 2.32;
  const u = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  return u / 0.92;
}
// Gaia EDR3 G - V as a function of BP-RP (Riello et al. 2021, valid -0.5..2.75),
// extended linearly past 2.75 with the slope at that point (fits M dwarfs to ~0.1 mag).
export function gMinusV(x) {
  if (x > 2.75) return -1.32179 - 0.84804 * (x - 2.75);
  const c = Math.max(-0.5, x);
  return -0.02704 + 0.01424 * c - 0.2156 * c * c + 0.01426 * c * c * c;
}
// Main-sequence BP-RP from absolute G, for the few GCNS stars without BP/RP photometry.
const MG_BPRP = [[0, 0.0], [2, 0.4], [4, 0.75], [5, 0.95], [6, 1.15], [7, 1.45], [8, 1.8], [9, 2.1],
  [10, 2.4], [11, 2.7], [12, 3.0], [13, 3.4], [14, 3.8], [15, 4.2], [16, 4.6]];
export function bpRpFromMG(mg) {
  const t = MG_BPRP;
  if (mg <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) {
    if (mg <= t[i][0]) return t[i - 1][1] + (mg - t[i - 1][0]) / (t[i][0] - t[i - 1][0]) * (t[i][1] - t[i - 1][1]);
  }
  return t[t.length - 1][1];
}
// Spectral class -> rough B-V for the handful of stars with no colour index.
export function bvFromSpectrum(sp) {
  const m = /([OBAFGKM])(\d(?:\.\d)?)?/.exec(sp || '');
  if (!m) return 0.65;
  const base = { O: -0.32, B: -0.30, A: 0.0, F: 0.30, G: 0.58, K: 0.81, M: 1.40 }[m[1]];
  const next = { O: -0.30, B: 0.0, A: 0.30, F: 0.58, G: 0.81, K: 1.40, M: 1.80 }[m[1]];
  const sub = m[2] ? +m[2] / 10 : 0.5;
  return base + (next - base) * sub;
}
