// GLSL ES 3.00 shaders.
//
// Stars are drawn without vertex attributes: gl_VertexID / 6 is the star index, which
// selects one RGBA32F texel (position in parsecs + packed colour/absolute magnitude), and
// gl_VertexID % 6 picks a corner of the star's quad. That makes any contiguous star range
// a single drawArrays call, which is what the octree culling produces.
//
// Each star is a camera-facing capsule from where it was `tau` seconds ago (tail) to where
// it is now (head): real motion blur at short exposures, warp streaks at long ones. Its
// apparent magnitude comes from its true distance to the camera, so brightness, size and
// fade-in are all physical; only the exposure (limiting magnitude) is a user choice.

export const STAR_VS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uStars;
uniform sampler2D uLut;
uniform vec3 uCamHi;      // camera position split into float32 high + low parts:
uniform vec3 uCamLo;      // (star - hi) is exact for nearby stars, then - lo
uniform mat3 uView;       // world -> view, now
uniform mat3 uViewPrev;   // world -> view, tau seconds ago
uniform vec3 uTail;       // camera displacement over tau: rel(t - tau) = rel + uTail
uniform vec2 uTan;        // tan(half field of view) in x and y
uniform vec2 uRes;        // drawing buffer size in pixels
uniform float uMagLimit;  // faintest apparent magnitude drawn
uniform float uPx;        // pixel scale of the point spread function
uniform float uGain;      // overall brightness
uniform float uSpread;    // how strongly a streak spreads its light (1 = photometric)

out highp vec2 vLocal;    // pixels: x along the streak from the tail, y across
flat out float vLen;
flat out float vInvSig2;
flat out float vPeak;
flat out float vGlow;
flat out float vInvRho2;
flat out float vWhite;
flat out vec3 vColour;

const float NEAR = 2e-6;  // parsecs (0.4 AU)

vec2 toPixels(vec3 p) {
  return (vec2(p.x / (-p.z * uTan.x), p.y / (-p.z * uTan.y)) * 0.5 + 0.5) * uRes;
}

void main() {
  int star = gl_VertexID / 6;
  int corner = gl_VertexID - star * 6;
  vec4 t = texelFetch(uStars, ivec2(star & 2047, star >> 11), 0);
  vec3 rel = (t.xyz - uCamHi) - uCamLo;
  float d = max(length(rel), 1e-7);
  float ci = floor(t.w * (1.0 / 64.0));
  float M = t.w - ci * 64.0 - 16.0;
  float m = M + 1.5051500 * log2(d) - 5.0;          // M + 5 log10(d / 10 pc)
  float dm = uMagLimit - m;
  gl_Position = vec4(0.0, 0.0, 2.0, 1.0);           // outside the clip volume = culled
  if (dm <= 0.0) return;

  vec3 head = uView * rel;
  vec3 tail = uViewPrev * (rel + uTail);
  bool hIn = head.z < -NEAR, tIn = tail.z < -NEAR;
  if (!hIn && !tIn) return;
  if (!hIn) head = mix(tail, head, (tail.z + NEAR) / (tail.z - head.z));
  else if (!tIn) tail = mix(head, tail, (head.z + NEAR) / (head.z - tail.z));
  vec2 h = toPixels(head);
  vec2 tl = toPixels(tail);

  // Photometry: flux relative to the limiting magnitude, fading in over the last 0.8 mag.
  float F = exp2(1.3287712 * min(dm, 40.0));      // 10^(0.4 dm)
  float fade = smoothstep(0.0, 0.8, dm);
  // Point spread: faint stars are a dim Gaussian; once the core saturates the disc grows
  // with the fourth root of the flux and a soft halo appears, like a photograph of the sky.
  float raw = 0.13 * sqrt(F) * uGain;
  float sig = 0.72 * uPx * clamp(pow(raw, 0.4), 1.0, 6.0);
  float peak = min(raw, 1.5) * fade;
  float glow = clamp(0.012 * (sqrt(F) - 5.0), 0.0, 0.6) * fade * uGain;
  float rho = 0.72 * uPx * (2.2 + 1.3 * log2(1.0 + F / 150.0));

  vec2 dir = h - tl;
  float L = length(dir);
  float maxL = 2.0 * length(uRes);
  if (L > maxL) { tl = h - dir * (maxL / L); dir = h - tl; L = maxL; }
  float spread = 1.0 / (1.0 + uSpread * L / (2.5 * sig));
  peak *= spread;
  glow *= mix(1.0, spread, 0.7);
  if (peak < 0.003 && glow < 0.003) return;

  float rCore = peak > 0.004 ? sig * sqrt(2.0 * log(peak / 0.004)) : 0.0;
  float rGlow = glow > 0.004 ? rho * sqrt(pow(glow / 0.004, 0.6667) - 1.0) : 0.0;
  float R = clamp(max(rCore, rGlow), 1.5 * uPx, 72.0 * uPx) + 0.5;

  vec2 u = L > 1e-3 ? dir / L : vec2(1.0, 0.0);
  vec2 n = vec2(-u.y, u.x);
  // two triangles: (tail-, tail+, head-) (head-, tail+, head+)
  bool atHead = corner == 2 || corner == 3 || corner == 5;
  float side = (corner == 1 || corner == 4 || corner == 5) ? 1.0 : -1.0;
  float ex = atHead ? L + R : -R;
  float ey = side * R;
  vec2 p = tl + u * ex + n * ey;

  vLocal = vec2(ex, ey);
  vLen = L;
  vInvSig2 = 1.0 / (sig * sig);
  vPeak = peak;
  vGlow = glow;
  vInvRho2 = 1.0 / (rho * rho);
  vWhite = clamp(log2(1.0 + peak) - 0.6, 0.0, 1.0) * 0.85;
  vColour = texelFetch(uLut, ivec2(int(ci), 0), 0).rgb;
  gl_Position = vec4(p / uRes * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const STAR_FS = `#version 300 es
precision highp float;
in highp vec2 vLocal;
flat in float vLen;
flat in float vInvSig2;
flat in float vPeak;
flat in float vGlow;
flat in float vInvRho2;
flat in float vWhite;
flat in vec3 vColour;
out vec4 outColour;

void main() {
  float a = clamp(vLocal.x, 0.0, vLen);
  vec2 dv = vec2(vLocal.x - a, vLocal.y);
  float r2 = dot(dv, dv);
  float core = vPeak * exp(-0.5 * r2 * vInvSig2);
  float q = 1.0 + r2 * vInvRho2;
  float glow = vGlow / (q * sqrt(q));
  float g = vLen > 1.0 ? mix(0.22, 1.0, a / vLen) : 1.0;   // brighter towards the head
  vec3 c = mix(vColour, vec3(1.0), clamp(core - 0.7, 0.0, 1.0) * vWhite);
  outColour = vec4(c * ((core + glow) * g), 1.0);
}
`;

// Full-screen triangle; the Milky Way cube map is sampled along each pixel's view ray.
export const SKY_VS = `#version 300 es
out vec2 vNdc;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vNdc = p * 2.0 - 1.0;
  gl_Position = vec4(vNdc, 0.0, 1.0);
}
`;

export const SKY_FS = `#version 300 es
precision highp float;
uniform samplerCube uSky;
uniform mat3 uCamToWorld;
uniform vec2 uTan;
uniform float uExposure;  // linear multiplier for the Milky Way
uniform float uBoost;     // 0..1: zoom blur + vignette while boosting
uniform float uVignette;
in vec2 vNdc;
out vec4 outColour;

vec3 sky(vec2 ndc) {
  return texture(uSky, uCamToWorld * normalize(vec3(ndc * uTan, -1.0))).rgb;
}

void main() {
  vec3 c = sky(vNdc);
  if (uBoost > 0.01) {
    // Radial blur towards the direction of travel.
    vec3 acc = c;
    for (int i = 1; i <= 4; i++) acc += sky(vNdc * (1.0 - float(i) * 0.035 * uBoost));
    c = acc * 0.2;
  }
  float r2 = dot(vNdc * uTan, vNdc * uTan) / dot(uTan, uTan);
  c *= uExposure * (1.0 - (uVignette + 0.35 * uBoost) * r2);
  c = pow(max(c, 0.0), vec3(1.0 / 2.2));
  // Dither to hide banding in the dark sky.
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  outColour = vec4(c + (n - 0.5) / 255.0, 1.0);
}
`;
