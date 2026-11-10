// CPU culling: chooses which contiguous star ranges the GPU has to look at this frame.
//
// A star of absolute magnitude M is visible out to R = 10^((mLim - M + 5) / 5) parsecs.
// Every magnitude band has its own octree, so a band is only searched within the radius
// of its brightest member: faint red dwarfs are only fetched from the few nodes around the
// camera, while supergiants come from the whole Galaxy. Nodes must also touch the view
// frustum - swept forward by the streak length so a star that has just flown past still
// draws its tail. The vertex shader makes the exact per-star decision.

const EMIT_MIN = 192; // nodes this small are drawn whole instead of refined further

export function visibilityRadius(magLimit, absMag) {
  return 10 ** ((magLimit - absMag + 5) / 5);
}

export class Culler {
  constructor(catalog) {
    this.cat = catalog;
    this.capacity = 1024;
    this.starts = new Int32Array(this.capacity);
    this.counts = new Int32Array(this.capacity);
    this.rangeCount = 0;
    this.stack = new Int32Array(512);
    this.nodesVisited = 0;
    this.starsSubmitted = 0;
  }

  emit(start, count) {
    const n = this.rangeCount;
    if (n > 0 && this.starts[n - 1] + this.counts[n - 1] === start) { this.counts[n - 1] += count; return; }
    if (n === this.capacity) {
      this.capacity *= 2;
      const s = new Int32Array(this.capacity); s.set(this.starts); this.starts = s;
      const c = new Int32Array(this.capacity); c.set(this.counts); this.counts = c;
    }
    this.starts[n] = start; this.counts[n] = count; this.rangeCount = n + 1;
  }

  /**
   * @param cam       camera position [x, y, z] in parsecs (float64)
   * @param planes    Float64Array of unit normals (world frame) of planes through the camera;
   *                  a point p is inside when dot(n, p - cam) >= 0
   * @param planeCount number of planes in `planes`
   * @param travel    unit direction of travel (the view direction, except on autopilot)
   * @param sweep     how far (pc) behind its current position a star's streak tail can be
   * @param magLimit  faintest apparent magnitude drawn
   */
  collect(cam, planes, planeCount, travel, sweep, magLimit) {
    const { nodeBounds: B, nodeLinks: L, bands } = this.cat;
    this.rangeCount = 0;
    this.nodesVisited = 0;
    this.starsSubmitted = 0;
    const cx = cam[0], cy = cam[1], cz = cam[2];
    // Per-plane extra reach of the swept boxes: tails sit at +travel * sweep.
    const reach = new Float64Array(planeCount);
    for (let p = 0; p < planeCount; p++) {
      const nf = planes[p * 3] * travel[0] + planes[p * 3 + 1] * travel[1] + planes[p * 3 + 2] * travel[2];
      reach[p] = Math.max(0, sweep * nf);
    }
    let stack = this.stack;
    for (const band of bands) {
      const R = visibilityRadius(magLimit, band.mMin);
      const R2 = R * R;
      let sp = 0;
      stack[sp++] = band.root;
      while (sp > 0) {
        const n = stack[--sp];
        this.nodesVisited++;
        const b = n * 6;
        const ex = (B[b + 3] - B[b]) * 0.5, ey = (B[b + 4] - B[b + 1]) * 0.5, ez = (B[b + 5] - B[b + 2]) * 0.5;
        const ox = B[b] + ex - cx, oy = B[b + 1] + ey - cy, oz = B[b + 2] + ez - cz;
        const ax = Math.abs(ox), ay = Math.abs(oy), az = Math.abs(oz);
        // Visibility sphere.
        const dx = Math.max(0, ax - ex), dy = Math.max(0, ay - ey), dz = Math.max(0, az - ez);
        if (dx * dx + dy * dy + dz * dz > R2) continue;
        const fx = ax + ex, fy = ay + ey, fz = az + ez;
        const insideSphere = fx * fx + fy * fy + fz * fz <= R2;
        // Frustum (swept).
        let outside = false, insideFrustum = true;
        for (let p = 0; p < planeCount; p++) {
          const nx = planes[p * 3], ny = planes[p * 3 + 1], nz = planes[p * 3 + 2];
          const centre = nx * ox + ny * oy + nz * oz;
          const radius = Math.abs(nx) * ex + Math.abs(ny) * ey + Math.abs(nz) * ez;
          if (centre + radius + reach[p] < 0) { outside = true; break; }
          if (centre - radius < 0) insideFrustum = false;
        }
        if (outside) continue;
        const l = n * 4;
        const count = L[l + 1], childCount = L[l + 3];
        if (childCount === 0 || count <= EMIT_MIN || (insideSphere && insideFrustum)) {
          this.emit(L[l], count);
          this.starsSubmitted += count;
          continue;
        }
        if (sp + childCount > stack.length) {
          const s = new Int32Array(stack.length * 2); s.set(stack); stack = this.stack = s;
        }
        // Push in reverse so children are visited (and emitted) in index order.
        const first = L[l + 2];
        for (let k = childCount - 1; k >= 0; k--) stack[sp++] = first + k;
      }
    }
    return this.rangeCount;
  }
}

/**
 * Frustum side planes (world frame, through the eye) for a camera with world->view
 * rotation `view` (column-major 3x3) and half-angle tangents, widened by `margin` radians.
 * Returns the number of planes written (4 sides + 1 near plane at the eye).
 */
export function frustumPlanes(view, tanX, tanY, margin, out) {
  const ax = Math.atan(tanX) + margin, ay = Math.atan(tanY) + margin;
  // Planes in view space (camera looks down -z): inside when n . p >= 0.
  const local = [];
  if (ax < Math.PI / 2 - 1e-3) {
    const t = Math.tan(ax), k = 1 / Math.hypot(1, t);
    local.push([k, 0, -t * k], [-k, 0, -t * k]);
  }
  if (ay < Math.PI / 2 - 1e-3) {
    const t = Math.tan(ay), k = 1 / Math.hypot(1, t);
    local.push([0, k, -t * k], [0, -k, -t * k]);
  }
  local.push([0, 0, -1]); // near plane through the eye: only things in front
  // view is world->view, so a view-space normal maps to world with the transpose:
  // n_world = V^T n_view, i.e. n_world[i] = sum_j V[j][i] n[j] = sum_j view[i*3 + j] n[j]
  local.forEach((n, p) => {
    for (let i = 0; i < 3; i++) out[p * 3 + i] = view[i * 3] * n[0] + view[i * 3 + 1] * n[1] + view[i * 3 + 2] * n[2];
  });
  return local.length;
}
