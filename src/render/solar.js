// Solar System renderer: drawn after the stars, only when the ship is near the Sun.
//
//   bodies   one screen-space quad each; every pixel ray-traces the body's ellipsoid in its
//            IAU body-fixed frame (pole, rotation, flattening), lit by the real Sun direction
//            so phases are right, with procedural surfaces, atmosphere rims, Saturn's rings
//            (with the planet's shadow on them and theirs on the planet) and the Sun's
//            limb-darkened disc and corona. Bodies too small to resolve become star-like
//            points whose brightness comes from their visual magnitude.
//   orbits   thick polylines from the mean orbital elements, bent near the body so the
//            line passes exactly through it (perturbations move planets off their mean orbit)
//   belt     6,000 particles orbiting on the GPU (Kepler's equation in the vertex shader)
// All positions reach the GPU relative to the camera, in AU (planets) or body radii.

const BODY_VS = `#version 300 es
uniform vec4 uRect; // NDC x0, y0, x1, y1
void main() {
  gl_Position = vec4((gl_VertexID & 1) == 0 ? uRect.x : uRect.z, (gl_VertexID & 2) == 0 ? uRect.y : uRect.w, 0.0, 1.0);
}
`;

const BODY_FS = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform vec2 uTan;
uniform vec3 uC;            // body centre in view space, in equatorial radii
uniform mat3 uRot;          // view -> body-fixed
uniform float uPolar;       // polar / equatorial radius
uniform vec3 uSun;          // body -> Sun unit vector, body-fixed
uniform int uStyle;
uniform vec3 uColour;
uniform vec2 uRings;        // ring inner / outer radius in equatorial radii (0 = none)
uniform float uDisc;        // weight of the resolved disc
uniform vec4 uPoint;        // unresolved: peak, sigma px, glow, glow radius px
uniform vec2 uCentrePx;
uniform float uAtmos;       // atmosphere rim strength
uniform vec3 uAtmosColour;
uniform float uAlpha;       // Solar System fade-in
out vec4 outColour;

float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }
float fbm3(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 3; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s / 0.875; }
// 1 between latitudes a and b (degrees), with soft edges
float band(float l, float a, float b) { return smoothstep(a - 1.5, a + 1.5, l) * (1.0 - smoothstep(b - 1.5, b + 1.5, l)); }

float ringDensity(float r) {
  if (r < 1.239 || r > 2.270) return 0.0;
  if (r < 1.527) return 0.10 + 0.05 * noise(vec3(r * 90.0));         // C ring
  if (r < 1.951) return 0.75 + 0.20 * noise(vec3(r * 120.0));        // B ring
  if (r < 2.025) return 0.06;                                         // Cassini division
  if (abs(r - 2.214) < 0.004) return 0.05;                            // Encke gap
  return 0.48 + 0.12 * noise(vec3(r * 140.0));                        // A ring
}

// Albedo of a surface point p on the unit sphere (body-fixed, +z north).
vec3 surface(vec3 p) {
  float lat = asin(clamp(p.z, -1.0, 1.0));
  float lon = atan(p.y, p.x);
  vec3 c = uColour;
  if (uStyle == 1) {                       // cratered rock: Mercury, Callisto
    float n = fbm(p * 5.0);
    float craters = smoothstep(0.62, 0.7, noise(p * 22.0)) * 0.25;
    return c * (0.72 + 0.45 * n - craters);
  }
  if (uStyle == 2) {                       // Venus: cloud tops
    return c * (0.93 + 0.07 * sin(lat * 9.0 + fbm(p * 3.0) * 4.0));
  }
  if (uStyle == 3) {                       // Earth
    float land = smoothstep(0.50, 0.53, fbm(p * 2.3 + 3.1));
    vec3 ground = mix(vec3(0.20, 0.33, 0.14), vec3(0.55, 0.47, 0.32), smoothstep(0.4, 0.75, fbm(p * 6.0)));
    vec3 col = mix(vec3(0.04, 0.12, 0.30), ground, land);
    col = mix(col, vec3(0.92), smoothstep(1.15, 1.25, abs(lat) + 0.08 * noise(p * 8.0)));
    float cloud = smoothstep(0.52, 0.72, fbm(p * 4.0 + vec3(7.3)));
    return mix(col, vec3(0.95), cloud * 0.85);
  }
  if (uStyle == 4) {                       // Moon / Ganymede: highlands and maria
    float maria = smoothstep(0.42, 0.36, fbm(p * 2.2 + 11.0));
    return c * (0.82 + 0.3 * fbm(p * 9.0) - 0.32 * maria);
  }
  if (uStyle == 5) {                       // Mars
    vec3 col = c * (0.78 + 0.3 * fbm(p * 3.0) - 0.28 * smoothstep(0.5, 0.62, fbm(p * 2.0 + 5.0)));
    return mix(col, vec3(0.93, 0.9, 0.88), smoothstep(1.26, 1.33, abs(lat) + 0.05 * noise(p * 10.0)));
  }
  if (uStyle == 6 || uStyle == 7) {        // Jupiter, Saturn: their real belts and zones by latitude
    bool jup = uStyle == 6;
    // zonal winds smear everything along longitude: noise stretched in latitude
    float L = degrees(lat) + (jup ? 3.0 : 1.6) * (fbm3(vec3(p.xy * 2.5, p.z * 9.0)) - 0.5);
    float aL = abs(L);
    float dark = jup
      ? 0.95 * band(L, 7.0, 17.0) + 0.85 * band(L, -20.0, -7.0)      // NEB, SEB
        + 0.5 * band(L, 24.0, 31.0) + 0.45 * band(L, -33.0, -27.0)   // NTB, STB
        + 0.3 * band(L, 36.0, 40.0) + 0.3 * band(L, -42.0, -38.0) + 0.5 * smoothstep(42.0, 62.0, aL)
      : 0.45 * band(L, 14.0, 26.0) + 0.4 * band(L, -26.0, -14.0)
        + 0.25 * band(L, 32.0, 40.0) + 0.25 * band(L, -40.0, -32.0) + 0.4 * smoothstep(55.0, 75.0, aL);
    float streak = fbm3(vec3(p.xy * 3.0, p.z * 40.0));
    dark = clamp(dark * (0.75 + 0.5 * streak) + 0.1 * (streak - 0.5), 0.0, 1.0);
    vec3 zone = jup ? vec3(0.95, 0.91, 0.82) : vec3(0.94, 0.87, 0.68);
    vec3 beltC = jup ? vec3(0.60, 0.42, 0.30) : vec3(0.80, 0.67, 0.45);
    vec3 polar = jup ? vec3(0.62, 0.59, 0.57) : vec3(0.72, 0.70, 0.63);
    vec3 col = mix(zone, beltC, dark);
    col = mix(col, polar, 0.6 * smoothstep(45.0, 70.0, aL));
    if (jup) {                             // the Great Red Spot: 22 degrees south, ~16,000 x 12,000 km
      float dl = lon - 0.9;
      dl -= 6.2831853 * floor((dl + 3.14159265) / 6.2831853);
      float r = length(vec2(dl / 0.12, (lat + 0.384) / 0.084));
      col = mix(col, vec3(0.97, 0.93, 0.86), 0.7 * smoothstep(1.45, 1.05, r)); // its pale hollow
      col = mix(col, vec3(0.78, 0.40, 0.26), smoothstep(1.0, 0.65, r));
    }
    return col;
  }
  if (uStyle == 8) return c * (0.96 + 0.04 * sin(lat * 6.0));                    // Uranus
  if (uStyle == 9) return c * (0.88 + 0.12 * sin(lat * 8.0 + fbm(p * 3.0) * 3.0)); // Neptune
  if (uStyle == 10) {                      // Europa: ice crossed by brown lineae
    float lines = smoothstep(0.03, 0.0, abs(fbm(p * 3.0) - 0.5)) + smoothstep(0.025, 0.0, abs(fbm(p * 5.0 + 9.0) - 0.5));
    return mix(c, vec3(0.6, 0.45, 0.32), clamp(lines, 0.0, 0.7));
  }
  if (uStyle == 11) {                      // Io: sulphur and volcanoes
    vec3 col = mix(c, vec3(0.85, 0.55, 0.25), smoothstep(0.45, 0.7, fbm(p * 4.0)));
    return mix(col, vec3(0.15, 0.1, 0.08), smoothstep(0.72, 0.78, noise(p * 14.0)));
  }
  if (uStyle == 12) return c * (0.95 + 0.05 * fbm(p * 2.0));                    // Titan haze
  if (uStyle == 13) {                      // Pluto: the bright heart (Tombaugh Regio)
    vec3 col = c * (0.75 + 0.35 * fbm(p * 4.0));
    float heart = smoothstep(0.6, 0.35, length(vec2((lon - 3.0) * 0.9, lat - 0.2)));
    return mix(col, vec3(0.95, 0.92, 0.88), heart);
  }
  return c;
}

void main() {
  vec3 colour = vec3(0.0);
  float alpha = 0.0;
  vec3 glow = vec3(0.0);
  vec2 ndc = gl_FragCoord.xy / uRes * 2.0 - 1.0;
  vec3 dir = normalize(vec3(ndc * uTan, -1.0));

  if (uPoint.x > 0.0 || uPoint.z > 0.0) {   // star-like point (unresolved or glare)
    vec2 dp = gl_FragCoord.xy - uCentrePx;
    float r2 = dot(dp, dp);
    float q = 1.0 + r2 / (uPoint.w * uPoint.w);
    glow += uColour * (uPoint.x * exp(-0.5 * r2 / (uPoint.y * uPoint.y)) + uPoint.z / (q * sqrt(q)));
  }

  if (uDisc > 0.0) {
    vec3 rd = uRot * dir;
    vec3 ro = uRot * (-uC);
    vec3 s = vec3(1.0, 1.0, 1.0 / uPolar);
    vec3 o2 = ro * s, d2 = rd * s;
    float dd = dot(d2, d2);
    float t0 = -dot(o2, d2) / dd;
    vec3 q = o2 + t0 * d2;                  // closest approach to the centre (unit-sphere space)
    float h2 = dot(q, q);
    float tHit = 1e30;
    if (h2 < 1.0 && t0 > 0.0) {
      float dt = sqrt((1.0 - h2) / dd);
      tHit = t0 - dt;
      vec3 ps = q - dt * d2;                // hit point on the unit sphere
      vec3 n = normalize(ps * s);           // ellipsoid normal
      float mu = max(dot(n, -normalize(rd)), 0.0);
      if (uStyle == 0) {                    // the Sun: limb darkening and granulation
        float limb = 1.0 - 0.6 * (1.0 - mu) - 0.25 * (1.0 - mu) * (1.0 - mu);
        colour = uColour * limb * (0.93 + 0.07 * noise(ps * 70.0));
      } else {
        float ndl = dot(n, uSun);
        float wrap = uAtmos > 0.0 ? 0.12 : 0.0;
        float light = clamp((ndl + wrap) / (1.0 + wrap), 0.0, 1.0);
        vec3 alb = surface(ps);
        if (uRings.y > 0.0 && abs(uSun.z) > 1e-4) { // ring shadow on the planet
          float ts = -ps.z / uSun.z;
          if (ts > 0.0) light *= 1.0 - 0.85 * ringDensity(length((ps + ts * uSun).xy));
        }
        colour = alb * light * 1.1 + alb * 0.012;
        colour += uAtmosColour * uAtmos * pow(1.0 - mu, 3.0) * clamp(ndl + 0.25, 0.0, 1.0);
      }
      alpha = 1.0;
    }
    // Saturn's rings, in the equatorial plane
    if (uRings.y > 0.0 && abs(rd.z) > 1e-7) {
      float tr = -ro.z / rd.z;
      if (tr > 0.0 && tr < tHit) {
        vec3 pr = ro + tr * rd;
        float dens = ringDensity(length(pr.xy));
        if (dens > 0.0) {
          // the planet's shadow on the rings
          vec3 o3 = pr * s, d3 = uSun * s;
          float ts = -dot(o3, d3) / dot(d3, d3);
          float lit = (ts > 0.0 && dot(o3 + ts * d3, o3 + ts * d3) < 1.0) ? 0.08 : 1.0;
          float sunSide = clamp(abs(uSun.z) * 4.0, 0.15, 1.0);
          vec3 rc = vec3(0.86, 0.79, 0.66) * (0.85 + 0.3 * noise(vec3(length(pr.xy) * 300.0)));
          colour = mix(colour, rc * lit * sunSide, dens);
          alpha = max(alpha, dens);
        }
      }
    }
    // atmosphere rim and solar corona just outside the limb
    float h = sqrt(h2);
    if (h >= 1.0 && t0 > 0.0) {
      if (uStyle == 0) {
        vec3 qq = q / h;
        float streamers = 0.75 + 0.25 * noise(vec3(atan(qq.y, qq.x) * 3.0, qq.z * 3.0, 0.0));
        glow += uColour * 0.55 * pow(h, -3.2) * streamers;
      } else if (uAtmos > 0.0 && h < 1.05) {
        float lit = smoothstep(-0.25, 0.4, dot(normalize(q * s), uSun));
        glow += uAtmosColour * uAtmos * 0.8 * pow(1.0 - (h - 1.0) / 0.05, 2.0) * lit;
      }
    }
  }
  // premultiplied: the disc covers the stars behind it, the glow adds light
  outColour = vec4((colour * alpha) * uDisc * uAlpha + glow * uAlpha, alpha * uDisc * uAlpha);
}
`;

const ORBIT_VS = `#version 300 es
precision highp float;
uniform vec3 uOrigin;     // parent position relative to the camera (AU, world axes)
uniform mat3 uView;
uniform vec2 uTan;
uniform vec2 uRes;
uniform float uPx;
uniform vec3 uFix;        // body minus its mean-orbit point (AU): bends the line through the body
uniform float uFixAt;     // where the body is along the ring, in segments
uniform float uFixSpan;   // segments over which the bend fades out
uniform float uSegments;
in vec3 aP0;
in vec3 aP1;
out highp vec2 vLocal;
flat out float vHalfW;
out highp float vDist;    // AU from the camera, interpolated along the segment
vec2 toPixels(vec3 p) { return (vec2(p.x / (-p.z * uTan.x), p.y / (-p.z * uTan.y)) * 0.5 + 0.5) * uRes; }
float fixWeight(float k) { float d = abs(k - uFixAt); d = min(d, uSegments - d); return 1.0 - smoothstep(0.0, uFixSpan, d); }
// Clips the view-space segment a-b to the view frustum widened by uTan * 1.5 and to the near
// plane, so lines from points beside or behind the camera stay exact and bounded on screen.
bool clipSegment(inout vec3 a, inout vec3 b, vec2 tanK, float near) {
  float t0 = 0.0, t1 = 1.0;
  vec3 d = b - a;
  for (int i = 0; i < 5; i++) {
    float fa, fb;
    if (i == 0) { fa = -a.z - near; fb = -b.z - near; }
    else if (i == 1) { fa = -a.z * tanK.x + a.x; fb = -b.z * tanK.x + b.x; }
    else if (i == 2) { fa = -a.z * tanK.x - a.x; fb = -b.z * tanK.x - b.x; }
    else if (i == 3) { fa = -a.z * tanK.y + a.y; fb = -b.z * tanK.y + b.y; }
    else { fa = -a.z * tanK.y - a.y; fb = -b.z * tanK.y - b.y; }
    if (fa < 0.0 && fb < 0.0) return false;
    if (fa < 0.0) t0 = max(t0, fa / (fa - fb));
    else if (fb < 0.0) t1 = min(t1, fa / (fa - fb));
  }
  if (t0 >= t1) return false;
  vec3 a0 = a;
  a = a0 + d * t0;
  b = a0 + d * t1;
  return true;
}
void main() {
  gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  float k = float(gl_InstanceID);
  vec3 a = uView * (uOrigin + aP0 + uFix * fixWeight(k)), b = uView * (uOrigin + aP1 + uFix * fixWeight(k + 1.0));
  if (!clipSegment(a, b, uTan * 1.5, 1e-9)) return;   // near plane: 150 m (AU units)
  vec2 A = toPixels(a), B = toPixels(b);
  vec2 d = B - A;
  float L = length(d);
  if (L < 0.01) return;
  vec2 u = d / L, n = vec2(-u.y, u.x);
  float hw = 0.7 * uPx, ext = hw + 1.5;
  int c = gl_VertexID;
  bool atB = c == 2 || c == 3 || c == 5;
  float side = (c == 1 || c == 4 || c == 5) ? 1.0 : -1.0;
  // segments meet end to end: overlapping joints would add up into a dashed look
  float ex = atB ? L : 0.0;
  vLocal = vec2(ex, side * ext);
  vHalfW = hw;
  // Segments share their end points, so the distance (and with it the fade of a line that
  // passes close to the camera) runs on smoothly from one segment to the next.
  vDist = atB ? length(b) : length(a);
  gl_Position = vec4((A + u * ex + n * side * ext) / uRes * 2.0 - 1.0, 0.0, 1.0);
}
`;

const ORBIT_FS = `#version 300 es
precision highp float;
uniform vec3 uColour;
uniform float uAlpha;
uniform float uNear;      // AU: lines fade out within this distance of the camera
in highp vec2 vLocal;
flat in float vHalfW;
in highp float vDist;
out vec4 outColour;
void main() {
  float edge = 1.0 - smoothstep(vHalfW - 0.4, vHalfW + 0.9, abs(vLocal.y));
  outColour = vec4(uColour * uAlpha * edge * smoothstep(uNear * 0.3, uNear, vDist), 1.0);
}
`;

const BELT_VS = `#version 300 es
precision highp float;
uniform float uDays;      // days since J2000 (TT)
uniform vec3 uSun;        // Sun relative to the camera (AU, world axes)
uniform mat3 uView;
uniform mat3 uEcl;        // ecliptic -> equatorial
uniform vec2 uTan;
uniform vec2 uRes;
uniform float uSize;
in vec3 aOrbit;           // a [AU], e, i
in vec3 aAngles;          // node, argument of perihelion, mean anomaly at J2000 (radians)
out float vFade;
void main() {
  float a = aOrbit.x, e = aOrbit.y, inc = aOrbit.z;
  float n = 0.0172020989 / (a * sqrt(a));            // Gaussian gravitational constant, rad/day
  float M = mod(aAngles.z + n * uDays, 6.2831853);
  float E = M + e * sin(M);
  for (int k = 0; k < 3; k++) E -= (E - e * sin(E) - M) / (1.0 - e * cos(E));
  vec2 xy = vec2(a * (cos(E) - e), a * sqrt(1.0 - e * e) * sin(E));
  float cw = cos(aAngles.y), sw = sin(aAngles.y), cO = cos(aAngles.x), sO = sin(aAngles.x), cI = cos(inc), sI = sin(inc);
  vec3 ecl = vec3((cw * cO - sw * sO * cI) * xy.x + (-sw * cO - cw * sO * cI) * xy.y,
                  (cw * sO + sw * cO * cI) * xy.x + (-sw * sO + cw * cO * cI) * xy.y,
                  sw * sI * xy.x + cw * sI * xy.y);
  vec3 v = uView * (uSun + uEcl * ecl);
  vFade = smoothstep(0.02, 0.2, -v.z);
  if (v.z > -1e-6) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  gl_Position = vec4(v.x / (-v.z * uTan.x), v.y / (-v.z * uTan.y), 0.0, 1.0);
  gl_PointSize = uSize;
}
`;

const BELT_FS = `#version 300 es
precision mediump float;
uniform vec3 uColour;
uniform float uAlpha;
in float vFade;
out vec4 outColour;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float a = uAlpha * vFade * smoothstep(1.0, 0.2, dot(d, d));
  outColour = vec4(uColour * a, 1.0);
}
`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(`solar shader: ${gl.getShaderInfoLog(s)}`);
  return s;
}
function program(gl, vs, fs, attribs = {}) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  for (const [name, loc] of Object.entries(attribs)) gl.bindAttribLocation(p, loc, name);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`solar program: ${gl.getProgramInfoLog(p)}`);
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) || 0;
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
  return { p, u };
}

/** Synthetic main belt: Kirkwood gaps at the 3:1, 5:2, 7:3 and 2:1 resonances with Jupiter. */
export function makeBelt(count = 6000, seed = 7) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const gaps = [[2.502, 0.03], [2.825, 0.02], [2.958, 0.012], [3.279, 0.03]];
  const orbit = new Float32Array(count * 3), angles = new Float32Array(count * 3);
  for (let k = 0; k < count; k++) {
    let a;
    do { a = 2.1 + 1.25 * rnd(); } while (gaps.some(([g, w]) => Math.abs(a - g) < w * (0.6 + 0.4 * rnd())));
    const e = Math.min(0.3, Math.abs(0.13 + 0.07 * (rnd() + rnd() + rnd() - 1.5)));
    const inc = Math.min(0.5, Math.abs((rnd() + rnd() + rnd() - 1.5) * 0.22));
    orbit.set([a, e, inc], k * 3);
    angles.set([rnd() * 6.2831853, rnd() * 6.2831853, rnd() * 6.2831853], k * 3);
  }
  return { orbit, angles, count };
}

export class SolarRenderer {
  constructor(gl) {
    this.gl = gl;
    this.init();
  }

  init() {
    const gl = this.gl;
    this.body = program(gl, BODY_VS, BODY_FS);
    this.orbit = program(gl, ORBIT_VS, ORBIT_FS, { aP0: 0, aP1: 1 });
    this.belt = program(gl, BELT_VS, BELT_FS, { aOrbit: 0, aAngles: 1 });
    this.emptyVao = gl.createVertexArray();
    this.orbitVaos = new Map(); // id -> { vao, buf, n, points }
    const belt = makeBelt();
    this.beltCount = belt.count;
    this.beltVao = gl.createVertexArray();
    gl.bindVertexArray(this.beltVao);
    for (const [loc, data] of [[0, belt.orbit], [1, belt.angles]]) {
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    }
    gl.bindVertexArray(null);
  }

  orbitVao(id, points) {
    const gl = this.gl;
    let o = this.orbitVaos.get(id);
    if (!o) {
      o = { vao: gl.createVertexArray(), buf: gl.createBuffer(), n: 0, points: null };
      gl.bindVertexArray(o.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, o.buf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
      gl.vertexAttribDivisor(0, 1);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 12, 12);
      gl.vertexAttribDivisor(1, 1);
      gl.bindVertexArray(null);
      this.orbitVaos.set(id, o);
    }
    if (o.points !== points) {
      gl.bindBuffer(gl.ARRAY_BUFFER, o.buf);
      gl.bufferData(gl.ARRAY_BUFFER, points, gl.DYNAMIC_DRAW);
      o.points = points;
      o.n = points.length / 3 - 1;
    }
    return o;
  }

  /**
   * @param f { view (Float32 col-major world->view), tanX, tanY, w, h, px, alpha,
   *            orbits: [{ id, points, origin (Float32 3), colour, alpha, near, fix (Float32 3), fixAt }],
   *            belt: { alpha, sun (Float32 3), days }, bodies: [uniform sets, far to near] }
   */
  render(f) {
    const gl = this.gl;
    gl.viewport(0, 0, f.w, f.h);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    // orbits (additive)
    if (f.orbits.length) {
      const { p, u } = this.orbit;
      gl.useProgram(p);
      gl.uniformMatrix3fv(u.uView, false, f.view);
      gl.uniform2f(u.uTan, f.tanX, f.tanY);
      gl.uniform2f(u.uRes, f.w, f.h);
      gl.uniform1f(u.uPx, f.px);
      for (const o of f.orbits) {
        const vao = this.orbitVao(o.id, o.points);
        gl.bindVertexArray(vao.vao);
        gl.uniform3fv(u.uOrigin, o.origin);
        gl.uniform3fv(u.uColour, o.colour);
        gl.uniform1f(u.uAlpha, o.alpha);
        gl.uniform1f(u.uNear, o.near);
        gl.uniform3fv(u.uFix, o.fix);
        gl.uniform1f(u.uFixAt, o.fixAt);
        gl.uniform1f(u.uFixSpan, Math.max(1, vao.n / 10));
        gl.uniform1f(u.uSegments, vao.n);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, vao.n);
      }
    }

    // asteroid belt (additive points)
    if (f.belt && f.belt.alpha > 0.003) {
      const { p, u } = this.belt;
      gl.useProgram(p);
      gl.bindVertexArray(this.beltVao);
      gl.uniform1f(u.uDays, f.belt.days);
      gl.uniform3fv(u.uSun, f.belt.sun);
      gl.uniformMatrix3fv(u.uView, false, f.view);
      gl.uniformMatrix3fv(u.uEcl, false, f.belt.ecl);
      gl.uniform2f(u.uTan, f.tanX, f.tanY);
      gl.uniform2f(u.uRes, f.w, f.h);
      gl.uniform1f(u.uSize, Math.max(1, 1.4 * f.px));
      gl.uniform3f(u.uColour, 0.78, 0.72, 0.62);
      gl.uniform1f(u.uAlpha, f.belt.alpha);
      gl.drawArrays(gl.POINTS, 0, this.beltCount);
    }

    // bodies, far to near (premultiplied alpha: discs hide what is behind them)
    if (f.bodies.length) {
      const { p, u } = this.body;
      gl.useProgram(p);
      gl.bindVertexArray(this.emptyVao);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform2f(u.uRes, f.w, f.h);
      gl.uniform2f(u.uTan, f.tanX, f.tanY);
      for (const b of f.bodies) {
        gl.uniform4fv(u.uRect, b.rect);
        gl.uniform3fv(u.uC, b.centre);
        gl.uniformMatrix3fv(u.uRot, false, b.rot);
        gl.uniform1f(u.uPolar, b.polar);
        gl.uniform3fv(u.uSun, b.sun);
        gl.uniform1i(u.uStyle, b.style);
        gl.uniform3fv(u.uColour, b.colour);
        gl.uniform2fv(u.uRings, b.rings);
        gl.uniform1f(u.uDisc, b.disc);
        gl.uniform4fv(u.uPoint, b.point);
        gl.uniform2fv(u.uCentrePx, b.centrePx);
        gl.uniform1f(u.uAtmos, b.atmos);
        gl.uniform3fv(u.uAtmosColour, b.atmosColour);
        gl.uniform1f(u.uAlpha, b.alpha);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }
}
