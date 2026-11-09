// Small vector / quaternion helpers for the flight model. Plain arrays of float64 so
// positions far from the Sun keep full precision; only camera-relative values reach the GPU.

export const PC_TO_LY = 3.261563777;
export const LY_TO_AU = 63241.077;
export const DEG = Math.PI / 180;

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
/** Exponential smoothing factor for a time constant `tau` over `dt` seconds. */
export const ease = (dt, tau) => (tau <= 0 ? 1 : 1 - Math.exp(-dt / tau));

export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};

// Quaternions are [x, y, z, w] and rotate camera-local vectors into the world frame.
// Camera convention: +x right, +y up, looking down -z.
export const quat = {
  identity: () => [0, 0, 0, 1],
  mul(a, b) {
    const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
    return [
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz,
    ];
  },
  normalize(q) { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; },
  conj: (q) => [-q[0], -q[1], -q[2], q[3]],
  fromAxisAngle(axis, angle) {
    const s = Math.sin(angle / 2);
    return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
  },
  /** Rotation by a rotation vector (axis * angle), as used to integrate angular velocity. */
  fromRotationVector(r) {
    const a = Math.hypot(r[0], r[1], r[2]);
    if (a < 1e-12) return quat.normalize([r[0] / 2, r[1] / 2, r[2] / 2, 1]);
    return quat.fromAxisAngle([r[0] / a, r[1] / a, r[2] / a], a);
  },
  rotate(q, v) {
    const [x, y, z, w] = q;
    // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
    const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
    return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
  },
  slerp(a, b, t) {
    let [bx, by, bz, bw] = b;
    let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
    if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    if (cos > 0.9995) return quat.normalize([a[0] + (bx - a[0]) * t, a[1] + (by - a[1]) * t, a[2] + (bz - a[2]) * t, a[3] + (bw - a[3]) * t]);
    const th = Math.acos(cos), s = Math.sin(th), wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
    return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
  },
  /** Orientation whose -z axis looks along `forward` with +y as close as possible to `up`. */
  lookRotation(forward, up) {
    const f = v3.norm(forward);
    let r = v3.cross(f, up);
    if (v3.len(r) < 1e-6) r = v3.cross(f, Math.abs(f[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]);
    r = v3.norm(r);
    const u = v3.cross(r, f);
    return quat.fromBasis(r, u, [-f[0], -f[1], -f[2]]);
  },
  /** Quaternion from orthonormal camera axes expressed in world coordinates. */
  fromBasis(x, y, z) {
    const m00 = x[0], m10 = x[1], m20 = x[2], m01 = y[0], m11 = y[1], m21 = y[2], m02 = z[0], m12 = z[1], m22 = z[2];
    const tr = m00 + m11 + m22;
    let q;
    if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s]; }
    else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
    else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]; }
    else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]; }
    return quat.normalize(q);
  },
  /** Column-major 3x3 camera->world matrix (columns: right, up, back). */
  toMat3(q, out = new Float32Array(9)) {
    const [x, y, z, w] = q;
    const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
    out[0] = 1 - 2 * (yy + zz); out[1] = 2 * (xy + wz); out[2] = 2 * (xz - wy);
    out[3] = 2 * (xy - wz); out[4] = 1 - 2 * (xx + zz); out[5] = 2 * (yz + wx);
    out[6] = 2 * (xz + wy); out[7] = 2 * (yz - wx); out[8] = 1 - 2 * (xx + yy);
    return out;
  },
};

/** Transpose of a column-major 3x3 (the inverse of a rotation). */
export function transpose3(m, out = new Float32Array(9)) {
  out[0] = m[0]; out[1] = m[3]; out[2] = m[6];
  out[3] = m[1]; out[4] = m[4]; out[5] = m[7];
  out[6] = m[2]; out[7] = m[5]; out[8] = m[8];
  return out;
}

/** Unit vector for right ascension / declination in degrees (equatorial J2000 frame). */
export function radec(raDeg, decDeg) {
  const a = raDeg * DEG, d = decDeg * DEG, c = Math.cos(d);
  return [c * Math.cos(a), c * Math.sin(a), Math.sin(d)];
}

// Galactic north pole and centre in the equatorial frame (ICRS, Hipparcos definition).
export const GALACTIC_NORTH = radec(192.85948, 27.12825);
export const GALACTIC_CENTRE = radec(266.40499, -28.93617);

/** Apparent magnitude of a star of absolute magnitude M seen from `d` parsecs. */
export const apparentMag = (M, d) => M + 5 * Math.log10(Math.max(d, 1e-9)) - 5;

/** Human-friendly distance from parsecs. */
export function formatDistance(pc) {
  const ly = pc * PC_TO_LY;
  if (ly < 0.05) {
    const au = ly * LY_TO_AU;
    return au < 10 ? `${au.toFixed(1)} AU` : `${Math.round(au).toLocaleString('en-US')} AU`;
  }
  if (ly < 10) return `${ly.toFixed(2)} ly`;
  if (ly < 100) return `${ly.toFixed(1)} ly`;
  if (ly < 100000) return `${Math.round(ly).toLocaleString('en-US')} ly`;
  return `${(ly / 1000).toFixed(0)}k ly`;
}

/** Speed in parsecs per second as light-years per second. */
export function formatSpeed(pcPerSec) {
  const ly = pcPerSec * PC_TO_LY;
  if (ly < 0.0005) return '0 ly/s';
  if (ly < 1) return `${ly.toFixed(ly < 0.1 ? 3 : 2)} ly/s`;
  if (ly < 10) return `${ly.toFixed(1)} ly/s`;
  return `${Math.round(ly).toLocaleString('en-US')} ly/s`;
}
