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

export class Renderer {
  /**
   * @param canvas    the drawing canvas
   * @param catalog   decoded star catalogue (src/catalog.js)
   * @param skyImages { px, nx, py, ny, pz, nz } decoded images of the Milky Way cube faces (optional)
   */
  constructor(canvas, catalog, skyImages, figurePairs = null) {
    this.canvas = canvas;
    this.catalog = catalog;
    this.skyImages = skyImages;
    this.figurePairs = figurePairs; // Uint32Array of star index pairs (constellation figures)
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

  drawStars(f, w, h, starts, counts, n) {
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

    if (this.firsts.length < n) { this.firsts = new Int32Array(n * 2); this.counts = new Int32Array(n * 2); }
    const firsts = this.firsts, cnt = this.counts;
    for (let i = 0; i < n; i++) { firsts[i] = starts[i] * 6; cnt[i] = counts[i] * 6; }
    if (this.multiDraw) {
      this.multiDraw.multiDrawArraysWEBGL(gl.TRIANGLES, firsts, 0, cnt, 0, n);
    } else {
      for (let i = 0; i < n; i++) gl.drawArrays(gl.TRIANGLES, firsts[i], cnt[i]);
    }
    gl.disable(gl.BLEND);
  }
}
