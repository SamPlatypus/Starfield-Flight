// WebGL2 renderer: Milky Way cube map, then additive star streaks.
import { STAR_VS, STAR_FS, SKY_VS, SKY_FS, LINE_VS, LINE_FS } from './shaders.js';
import { buildColourLut } from './colour.js';
import { SolarRenderer } from './solar.js';

const SKY_FACES = [
  ['px', 0x8515], ['nx', 0x8516], ['py', 0x8517], ['ny', 0x8518], ['pz', 0x8519], ['nz', 0x851a],
];

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    throw new Error(`shader compile failed: ${gl.getShaderInfoLog(s)}`);
  }
  return s;
}
function program(gl, vs, fs, attribs = {}) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  for (const [name, loc] of Object.entries(attribs)) gl.bindAttribLocation(p, loc, name);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(p)}`);
  }
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) || 0;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    uniforms[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
  }
  return { p, u: uniforms };
}

// How star ranges reach the GPU. Stars have no vertex buffers: the shader takes the star
// index from gl_VertexID, so a culled range [start, start + count) is naturally one
// drawArrays(first = start * 6). Some mobile GPUs start gl_VertexID at 0 for such draws
// whatever `first` says: every range then redraws the first stars of the catalogue (the
// most luminous few hundred, stacked up to ~200 times into saturated squares) and nothing
// else appears. Rather than trust a synthetic test to detect that, the renderer starts on
// the path that cannot go wrong and only moves to a faster one after comparing real frames:
//   base   drawArrays(0, count) per range, range start in the uBase uniform: never uses `first`
//   loop   drawArrays(first, count) per range
//   multi  one multiDrawArrays call for all ranges (WEBGL_multi_draw)
export const STAR_DRAW_MODES = ['multi', 'loop', 'base'];
const STAR_DRAW_NAMES = { multi: 'multi-draw', loop: 'draw-loop', base: 'base-uniform' };
const CHECK_SIZE = 192;          // px: side of the corner of the frame the comparison is drawn into
const CHECK_AT = [0, 2000, 10000]; // ms of rendering after which a fast path is (re)compared with `base`
const CHECK_MIN_LIT = 40;        // lit pixels needed for a comparison to mean anything
const CHECK_MAX_DIFF = 8;        // differing pixels tolerated (an exact match is expected)

export class Renderer {
  /**
   * @param canvas    the drawing canvas
   * @param catalog   decoded star catalogue (src/catalog.js)
   * @param skyImages { px, nx, py, ny, pz, nz } decoded images of the Milky Way cube faces (optional)
   * @param options   { starDraw: 'multi' | 'loop' | 'base' } forces a star draw path (diagnostics)
   */
  constructor(canvas, catalog, skyImages, figurePairs = null, options = {}) {
    this.canvas = canvas;
    this.catalog = catalog;
    this.skyImages = skyImages;
    this.figurePairs = figurePairs; // Uint32Array of star index pairs (constellation figures)
    this.forceStarDraw = STAR_DRAW_MODES.includes(options.starDraw) ? options.starDraw : null;
    this.lost = false;
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL 2 is not available');
    this.gl = gl;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.init(); this.lost = false; });
    this.firsts = new Int32Array(1024);
    this.counts = new Int32Array(1024);
    this.init();
  }

  init() {
    const gl = this.gl;
    this.multiDraw = gl.getExtension('WEBGL_multi_draw');
    this.resetStarDraw();
    this.star = program(gl, STAR_VS, STAR_FS);
    this.sky = program(gl, SKY_VS, SKY_FS);
    this.vao = gl.createVertexArray();

    const cat = this.catalog;
    this.starTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.starTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, cat.texWidth, cat.texHeight, 0, gl.RGBA, gl.FLOAT, cat.tex);
    this.nearest(gl.TEXTURE_2D);

    this.lutTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, buildColourLut(cat.bvMin, cat.bvStep));
    this.nearest(gl.TEXTURE_2D);

    this.skyTex = null;
    if (this.skyImages) this.uploadSky(this.skyImages);

    this.lines = program(gl, LINE_VS, LINE_FS, { aPair: 0 });
    this.lineVao = null;
    if (this.figurePairs) {
      this.lineVao = gl.createVertexArray();
      gl.bindVertexArray(this.lineVao);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, this.figurePairs, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribIPointer(0, 2, gl.UNSIGNED_INT, 0, 0);
      gl.vertexAttribDivisor(0, 1);
      gl.bindVertexArray(null);
      this.lineCount = this.figurePairs.length / 2;
    }
    this.solar = new SolarRenderer(gl);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
  }

  /**
   * Starts on the safe path with the faster ones still to be verified (see checkStarDraw).
   * this.starDraw = { mode, forced, candidates, tests: { path: { ok, bad, diff } }, ... }
   */
  resetStarDraw() {
    const forced = this.forceStarDraw && (this.forceStarDraw !== 'multi' || this.multiDraw) ? this.forceStarDraw : null;
    this.starDraw = {
      mode: forced || 'base', forced: !!forced,
      candidates: this.multiDraw ? ['multi', 'loop'] : ['loop'],
      candidate: 0,          // index of the fast path under test; candidates.length = none left
      step: 0,               // index into CHECK_AT of the next comparison
      since: 0,              // when rendering (re)started, ms
      retryAt: 0,            // earliest time of the next comparison after an inconclusive one
      tests: {},
      fault: false, done: false, label: '', status: '',
    };
    this.describeStarDraw();
  }

  /** Forces a draw path ('multi' | 'loop' | 'base'), or null for automatic. */
  setStarDraw(mode) {
    this.forceStarDraw = STAR_DRAW_MODES.includes(mode) ? mode : null;
    this.resetStarDraw();
  }

  describeStarDraw() {
    const sd = this.starDraw;
    sd.label = `${STAR_DRAW_NAMES[sd.mode]}${sd.forced ? ' (forced)' : ''}`;
    const parts = sd.candidates.filter((c) => sd.tests[c]).map((c) => {
      const t = sd.tests[c];
      return t.bad ? `${c} WRONG` : `${c} ok ${t.ok}/${CHECK_AT.length}`;
    });
    sd.status = parts.length ? parts.join(', ') : 'pending';
  }

  /**
   * Compares a fast draw path with `base` on the real frame: both draw this frame's star
   * ranges, with this frame's uniforms, into a corner of the canvas (the frame proper is
   * drawn over it afterwards) and must give the same pixels. A path that matches takes over
   * and is compared again a few seconds later, in case the driver swaps in a different
   * shader build; one that differs is dropped for good.
   */
  checkStarDraw(f, now) {
    const sd = this.starDraw;
    if (!sd.since) sd.since = now;
    const path = sd.candidates[sd.candidate];
    if (!path) { sd.done = true; return; }
    if (now - sd.since < CHECK_AT[sd.step] || now < sd.retryAt || f.ranges.n === 0) return;
    const gl = this.gl;
    const S = Math.min(CHECK_SIZE, this.canvas.width, this.canvas.height);
    const bytes = S * S * 4;
    if (!this.checkA || this.checkA.length !== bytes) { this.checkA = new Uint8Array(bytes); this.checkB = new Uint8Array(bytes); }
    const { starts, counts, n } = f.ranges;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, S, S);
    gl.viewport(0, 0, S, S);
    gl.clearColor(0, 0, 0, 1);
    const shoot = (mode, out) => {
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.drawStars(f, S, S, starts, counts, n, mode);
      gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, out);
    };
    shoot('base', this.checkA);
    shoot(path, this.checkB);
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    if (gl.isContextLost()) return;

    const A = this.checkA, B = this.checkB;
    let lit = 0, diff = 0;
    for (let i = 0; i < bytes; i += 4) {
      if (A[i] > 16 || A[i + 1] > 16 || A[i + 2] > 16) lit++;
      if (Math.abs(A[i] - B[i]) > 4 || Math.abs(A[i + 1] - B[i + 1]) > 4 || Math.abs(A[i + 2] - B[i + 2]) > 4) diff++;
    }
    if (lit < CHECK_MIN_LIT && diff <= CHECK_MAX_DIFF) { sd.retryAt = now + 500; return; } // too few stars in view to tell
    const t = sd.tests[path] || (sd.tests[path] = { ok: 0, bad: false, diff: 0 });
    if (diff > CHECK_MAX_DIFF) {
      t.bad = true;
      t.diff = diff;
      sd.fault = true;
      sd.candidate++;
      sd.step = 0;
      sd.since = now;
      if (!sd.forced) sd.mode = 'base';
      console.warn(`Star draw: '${path}' draws different stars from the offset-free path on this GPU ` +
        `(${diff} of ${S * S} pixels differ); not using it.`);
    } else {
      t.ok++;
      if (!sd.forced) sd.mode = path;
      if (++sd.step >= CHECK_AT.length) sd.candidate = sd.candidates.length; // verified
    }
    sd.done = sd.candidate >= sd.candidates.length;
    this.describeStarDraw();
  }

  nearest(target) {
    const gl = this.gl;
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  uploadSky(images) {
    const gl = this.gl;
    this.skyImages = images;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    for (const [name, target] of SKY_FACES) {
      // sRGB storage: the GPU linearises on sampling so exposure scaling is physical.
      gl.texImage2D(target, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, images[name]);
    }
    gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.skyTex = tex;
  }

  resize(width, height) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  /**
   * @param f frame: { camHi, camLo, view, viewPrev, camToWorld, tail, tanX, tanY, magLimit,
   *                   px, gain, spread, skyExposure, boost, vignette, ranges: { starts, counts, n },
   *                   hideIndex, hideScale, lines?: { alpha, magLimit }, solar?: SolarRenderer frame }
   */
  render(f) {
    const gl = this.gl;
    if (this.lost || gl.isContextLost()) return;
    const w = this.canvas.width, h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.bindVertexArray(this.vao);
    if (!this.starDraw.done) this.checkStarDraw(f, performance.now());

    // Milky Way (opaque, covers the screen).
    gl.disable(gl.BLEND);
    if (this.skyTex && f.skyExposure > 0) {
      const { p, u } = this.sky;
      gl.useProgram(p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.skyTex);
      gl.uniform1i(u.uSky, 0);
      gl.uniformMatrix3fv(u.uCamToWorld, false, f.camToWorld);
      gl.uniform2f(u.uTan, f.tanX, f.tanY);
      gl.uniform1f(u.uExposure, f.skyExposure);
      gl.uniform1f(u.uBoost, f.boost);
      gl.uniform1f(u.uVignette, f.vignette);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    // Stars, additively.
    const { starts, counts, n } = f.ranges;
    if (n > 0) this.drawStars(f, w, h, starts, counts, n);
    if (f.lines && f.lines.alpha > 0.002 && this.lineVao) this.drawLines(f, w, h);
    if (f.solar) this.solar.render(f.solar);
  }

  drawLines(f, w, h) {
    const gl = this.gl;
    const { p, u } = this.lines;
    gl.useProgram(p);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindVertexArray(this.lineVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.starTex);
    gl.uniform1i(u.uStars, 0);
    gl.uniform3fv(u.uCamHi, f.camHi);
    gl.uniform3fv(u.uCamLo, f.camLo);
    gl.uniformMatrix3fv(u.uView, false, f.view);
    gl.uniform2f(u.uTan, f.tanX, f.tanY);
    gl.uniform2f(u.uRes, w, h);
    gl.uniform1f(u.uMagLimit, f.lines.magLimit);
    gl.uniform1f(u.uAlpha, f.lines.alpha);
    gl.uniform1f(u.uPx, f.px);
    gl.uniform1f(u.uGap, 6 * f.px);
    gl.uniform3f(u.uColour, 0.5, 0.66, 1.0);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.lineCount);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.vao);
  }

  drawStars(f, w, h, starts, counts, n, mode = this.starDraw.mode) {
    const gl = this.gl;
    const { p, u } = this.star;
    gl.useProgram(p);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.starTex);
    gl.uniform1i(u.uStars, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.uniform1i(u.uLut, 1);
    gl.uniform3fv(u.uCamHi, f.camHi);
    gl.uniform3fv(u.uCamLo, f.camLo);
    gl.uniformMatrix3fv(u.uView, false, f.view);
    gl.uniformMatrix3fv(u.uViewPrev, false, f.viewPrev);
    gl.uniform3fv(u.uTail, f.tail);
    gl.uniform2f(u.uTan, f.tanX, f.tanY);
    gl.uniform2f(u.uRes, w, h);
    gl.uniform1f(u.uMagLimit, f.magLimit);
    gl.uniform1f(u.uPx, f.px);
    gl.uniform1f(u.uGain, f.gain);
    gl.uniform1f(u.uSpread, f.spread);
    gl.uniform1i(u.uHideIndex, f.hideIndex ?? -1);
    gl.uniform1f(u.uHideScale, f.hideScale ?? 1);

    if (mode === 'base') {
      // Never relies on the draw's `first`: the shader adds the range start itself.
      for (let i = 0; i < n; i++) {
        gl.uniform1i(u.uBase, starts[i]);
        gl.drawArrays(gl.TRIANGLES, 0, counts[i] * 6);
      }
    } else {
      gl.uniform1i(u.uBase, 0);
      if (this.firsts.length < n) { this.firsts = new Int32Array(n * 2); this.counts = new Int32Array(n * 2); }
      const firsts = this.firsts, cnt = this.counts;
      for (let i = 0; i < n; i++) { firsts[i] = starts[i] * 6; cnt[i] = counts[i] * 6; }
      if (mode === 'multi') {
        this.multiDraw.multiDrawArraysWEBGL(gl.TRIANGLES, firsts, 0, cnt, 0, n);
      } else {
        for (let i = 0; i < n; i++) gl.drawArrays(gl.TRIANGLES, firsts[i], cnt[i]);
      }
    }
    gl.disable(gl.BLEND);
  }
}
