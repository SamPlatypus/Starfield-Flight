// Constellation stick figures, drawn between the real 3D positions of their stars.
// From near the Sun they are the familiar IAU figures; fly away and they distort, because
// constellations are only line-of-sight coincidences.
//
// Fading (shared with the GPU shader in render/shaders.js, keep the two in step):
//   a segment shows when both of its stars are naked-eye bright from where you are: full
//   when the fainter one is brighter than min(limit, 6.5) - 0.2, gone 1.2 mag fainter; far
//   from the Sun (300 to 3,000 ly) the figures dim to 20 % because they no longer look like
//   anything familiar.
export const LINE_ALPHA = 0.22;
const PC_TO_LY = 3.261563777;

const smooth = (t) => { const c = Math.min(1, Math.max(0, t)); return c * c * (3 - 2 * c); };
export const magFade = (fainterMag, magLimit) => smooth((Math.min(magLimit, 6.5) - 0.2 + 1.2 - fainterMag) / 1.2);
export const solFade = (solDistPc) => 1 - 0.8 * smooth((solDistPc * PC_TO_LY - 300) / 2700);

export class Constellations {
  constructor(json, catalog) {
    this.catalog = catalog;
    this.abbr = json.abbr;
    this.name = json.name;
    this.rank = json.rank;
    let n = 0;
    for (const f of json.figures) n += (f.length - 1) / 2;
    this.count = n;
    this.pairs = new Uint32Array(n * 2); // star indices, for the GPU
    this.con = new Uint8Array(n);
    let k = 0;
    for (const f of json.figures) {
      for (let j = 1; j + 1 < f.length; j += 2) { this.pairs[k * 2] = f[j]; this.pairs[k * 2 + 1] = f[j + 1]; this.con[k] = f[0]; k++; }
    }
    this.stars = Int32Array.from(new Set(this.pairs));
    const slot = new Map();
    this.stars.forEach((star, k) => slot.set(star, k));
    this.slots = new Uint16Array(n * 2); // pair ends as positions in this.stars
    for (let k = 0; k < n * 2; k++) this.slots[k] = slot.get(this.pairs[k]);
    const m = this.stars.length;
    this.sx = new Float64Array(m); this.sy = new Float64Array(m); this.mag = new Float64Array(m); this.front = new Uint8Array(m);
    this.sums = new Float64Array(88 * 4);
  }

  /** Opacity of segment k seen from `cam` (pc). */
  segmentAlpha(k, cam, magLimit, sf) {
    const c = this.catalog;
    const a = this.pairs[k * 2], b = this.pairs[k * 2 + 1];
    const pa = c.position(a), pb = c.position(b);
    const ma = c.absMag(a) + 5 * Math.log10(Math.max(Math.hypot(pa[0] - cam[0], pa[1] - cam[1], pa[2] - cam[2]), 1e-9)) - 5;
    const mb = c.absMag(b) + 5 * Math.log10(Math.max(Math.hypot(pb[0] - cam[0], pb[1] - cam[1], pb[2] - cam[2]), 1e-9)) - 5;
    return LINE_ALPHA * magFade(Math.max(ma, mb), magLimit) * sf;
  }

  /**
   * Name placements: each constellation's label sits at the weighted centre of its visible
   * segments on screen. Returns up to `max` of [conIndex, x, y, weight], heaviest first.
   */
  labels(proj, magLimit, max = 12) {
    const cam = proj.cam, cat = this.catalog, tex = cat.tex;
    const sf = solFade(Math.hypot(cam[0], cam[1], cam[2]));
    const { sx, sy, mag, front, stars } = this;
    const v = [0, 0, 0];
    for (let k = 0; k < stars.length; k++) {
      const i = stars[k];
      proj.toViewXYZ(tex[i * 4], tex[i * 4 + 1], tex[i * 4 + 2], v);
      front[k] = v[2] < 0 ? 1 : 0;
      if (!front[k]) continue;
      const [x, y] = proj.toScreen(v);
      sx[k] = x; sy[k] = y;
      mag[k] = cat.absMag(i) + 5 * Math.log10(Math.max(Math.hypot(v[0], v[1], v[2]), 1e-9)) - 5;
    }
    const s = this.sums;
    s.fill(0);
    for (let k = 0; k < this.count; k++) {
      const a = this.slots[k * 2], b = this.slots[k * 2 + 1];
      if (!front[a] || !front[b]) continue;
      const mx = (sx[a] + sx[b]) / 2, my = (sy[a] + sy[b]) / 2;
      if (mx < 0 || my < 0 || mx > proj.w || my > proj.h) continue;
      const alpha = LINE_ALPHA * magFade(Math.max(mag[a], mag[b]), magLimit) * sf;
      if (alpha < 0.05) continue;
      const w = alpha * Math.min(400, Math.hypot(sx[a] - sx[b], sy[a] - sy[b]));
      const c = this.con[k] * 4;
      s[c] += mx * w; s[c + 1] += my * w; s[c + 2] += w; s[c + 3] += alpha;
    }
    const out = [];
    for (let c = 0; c < 88; c++) {
      const w = s[c * 4 + 2];
      if (w <= 0 || s[c * 4 + 3] < 0.5) continue; // needs a couple of clearly visible segments
      out.push([c, s[c * 4] / w, s[c * 4 + 1] / w, w]);
    }
    out.sort((a, b) => b[3] - a[3]);
    return out.length > max ? out.slice(0, max) : out;
  }
}
