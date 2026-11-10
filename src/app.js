// App controller: loads the data, owns the ship, and runs the frame loop
// (time -> simulate -> cull -> render -> HUD) once per display refresh.
//
// Targets are { kind: 'star', index } or { kind: 'body', id } everywhere: selecting,
// flying, searching and favourites all share them.
import { parseCatalog, parseNames } from './catalog.js';
import { fetchWithProgress } from './load.js';
import { Renderer } from './render/renderer.js';
import { Culler, frustumPlanes } from './culling.js';
import { Ship, throttleToSpeed } from './flight.js';
import { quat, v3, transpose3, radec, clamp, apparentMag, formatDistance, PC_TO_LY, GALACTIC_NORTH } from './math.js';
import { Hud, Projector, describeStar } from './hud.js';
import { Input } from './input.js';
import { Controls } from './controls.js';
import { PerfGovernor } from './perf.js';
import { loadSettings, saveSettings, densityToMag, TIME_RATES } from './settings.js';
import { haptic, setHaptics, onBackButton, onPauseResume } from './platform.js';
import { Constellations, LINE_ALPHA, solFade } from './constellations.js';
import { SearchIndex } from './search.js';
import { Favourites, FAVOURITES_LIMIT } from './favourites.js';
import { SolarSystem, solarIntensity, solarSpeedCap, parkingSide, ECLIPTIC_NORTH, AU_PER_PC } from './solar/system.js';
import { SolarView } from './solar/view.js';
import { describeBody } from './solar/bodies.js';
import { julianDay } from './solar/astro.js';

const BASE = import.meta.env?.BASE_URL ?? './';
const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
const SKY_FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
const DPR_CAP = 2;
const START_HEADING = radec(83.8, -1.2);   // Orion's belt
const START_OFFSET = 0.065;                // pc (~0.21 ly): just outside the Solar System, outbound
const APPROACH_TIME = 7;                   // s: near planets, the default throttle covers the distance to the nearest body in ~7 s
const DEFAULT_THROTTLE = 0.68;
// The Solar System clock runs between AD 1000 and 3000, where the planetary elements hold.
const CLOCK_MIN = julianDay(Date.UTC(1000, 0, 1));
const CLOCK_MAX = julianDay(Date.UTC(3000, 0, 1));

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}
const json = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); });

export class App {
  constructor(canvas) {
    this.canvas = canvas;
    this.settings = loadSettings();
    setHaptics(this.settings.haptics);
    this.ship = new Ship();
    this.ship.level = this.settings.level;
    this.ship.throttle = this.settings.throttle;
    this.perf = new PerfGovernor();
    // ?fixed pins quality (automated screenshots on software GL); ?stats shows the overlay;
    // ?stardraw=multi|loop|base forces a star draw path (see the draw paths in renderer.js).
    const q = new URLSearchParams(location.search);
    this.perf.locked = q.has('fixed');
    if (q.has('stats')) this.settings.stats = true;
    this.starDrawOverride = q.get('stardraw');
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
    this.solarS = 0;
    this.timeOffsetDays = 0;    // simulated minus real time
    this.timeRate = 1;          // simulated seconds per second
  }

  async init(progress = () => {}) {
    let starP = 0, skyN = 0;
    const report = () => progress(0.75 * starP + 0.25 * (skyN / SKY_FACES.length));
    const starsP = fetchWithProgress(`${BASE}data/stars.bin`, (p) => { starP = p; report(); });
    const skyP = Promise.all(SKY_FACES.map((f) => loadImage(`${BASE}sky/${f}.jpg`).then((img) => { skyN++; report(); return [f, img]; })))
      .then((list) => Object.fromEntries(list))
      .catch((err) => { console.warn('Milky Way unavailable', err); return null; });
    const [buf, names, searchData, figures, sky] = await Promise.all([
      starsP, json(`${BASE}data/names.json`), json(`${BASE}data/search.json`), json(`${BASE}data/constellations.json`), skyP,
    ]);
    this.catalog = parseCatalog(buf);
    this.names = parseNames(names);
    this.nameOf = new Map(this.names.map((n) => [n.index, n]));
    this.solIndex = this.names.find((n) => n.name === 'Sol')?.index ?? -1;
    this.constellations = new Constellations(figures, this.catalog);
    this.solar = new SolarSystem();
    this.solar.update(this.simJD);
    this.solarView = new SolarView(this.solar);
    this.search = new SearchIndex(searchData, this.catalog, this.solar.bodies);
    this.favourites = new Favourites(this.catalog);
    this.renderer = new Renderer(this.canvas, this.catalog, sky, this.constellations.pairs,
      { starDraw: this.starDrawOverride || this.settings.starDraw });
    this.culler = new Culler(this.catalog);

    this.hud = new Hud(this);
    this.hud.setLabels(this.settings.labels);
    this.hud.setConNames(this.settings.conNames);
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

  // ---------------------------------------------------------------- time
  get simJD() { return julianDay(Date.now()) + this.timeOffsetDays; }
  /** Advances the Solar System clock by `dt` real seconds at the current rate. */
  tickClock(dt) {
    if (this.timeRate !== 1) this.timeOffsetDays += dt * (this.timeRate - 1) / 86400;
    const jd = this.simJD;
    if (jd > CLOCK_MAX || jd < CLOCK_MIN) {
      this.timeOffsetDays += (jd > CLOCK_MAX ? CLOCK_MAX : CLOCK_MIN) - jd;
      if (this.timeRate !== 0) {
        this.setTimeRate(0, false);
        this.hud.toast(`The clock stops at AD ${jd > CLOCK_MAX ? 3000 : 1000}, the limit of the planetary orbits used`, 4000);
      }
    }
  }
  /** Clock speed for this session (every launch starts at real time, now). */
  setTimeRate(rate, announce = true) {
    this.timeRate = rate;
    if (announce) {
      const label = TIME_RATES.find((r) => r[1] === rate)?.[0] ?? `${rate}x`;
      this.hud.toast(rate === 0 ? 'Time paused' : `Time: ${label}`);
    }
  }
  timeNow() { this.timeOffsetDays = 0; this.setTimeRate(1, false); this.hud.toast('Clock: now, in real time'); }

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

    // Simulated time and the Solar System. Inside a body's neighbourhood the ship moves with
    // it, and the autopilot matches the motion of the body it is flying to.
    this.tickClock(dt);
    const solar = this.solar;
    const dSun = v3.len(ship.pos);
    this.solarS = solarIntensity(dSun);
    const chasing = ship.autopilot && ship.target?.kind === 'body' ? solar.get(ship.target.id) : null;
    const frameBody = chasing || (this.solarS > 0 ? solar.frameBody(v3.scale(ship.pos, AU_PER_PC)) : null);
    solar.update(this.simJD);
    if (frameBody) {
      const b = frameBody;
      for (let k = 0; k < 3; k++) ship.pos[k] += (b.pos[k] - b.prev[k]) / AU_PER_PC;
    }
    this.frameBody = frameBody;

    // Near planets the throttle covers the distance to the nearest surface in ~7 s, and the
    // view levels to the ecliptic instead of the galactic plane.
    const sS = this.solarS;
    let dEff = dSun;
    if (sS > 0) {
      const near = solar.nearest(v3.scale(ship.pos, AU_PER_PC));
      dEff = Math.max(near.dist, near.body.Req * 0.5) / AU_PER_PC;
      const local = dEff / (APPROACH_TIME * throttleToSpeed(DEFAULT_THROTTLE));
      ship.speedScale = Math.exp(sS * Math.log(Math.min(1, local)));
      this.nearestBody = near;
    } else {
      ship.speedScale = 1;
      this.nearestBody = null;
    }
    // Heading into the Solar System the ship eases out of warp at its edge instead of
    // coasting through it in a frame or two.
    ship.speedCap = solarSpeedCap(ship.pos, ship.forward, dEff, ship.boostFactor);
    ship.levelUp = sS > 0 ? v3.norm(v3.add(v3.scale(GALACTIC_NORTH, 1 - sS), v3.scale(ECLIPTIC_NORTH, sS))) : GALACTIC_NORTH;

    // Inputs and flight.
    const st = this.steerSources;
    ship.steer[0] = clamp(st.touch[0] + st.key[0], -1, 1);
    ship.steer[1] = clamp(st.touch[1] + st.key[1], -1, 1);
    ship.rollInput = this.rollRateInput;
    ship.boostHeld = this.boostSources.size > 0;
    ship.update(dt, (i) => this.catalog.position(i));
    if (sS > 0) {
      const au = v3.scale(ship.pos, AU_PER_PC);
      if (solar.keepOutside(au)) ship.pos = v3.scale(au, 1 / AU_PER_PC);
    }
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
    // Streaks follow the direction of travel, which on autopilot is not always the view's.
    const dir = ship.heading;
    const back = ship.speed * tau;
    this.tail[0] = dir[0] * back; this.tail[1] = dir[1] * back; this.tail[2] = dir[2] * back;
    for (let k = 0; k < 3; k++) {
      this.camHi[k] = ship.pos[k];
      this.camLo[k] = ship.pos[k] - this.camHi[k];
    }
    // In the Solar System the starfield steps back to roughly naked-eye depth so planets read.
    const userMag = Math.min(densityToMag(s.density), this.perf.magCap);
    const magLimit = sS > 0 ? userMag + (Math.min(userMag, 6.2) - userMag) * 0.75 * sS : userMag;

    // Cull.
    const omega = Math.hypot(ship.omega[0], ship.omega[1], ship.omega[2]);
    const planeCount = frustumPlanes(this.view, tanX, tanY, omega * tau + 0.04, this.planes);
    const culler = this.culler;
    const n = culler.collect(ship.pos, this.planes, planeCount, dir, back * 1.05 + 1e-6, magLimit);
    this.ranges.starts = culler.starts; this.ranges.counts = culler.counts; this.ranges.n = n;

    // Solar System frame.
    const px = Math.max(1, this.dpr * 0.78);
    let solarFrame = null;
    if (sS > 0.001) {
      solarFrame = this.solarView.build({
        camAU: v3.scale(ship.pos, AU_PER_PC), view: this.view, camToWorld: this.camToWorld, tanX, tanY, w, h,
        dpr: this.dpr, px, magLimit, gain: s.gain, s: sS, orbits: s.orbits,
        selected: this.selected?.kind === 'body' ? this.selected.id : null,
      });
    } else {
      this.solarView.screen = [];
    }

    // Render.
    const skyExposure = 0.85 * s.milkyWay ** 2 * 10 ** (0.2 * (magLimit - 7.5)) * (1 - 0.3 * sS);
    const linesOn = s.lines ? 1 : 0;
    this.lineFade = this.lineFade === undefined ? linesOn : this.lineFade + (linesOn - this.lineFade) * Math.min(1, dt * 4);
    this.renderer.render({
      camHi: this.camHi, camLo: this.camLo, view: this.view, viewPrev: this.viewPrev, camToWorld: this.camToWorld,
      tail: this.tail, tanX, tanY, magLimit, px, gain: s.gain, spread: 0.5 - 0.2 * ship.boost,
      skyExposure: Math.min(2.5, skyExposure), boost: ship.boost, vignette: 0.22,
      ranges: this.ranges, hideIndex: this.solIndex, hideScale: 1 - sS,
      lines: { alpha: LINE_ALPHA * solFade(dSun) * this.lineFade, magLimit },
      solar: solarFrame,
    });

    // HUD (CSS pixels).
    const p = this.proj;
    p.view.set(this.view);
    p.cam = ship.pos;
    p.tanX = tanX; p.tanY = tanY; p.w = this.cssW; p.h = this.cssH;
    const lf = this.lastFrame || (this.lastFrame = { proj: p, ship, catalog: this.catalog, names: this.names });
    lf.magLimit = magLimit;
    lf.now = now;
    lf.solarS = sS;
    lf.bodies = this.solarView.screen;
    this.hud.update(lf);
    if ((this.frameNo++ & 7) === 0) {
      this.controls.update();
      if (s.stats) this.updateStats(culler, magLimit, solarFrame);
    }
  }

  updateStats(culler, magLimit, solarFrame) {
    const el = document.getElementById('stats');
    const lines = [
      `${this.perf.fps.toFixed(0)} fps (${this.perf.refresh} Hz)  scale ${this.perf.scale.toFixed(2)}`,
      `${this.renderer.canvas.width}×${this.renderer.canvas.height}  mag ≤ ${magLimit.toFixed(2)}`,
      `stars submitted ${culler.starsSubmitted.toLocaleString('en-US')} / ${this.catalog.count.toLocaleString('en-US')}`,
      `draws ${culler.rangeCount}  nodes ${culler.nodesVisited}  ${this.renderer.starDraw.label}`,
    ];
    lines.push(`v${VERSION}  star check: ${this.renderer.starDraw.status}`);
    if (solarFrame) {
      lines.push(`solar ${(this.solarS * 100).toFixed(0)}%  bodies ${solarFrame.bodies.length}  orbits ${solarFrame.orbits.length}` +
        `${this.frameBody ? `  moving with ${this.frameBody.name}` : ''}`);
    }
    el.textContent = lines.join('\n');
  }

  onShipEvent(ev) {
    if (ev.type !== 'arrived') return;
    haptic('success');
    const t = ev.target;
    if (t.home) {
      this.hud.toast(`Home: the Solar System. The Sun is ${formatDistance(v3.len(this.ship.pos))} away`, 4500);
    } else {
      const d = formatDistance(v3.len(v3.sub(this.targetPosition(t), this.ship.pos)));
      this.hud.toast(`Arrived: ${t.name} is ${d} away`, 3500);
    }
    this.controls.speed.set(this.ship.throttle);
    this.settings.throttle = this.ship.throttle;
    this.saveSettings();
  }

  // ---------------------------------------------------------------- targets
  /** Position (pc) of a star or body target. */
  targetPosition(t) {
    return t.kind === 'body' ? this.solar.positionPc(t.id) : this.catalog.position(t.index);
  }

  /** Display name of a target. */
  targetName(t) {
    if (t.kind === 'body') return this.solar.get(t.id).name;
    return this.starInfo(t.index).name;
  }

  /** Autopilot parking distance (pc) for a target. */
  parkingDistance(t) {
    if (t.kind === 'body') { const b = this.solar.get(t.id); return b.park * b.Req / AU_PER_PC; }
    // Park where the star shines like a bright planet (mag -7), within sensible limits.
    return clamp(10 ** ((-7 - this.catalog.absMag(t.index) + 5) / 5), 0.0005, 0.3);
  }

  /** Select a target: turn towards it and show its card (the ship keeps its speed). */
  select(t, { card = true, turn = true } = {}) {
    const name = this.targetName(t);
    this.selected = { ...t, name };
    if (turn) this.ship.setTarget(this.shipTarget(t, false), false);
    if (card) this.hud.openCard(t);
    haptic('select');
  }

  shipTarget(t, autopilot) {
    const name = this.targetName(t);
    if (t.kind === 'body') {
      const locateBody = () => this.solar.positionPc(t.id);
      if (!autopilot) return { kind: 'body', id: t.id, name, locate: locateBody, stop: 0 };
      // Park beside the body (it moves, so the spot moves with it), looking at it all the way.
      const stop = this.parkingDistance(t);
      const d = this.parkingDirection(t.id);
      return {
        kind: 'body', id: t.id, name, stop: 0, arrive: stop * 0.01, locateFace: locateBody,
        locate: () => { const p = locateBody(); return [p[0] + d[0] * stop, p[1] + d[1] * stop, p[2] + d[2] * stop]; },
      };
    }
    return { kind: 'star', index: t.index, name, stop: autopilot ? this.parkingDistance(t) : 0 };
  }

  /** Which side of a body to park on (see parkingSide). */
  parkingDirection(id) {
    if (id === 'sun') return v3.norm(v3.sub(v3.scale(this.ship.pos, AU_PER_PC), this.solar.get('sun').pos));
    return parkingSide(this.solar.get(id).pos, v3.scale(this.ship.pos, AU_PER_PC));
  }

  /** Fly to a target with the autopilot, or just face it if we are already there. */
  flyToTarget(t) {
    const name = this.targetName(t);
    this.selected = { ...t, name };
    const stop = this.parkingDistance(t);
    const dist = v3.len(v3.sub(this.targetPosition(t), this.ship.pos));
    if (dist < stop * 1.5) {
      this.ship.setTarget(this.shipTarget(t, false), false);
      this.hud.toast(`You are already at ${name} (${formatDistance(dist)})`);
      return;
    }
    this.ship.setTarget(this.shipTarget(t, true), true);
    if (this.ship.throttle < 0.25) this.setThrottle(0.5);
    this.hud.toast(`Autopilot: ${name}, ${formatDistance(dist)}`);
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
      if (this.ship.throttle < 0.3) this.hud.toast('Boost works best with some speed — slide the throttle up', 2200);
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
    this.hud.closeCard();
    const au = v3.scale(this.ship.pos, AU_PER_PC);
    const park = this.solar.homeParking(au);
    const parkPc = v3.scale(park, 1 / AU_PER_PC);
    this.selected = null; // the SOL marker already marks the Sun
    if (v3.len(v3.sub(au, park)) < 0.5) {
      this.ship.setTarget({ kind: 'dir', dir: v3.norm(v3.scale(this.ship.pos, -1)) });
      this.hud.toast('You are home: the Solar System');
      return;
    }
    this.ship.goHome(parkPc);
    if (this.ship.throttle < 0.25) this.setThrottle(0.5);
    this.hud.toast(`Autopilot: heading home to Sol, ${formatDistance(v3.len(this.ship.pos))}`);
    haptic('select');
  }

  allStop() { this.ship.cancelTarget(); this.setThrottle(0); this.hud.toast('All stop'); }

  /** Kept for the info card's "Fly here" on stars. */
  flyTo(index) { this.flyToTarget({ kind: 'star', index }); }

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
    this.ship.lookAlong(dir, GALACTIC_NORTH);
    this.ship.cancelTarget();
    this.ship.speed = 0;
    if (this.ship.throttle < 0.2) this.setThrottle(0.45);
    this.selected = null;
    this.hud.toast(`Jumped to ${pick.name}, ${formatDistance(v3.len(p))} from Sol. Follow the SOL marker home.`, 5000);
    haptic('heavy');
  }

  /** Tapping the performance overlay steps through the star draw paths (diagnostics). */
  cycleStarDraw() {
    const order = ['auto', 'base', 'loop', ...(this.renderer.multiDraw ? ['multi'] : [])];
    const next = order[(order.indexOf(this.settings.starDraw) + 1) % order.length];
    this.settings.starDraw = next;
    this.saveSettings();
    this.renderer.setStarDraw(next);
    this.hud.toast(`Star draw path: ${next === 'auto' ? 'automatic' : this.renderer.starDraw.label}`, 2000);
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
  toggleLines() {
    this.settings.lines = !this.settings.lines;
    this.controls.syncCheckboxes();
    this.saveSettings();
    this.hud.toast(this.settings.lines ? 'Constellation lines on' : 'Constellation lines off', 1500);
  }
  toggleConNames() {
    this.settings.conNames = !this.settings.conNames;
    this.hud.setConNames(this.settings.conNames);
    this.controls.syncCheckboxes();
    this.saveSettings();
    this.hud.toast(this.settings.conNames ? 'Constellation names on' : 'Constellation names off', 1500);
  }
  openSearch() { this.controls.openSearch(); }
  openFavourites() { this.controls.openFavourites(); }

  toggleFavourite(t) {
    const name = this.targetName(t);
    const added = this.favourites.toggle(t, name);
    if (added === null) this.hud.toast(`Favourites are full (${FAVOURITES_LIMIT}). Remove one to add another.`, 3500);
    else this.hud.toast(added ? `★ ${name} saved to favourites` : `${name} removed from favourites`, 2200);
    this.hud.syncFav();
    haptic('select');
  }

  back() {
    if (this.controls.closeTopPanel()) return true;
    if (this.hud.cardTarget) { this.hud.closeCard(); return true; }
    if (document.getElementById('hud').classList.contains('cinema')) { this.toggleCinema(false); return true; }
    return false;
  }

  // ---------------------------------------------------------------- stars and bodies
  starInfo(index) {
    const named = this.nameOf.get(index);
    const M = this.catalog.absMag(index);
    const kind = describeStar(this.catalog.bv(index), M);
    if (named) {
      const sub = [named.designation, named.spectrum].filter(Boolean).join(' · ');
      return { name: named.name, subtitle: sub ? `${sub} · ${kind}` : kind, note: named.note };
    }
    const entry = this.search?.lookup({ kind: 'star', index });
    if (entry) return { name: entry.display, subtitle: [entry.detail, kind].filter(Boolean).join(' · ') };
    const k = kind[0].toUpperCase() + kind.slice(1);
    return { name: k, subtitle: 'No proper name · 3D position from Gaia / Hipparcos' };
  }

  bodyInfo(id) {
    const b = this.solar.get(id);
    return { name: b.name, subtitle: describeBody(b), body: b };
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
        if (i === this.solIndex && this.solarS > 0.5) continue;
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
    // A tap on the sky closes an open panel first.
    if (this.controls.search.close() || this.controls.favs.close()) return;
    // Bodies of the Solar System first, then stars, then just a direction.
    const body = this.solarS > 0.05 ? this.solarView.pick(x, y) : null;
    if (body) { this.select({ kind: 'body', id: body.id }); return; }
    const star = this.pick(x, y);
    if (star >= 0 && star === this.solIndex) { this.select({ kind: 'body', id: 'sun' }); return; }
    if (star >= 0) { this.select({ kind: 'star', index: star }); return; }
    this.selected = null;
    this.hud.closeCard();
    this.ship.setTarget({ kind: 'dir', dir: this.proj.ray(x, y) }, false);
  }
}
