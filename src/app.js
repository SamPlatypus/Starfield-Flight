// App controller: loads the data, owns the ship, and runs the frame loop
// (simulate -> cull -> render -> HUD) once per display refresh.
import { parseCatalog, parseNames } from './catalog.js';
import { Renderer } from './render/renderer.js';
import { Culler, frustumPlanes } from './culling.js';
import { Ship, speedToThrottle, throttleToSpeed } from './flight.js';
import { quat, v3, transpose3, radec, clamp, apparentMag, formatDistance, PC_TO_LY } from './math.js';
import { Hud, Projector, describeStar } from './hud.js';
import { Input } from './input.js';
import { Controls } from './controls.js';
import { PerfGovernor } from './perf.js';
import { loadSettings, saveSettings, densityToMag } from './settings.js';
import { haptic, setHaptics, onBackButton, onPauseResume } from './platform.js';

const BASE = import.meta.env?.BASE_URL ?? './';
const SKY_FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
const DPR_CAP = 2;
const START_HEADING = radec(83.8, -1.2);   // Orion's belt
const START_OFFSET = 0.02;                 // pc from the Sun (~4,100 AU), already outbound

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = +res.headers.get('content-length') || 0;
  if (!res.body || !total) return res.arrayBuffer();
  const reader = res.body.getReader();
  const buf = new Uint8Array(total);
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > buf.length) return new Blob([buf.subarray(0, got), value]).arrayBuffer(); // compressed size lied
    buf.set(value, got);
    got += value.length;
    onProgress(got / total);
  }
  return got === total ? buf.buffer : buf.slice(0, got).buffer;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}

export class App {
  constructor(canvas) {
    this.canvas = canvas;
    this.settings = loadSettings();
    setHaptics(this.settings.haptics);
    this.ship = new Ship();
    this.ship.level = this.settings.level;
    this.ship.throttle = this.settings.throttle;
    this.perf = new PerfGovernor();
    // ?fixed pins quality (automated screenshots on software GL); ?stats shows the overlay.
    const q = new URLSearchParams(location.search);
    this.perf.locked = q.has('fixed');
    if (q.has('stats')) this.settings.stats = true;
    this.proj = new Projector();
    this.steerSources = { touch: [0, 0], key: [0, 0] };
    this.boostSources = new Set();
    this.selected = null;
    this.running = false;
    this.frameNo = 0;
    this.planes = new Float64Array(15);
    this.camToWorld = new Float32Array(9);
    this.view = new Float32Array(9);
    this.viewPrev = new Float32Array(9);
    this.m3 = new Float32Array(9);
    this.camHi = new Float32Array(3);
    this.camLo = new Float32Array(3);
    this.tail = new Float32Array(3);
    this.ranges = { starts: null, counts: null, n: 0 };
    this.rollRateInput = 0;
  }

  async init(progress = () => {}) {
    let starP = 0, skyN = 0;
    const report = () => progress(0.75 * starP + 0.25 * (skyN / SKY_FACES.length));
    const starsP = fetchWithProgress(`${BASE}data/stars.bin`, (p) => { starP = p; report(); });
    const namesP = fetch(`${BASE}data/names.json`).then((r) => r.json());
    const skyP = Promise.all(SKY_FACES.map((f) => loadImage(`${BASE}sky/${f}.jpg`).then((img) => { skyN++; report(); return [f, img]; })))
      .then((list) => Object.fromEntries(list))
      .catch((err) => { console.warn('Milky Way unavailable', err); return null; });
    const [buf, names, sky] = await Promise.all([starsP, namesP, skyP]);
    this.catalog = parseCatalog(buf);
    this.names = parseNames(names);
    this.nameOf = new Map(this.names.map((n) => [n.index, n]));
    this.solIndex = this.names.find((n) => n.name === 'Sol')?.index ?? -1;
    this.renderer = new Renderer(this.canvas, this.catalog, sky);
    this.culler = new Culler(this.catalog);

    this.hud = new Hud(this);
    this.hud.setLabels(this.settings.labels);
    this.input = new Input(this.canvas, document.getElementById('stick'), this);
    this.input.invertPitch = this.settings.invertPitch;
    this.controls = new Controls(this);
    document.getElementById('stats').hidden = !this.settings.stats;

    // Start just outside the Solar System, heading for Orion, the Sun behind us.
    const f = START_HEADING;
    this.ship.pos = v3.scale(f, START_OFFSET);
    this.ship.lookAlong(f);
    this.ship.speed = throttleToSpeed(this.ship.throttle) * 0.25;

    window.addEventListener('resize', () => this.resize());
    onPauseResume(() => this.pause(), () => this.resume());
    onBackButton(() => this.back());
    this.resize();
  }

  // ---------------------------------------------------------------- lifecycle
  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      this.frame(now);
    };
    this.raf = requestAnimationFrame(loop);
  }
  pause() { this.running = false; cancelAnimationFrame(this.raf); this.boostSources.clear(); this.ship.boostHeld = false; }
  resume() { if (!document.hidden) this.start(); }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP) * this.perf.scale;
    this.cssW = window.innerWidth;
    this.cssH = window.innerHeight;
    this.dpr = dpr;
    this.renderer.resize(Math.max(1, Math.round(this.cssW * dpr)), Math.max(1, Math.round(this.cssH * dpr)));
  }

  // ---------------------------------------------------------------- frame
  frame(now) {
    const dtMs = now - this.last;
    this.last = now;
    const dt = clamp(dtMs / 1000, 0, 0.1);
    if (!this.perf.locked && this.perf.frame(now, dtMs)) this.resize();
    const ship = this.ship;
    const s = this.settings;

    // Inputs.
    const st = this.steerSources;
    ship.steer[0] = clamp(st.touch[0] + st.key[0], -1, 1);
    ship.steer[1] = clamp(st.touch[1] + st.key[1], -1, 1);
    ship.rollInput = this.rollRateInput;
    ship.boostHeld = this.boostSources.size > 0;
    ship.update(dt, (i) => this.catalog.position(i));
    for (const ev of ship.events.splice(0)) this.onShipEvent(ev);

    // Camera.
    const w = this.renderer.canvas.width, h = this.renderer.canvas.height;
    const fov = (s.fov + 16 * ship.boost ** 1.3) * Math.PI / 180;
    const t = Math.tan(fov / 2);
    const tanX = w < h ? t : t * w / h;
    const tanY = w < h ? t * h / w : t;
    quat.toMat3(ship.q, this.camToWorld);
    transpose3(this.camToWorld, this.view);
    // Streak exposure: a fraction of a frame up to a few frames; longer while boosting.
    const tau = (0.2 + 3.6 * s.blur ** 1.3) / 60 * (1 + 1.8 * ship.boost);
    transpose3(quat.toMat3(ship.orientationAgo(tau), this.m3), this.viewPrev);
    const fwd = ship.forward;
    const back = ship.speed * tau;
    this.tail[0] = fwd[0] * back; this.tail[1] = fwd[1] * back; this.tail[2] = fwd[2] * back;
    for (let k = 0; k < 3; k++) {
      this.camHi[k] = ship.pos[k];
      this.camLo[k] = ship.pos[k] - this.camHi[k];
    }
    const magLimit = Math.min(densityToMag(s.density), this.perf.magCap);

    // Cull.
    const omega = Math.hypot(ship.omega[0], ship.omega[1], ship.omega[2]);
    const planeCount = frustumPlanes(this.view, tanX, tanY, omega * tau + 0.04, this.planes);
    const culler = this.culler;
    const n = culler.collect(ship.pos, this.planes, planeCount, fwd, back * 1.05 + 1e-6, magLimit);
    this.ranges.starts = culler.starts; this.ranges.counts = culler.counts; this.ranges.n = n;

    // Render.
    const skyExposure = 0.85 * s.milkyWay ** 2 * 10 ** (0.2 * (magLimit - 7.5));
    this.renderer.render({
      camHi: this.camHi, camLo: this.camLo, view: this.view, viewPrev: this.viewPrev, camToWorld: this.camToWorld,
      tail: this.tail, tanX, tanY, magLimit,
      px: Math.max(1, this.dpr * 0.78), gain: s.gain, spread: 0.5 - 0.2 * ship.boost,
      skyExposure: Math.min(2.5, skyExposure), boost: ship.boost, vignette: 0.22,
      ranges: this.ranges,
    });

    // HUD (CSS pixels).
    const p = this.proj;
    p.view.set(this.view);
    p.cam = ship.pos;
    p.tanX = tanX; p.tanY = tanY; p.w = this.cssW; p.h = this.cssH;
    const lf = this.lastFrame || (this.lastFrame = { proj: p, ship, catalog: this.catalog, names: this.names });
    lf.magLimit = magLimit;
    lf.now = now;
    this.hud.update(lf);
    if ((this.frameNo++ & 7) === 0) {
      this.controls.update();
      if (s.stats) this.updateStats(culler, magLimit);
    }
  }

  updateStats(culler, magLimit) {
    const el = document.getElementById('stats');
    el.textContent = [
      `${this.perf.fps.toFixed(0)} fps (${this.perf.refresh} Hz)  scale ${this.perf.scale.toFixed(2)}`,
      `${this.renderer.canvas.width}×${this.renderer.canvas.height}  mag ≤ ${magLimit.toFixed(2)}`,
      `stars submitted ${culler.starsSubmitted.toLocaleString('en-US')} / ${this.catalog.count.toLocaleString('en-US')}`,
      `draws ${culler.rangeCount}  nodes ${culler.nodesVisited}${this.renderer.multiDraw ? '  multi-draw' : ''}`,
    ].join('\n');
  }

  onShipEvent(ev) {
    if (ev.type === 'arrived') {
      haptic('success');
      const there = ev.target.kind === 'sol' ? [0, 0, 0] : this.catalog.position(ev.target.index);
      const d = formatDistance(v3.len(v3.sub(there, this.ship.pos)));
      if (ev.target.kind === 'sol') this.hud.toast(`Home. The Sun is ${d} ahead`, 4200);
      else this.hud.toast(`Arrived: ${ev.target.name} is ${d} ahead`, 3500);
      this.controls.speed.set(this.ship.throttle);
      this.settings.throttle = this.ship.throttle;
      this.saveSettings();
    }
  }

  // ---------------------------------------------------------------- commands (from input / controls)
  steer(source, x, y) { this.steerSources[source] = [x, y]; }
  rollRate(r) { this.rollRateInput = r; }
  roll(rad) {
    // twist gesture: the scene follows the fingers
    this.ship.q = quat.normalize(quat.mul(this.ship.q, quat.fromAxisAngle([0, 0, 1], -rad)));
    this.ship.lastManualRoll = this.ship.time;
  }
  boost(source, on) {
    const had = this.boostSources.size > 0;
    if (on) this.boostSources.add(source); else this.boostSources.delete(source);
    const has = this.boostSources.size > 0;
    this.ship.boostHeld = has;
    if (has && !had) {
      haptic('medium');
      if (this.ship.speed < throttleToSpeed(0.3)) this.hud.toast('Boost works best with some speed — slide the throttle up', 2200);
    }
  }
  throttle() { return this.ship.throttle; }
  setThrottle(v, source) {
    this.ship.throttle = clamp(v, 0, 1);
    if (this.ship.autopilot && source !== 'autopilot') this.ship.target.cruise = undefined;
    this.settings.throttle = this.ship.throttle;
    this.saveSettings();
    if (source !== 'slider') this.controls.speed.set(this.ship.throttle);
  }
  nudgeThrottle(d) { this.setThrottle(this.ship.throttle + d); this.wake(); }
  setDensity(v) { this.settings.density = clamp(v, 0, 1); this.saveSettings(); }
  nudgeDensity(d) { this.setDensity(this.settings.density + d); this.controls.density.set(this.settings.density); }
  setHaptics(on) { setHaptics(on); }
  saveSettings() { saveSettings(this.settings); }
  wake() { this.controls.wake(); }

  home() {
    this.selected = null;
    this.hud.closeCard();
    this.ship.goHome();
    if (this.ship.throttle < 0.25) this.setThrottle(0.5);
    const d = v3.len(this.ship.pos);
    this.hud.toast(d < 0.03 ? 'You are home' : `Autopilot: heading home to Sol, ${formatDistance(d)}`);
    haptic('select');
  }

  allStop() { this.ship.cancelTarget(); this.setThrottle(0); this.hud.toast('All stop'); }

  flyTo(index) {
    if (index < 0) return;
    const name = this.starInfo(index).name;
    const M = this.catalog.absMag(index);
    // Park where the star shines like a bright planet (mag -7), within sensible limits.
    const stop = clamp(10 ** ((-7 - M + 5) / 5), 0.0005, 0.3);
    this.ship.setTarget({ kind: 'star', index, name, stop }, true);
    if (this.ship.throttle < 0.25) this.setThrottle(0.5);
    this.hud.toast(`Autopilot: ${name}`);
  }

  jumpRandom() {
    const far = this.names.filter((n) => {
      const d = v3.len(this.catalog.position(n.index)) * PC_TO_LY;
      return d > 60 && d < 2500;
    });
    const pick = far[Math.floor(Math.random() * far.length)];
    const p = this.catalog.position(pick.index);
    // Arrive near the star, facing a random direction away from it; Sol is "somewhere".
    let dir = v3.norm([Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5]);
    const M = this.catalog.absMag(pick.index);
    const off = clamp(10 ** ((-5 - M + 5) / 5), 0.002, 0.5);
    this.ship.pos = v3.add(p, v3.scale(dir, off));
    dir = v3.norm(v3.add(dir, v3.scale(v3.norm(v3.sub([0, 0, 0], p)), 0.15)));
    this.ship.lookAlong(dir);
    this.ship.cancelTarget();
    this.ship.speed = 0;
    if (this.ship.throttle < 0.2) this.setThrottle(0.45);
    this.selected = null;
    this.hud.toast(`Jumped to ${pick.name}, ${formatDistance(v3.len(p))} from Sol. Follow the SOL marker home.`, 5000);
    haptic('heavy');
  }

  toggleMenu(force) { return this.controls.toggleMenu(force); }
  toggleCinema(force) {
    const hud = document.getElementById('hud');
    const on = hud.classList.toggle('cinema', force);
    if (on) this.hud.toast('Controls hidden — tap the top-right corner or press C to show them', 2500);
  }
  toggleLabels() {
    this.settings.labels = !this.settings.labels;
    this.hud.setLabels(this.settings.labels);
    this.controls.syncCheckboxes();
    this.saveSettings();
  }

  back() {
    if (!this.controls.sheet.hidden) { this.toggleMenu(false); return true; }
    if (this.hud.cardStar >= 0) { this.hud.closeCard(); return true; }
    if (document.getElementById('hud').classList.contains('cinema')) { this.toggleCinema(false); return true; }
    return false;
  }

  // ---------------------------------------------------------------- tapping stars
  starInfo(index) {
    const named = this.nameOf.get(index);
    const M = this.catalog.absMag(index);
    const kind = describeStar(this.catalog.bv(index), M);
    if (named) {
      const sub = [named.designation, named.spectrum].filter(Boolean).join(' · ');
      return { name: named.name, subtitle: sub ? `${sub} · ${kind}` : kind, note: named.note };
    }
    const k = kind[0].toUpperCase() + kind.slice(1);
    return { name: k, subtitle: 'No proper name · 3D position from Gaia / Hipparcos' };
  }

  /** The brightest star drawn within `radius` CSS pixels of (x, y), or -1. */
  pick(x, y, radius = 34) {
    const cat = this.catalog, p = this.proj;
    const magLimit = this.lastFrame?.magLimit ?? 7;
    const tex = cat.tex;
    const v = [0, 0, 0];
    let best = -1, bestScore = Infinity;
    const { starts, counts, n } = this.ranges;
    for (let r = 0; r < n; r++) {
      for (let i = starts[r], end = starts[r] + counts[r]; i < end; i++) {
        v[0] = tex[i * 4]; v[1] = tex[i * 4 + 1]; v[2] = tex[i * 4 + 2];
        p.toView(v, v);
        if (v[2] >= 0) continue;
        const d = Math.hypot(v[0], v[1], v[2]);
        const m = apparentMag(cat.absMag(i), d);
        if (m > magLimit - 0.3) continue;
        const [sx, sy] = p.toScreen(v);
        const px = Math.hypot(sx - x, sy - y);
        if (px > radius) continue;
        const score = m + px / 12;  // prefer bright, then close to the finger
        if (score < bestScore) { bestScore = score; best = i; }
      }
    }
    return best;
  }

  tap(x, y) {
    this.wake();
    // Tapping the Sol marker is handled by its own button; anything else selects a star or a direction.
    const star = this.pick(x, y);
    if (star >= 0 && star !== this.solIndex) {
      const info = this.starInfo(star);
      this.selected = { kind: 'star', index: star, name: info.name };
      this.ship.setTarget({ kind: 'star', index: star, name: info.name }, false);
      this.hud.openCard(star);
      haptic('select');
    } else if (star === this.solIndex && star >= 0) {
      this.home();
    } else {
      this.selected = null;
      this.hud.closeCard();
      this.ship.setTarget({ kind: 'dir', dir: this.proj.ray(x, y) }, false);
    }
  }
}
