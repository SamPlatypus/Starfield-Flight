// Star colours: B-V colour index -> effective temperature (Ballesteros 2012) -> the colour
// of a blackbody at that temperature, integrated against the CIE 1931 2-degree colour
// matching functions (multi-lobe Gaussian fit of Wyman, Sloan & Shirley 2013), converted
// to sRGB. The result is normalised (brightness is handled separately) and slightly
// desaturated, because the eye sees starlight much less saturated than a print would.

export function bvToTemperature(bv) {
  const b = Math.max(-0.4, Math.min(2.4, bv));
  return 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
}

const g = (x, mu, s1, s2) => { const t = (x - mu) / (x < mu ? s1 : s2); return Math.exp(-0.5 * t * t); };
const cieX = (l) => 1.056 * g(l, 599.8, 37.9, 31.0) + 0.362 * g(l, 442.0, 16.0, 26.7) - 0.065 * g(l, 501.1, 20.4, 26.2);
const cieY = (l) => 0.821 * g(l, 568.8, 46.9, 40.5) + 0.286 * g(l, 530.9, 16.3, 31.1);
const cieZ = (l) => 1.217 * g(l, 437.0, 11.8, 36.0) + 0.681 * g(l, 459.0, 26.0, 13.8);

/** Linear sRGB of a blackbody, scaled so the largest component is 1. */
export function blackbodyLinear(T) {
  let X = 0, Y = 0, Z = 0;
  for (let l = 380; l <= 780; l += 5) {
    const p = 1 / (l ** 5 * (Math.exp(1.4387769e7 / (l * T)) - 1));
    X += p * cieX(l); Y += p * cieY(l); Z += p * cieZ(l);
  }
  let r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  let gg = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
  let b = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  // Bring out-of-gamut colours (very cool stars) back in by adding white.
  const lo = Math.min(r, gg, b);
  if (lo < 0) { r -= lo; gg -= lo; b -= lo; }
  const hi = Math.max(r, gg, b);
  return [r / hi, gg / hi, b / hi];
}

const encode = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);

/** sRGB-encoded star colour for a B-V index, desaturated by `desat` (0..1) towards white. */
export function starColour(bv, desat = 0.3) {
  const c = blackbodyLinear(bvToTemperature(bv));
  return c.map((v) => encode(v + (1 - v) * desat));
}

/** 256-entry RGBA8 lookup indexed by the catalogue's quantised colour index. */
export function buildColourLut(bvMin, bvStep, desat = 0.3) {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const c = starColour(bvMin + i * bvStep, desat);
    lut[i * 4] = Math.round(c[0] * 255);
    lut[i * 4 + 1] = Math.round(c[1] * 255);
    lut[i * 4 + 2] = Math.round(c[2] * 255);
    lut[i * 4 + 3] = 255;
  }
  return lut;
}
