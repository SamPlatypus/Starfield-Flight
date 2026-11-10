#!/usr/bin/env node
// End-to-end test of the production build in headless Chromium (Playwright, software GL).
//   npm run build && node test/e2e/smoke.mjs [--shots dir] [--only 'part of a check's name']
// Checks rendering, the star draw paths (and a GPU that ignores draw offsets), touch steering,
// pinch-to-throttle, tapping stars, the Sol marker and autopilot, boost, sliders, the menu and
// install UI, search, favourites, constellations, the Solar System (planets, units, warp
// limiter, planet autopilot, clock), WebGL context loss and offline start.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const shotsArg = process.argv.indexOf('--shots');
const shots = shotsArg > 0 ? process.argv[shotsArg + 1] : null;
const onlyArg = process.argv.indexOf('--only');
const only = onlyArg > 0 ? process.argv[onlyArg + 1] : null; // run just the checks whose name contains this
if (shots) await mkdir(shots, { recursive: true });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json', '.bin': 'application/octet-stream' };
const server = createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(dist, path));
  if (!file.startsWith(dist)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
// "localhost" is a secure context, so the service worker registers.
const base = `http://localhost:${server.address().port}/`;

const GL_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const results = [];
async function check(name, fn) {
  if (only && !name.includes(only)) return;
  try { await fn(); results.push(['ok', name]); console.log(`ok - ${name}`); }
  catch (err) { results.push(['FAIL', name]); console.log(`not ok - ${name}\n  ${String(err.stack || err).split('\n').slice(0, 5).join('\n  ')}`); }
}

async function newPage(browser, { query = '?fixed', settings = { hintSeen: true }, viewport = { width: 412, height: 860 }, init = null } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: true, hasTouch: true, serviceWorkers: 'allow' });
  await ctx.addInitScript((s) => {
    if (!localStorage.getItem('starfield-flight.settings.v1')) localStorage.setItem('starfield-flight.settings.v1', JSON.stringify(s));
  }, settings);
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push(m.text()); });
  await page.goto(base + query);
  await page.waitForFunction(() => window.starfield && window.starfield.running && window.starfield.lastFrame, null, { timeout: 30000 });
  return { ctx, page };
}
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
const app = (page, fn, arg) => page.evaluate(fn, arg);

/** Luminance statistics of the WebGL canvas, read right after a frame is drawn. */
const canvasStats = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => {
  const src = document.getElementById('sky');
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let sum = 0, bright = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    sum += l;
    if (l > 140) bright++;
  }
  resolve({ mean: sum / (d.length / 4), bright });
})));

/** Mean luminance of the WebGL canvas in a coarse grid, read right after a frame is drawn. */
const canvasGrid = (page, nx = 12, ny = 24) => page.evaluate(([nx, ny]) => new Promise((resolve) => requestAnimationFrame(() => {
  const src = document.getElementById('sky');
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const sum = new Float64Array(nx * ny), n = new Float64Array(nx * ny);
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4, k = Math.floor(y * ny / c.height) * nx + Math.floor(x * nx / c.width);
      sum[k] += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      n[k]++;
    }
  }
  resolve(Array.from(sum, (v, k) => v / n[k]));
})), [nx, ny]);
const gridDiff = (a, b) => a.reduce((m, v, k) => Math.max(m, Math.abs(v - b[k])), 0);

/** Parks the ship outside the Solar System facing Orion: a still, time-independent sky. */
const stillSky = async (page) => {
  await app(page, () => {
    const a = window.starfield, D = Math.PI / 180;
    const f = [Math.cos(-1.2 * D) * Math.cos(83.8 * D), Math.cos(-1.2 * D) * Math.sin(83.8 * D), Math.sin(-1.2 * D)];
    a.ship.cancelTarget(); a.setThrottle(0); a.ship.speed = 0;
    a.ship.pos = f.map((x) => x * 0.3);
    a.ship.lookAlong(f);
  });
  await page.waitForTimeout(500);
  return { grid: await canvasGrid(page), draw: await app(page, () => ({ ...window.starfield.renderer.starDraw, hasMulti: !!window.starfield.renderer.multiDraw })) };
};

/** Emulates a GPU driver that numbers every draw's vertices from 0, ignoring the draw's offset. */
const IGNORE_DRAW_OFFSETS = () => {
  const P = WebGL2RenderingContext.prototype;
  const drawArrays = P.drawArrays;
  P.drawArrays = function (mode, first, count) { return drawArrays.call(this, mode, 0, count); };
  const getExtension = P.getExtension;
  P.getExtension = function (name) {
    const ext = getExtension.call(this, name);
    if (name !== 'WEBGL_multi_draw' || !ext || ext.patched) return ext;
    const real = ext.multiDrawArraysWEBGL.bind(ext);
    ext.multiDrawArraysWEBGL = (mode, firsts, fo, counts, co, n) => real(mode, new Int32Array(firsts.length), fo, counts, co, n);
    ext.patched = true;
    return ext;
  };
};

async function touchDrag(page, from, to, steps = 12, holdMs = 400) {
  const cdp = await page.context().newCDPSession(page);
  const pt = (x, y) => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(...from) });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t) });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(holdMs);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

async function pinch(page, centre, d0, d1) {
  const cdp = await page.context().newCDPSession(page);
  const pts = (d) => [{ x: centre[0] - d / 2, y: centre[1], id: 1 }, { x: centre[0] + d / 2, y: centre[1], id: 2 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(d0) });
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(d0 + (d1 - d0) * i / 10) });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

const browser = await chromium.launch({ args: GL_ARGS });

await check('boots without errors and renders a starfield with the Milky Way', async () => {
  const { ctx, page } = await newPage(browser);
  await page.waitForTimeout(1200);
  const s = await canvasStats(page);
  const st = await app(page, () => ({ sub: window.starfield.culler.starsSubmitted, count: window.starfield.catalog.count, ranges: window.starfield.culler.rangeCount }));
  assert.ok(st.count > 600000, `catalogue has ${st.count} stars`);
  assert.ok(st.sub > 1000 && st.sub < st.count, `submitted ${st.sub} stars in ${st.ranges} ranges`);
  assert.ok(s.mean > 2 && s.mean < 90, `canvas mean luminance ${s.mean.toFixed(1)}`);
  assert.ok(s.bright > 30, `${s.bright} bright pixels (stars)`);
  assert.equal(await page.locator('#loading.done').count(), 1, 'loading screen dismissed');
  await shot(page, 'boot');
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

await check('star draw paths: the fast path is verified against the safe one, and all three draw the same sky', async () => {
  const sky = {};
  for (const mode of ['auto', 'multi', 'loop', 'base']) {
    const { ctx, page } = await newPage(browser, { query: mode === 'auto' ? '?fixed' : `?fixed&stardraw=${mode}` });
    // Automatic: flying, the fast path is compared with the safe one three times over ~10 s.
    if (mode === 'auto') await page.waitForFunction(() => window.starfield.renderer.starDraw.done, null, { timeout: 30000 });
    sky[mode] = await stillSky(page);
    assert.deepEqual(page.errors, []);
    await ctx.close();
  }
  const auto = sky.auto.draw, fast = auto.hasMulti ? 'multi' : 'loop';
  assert.equal(auto.fault, false, 'no draw-offset fault on this GPU');
  assert.equal(auto.mode, fast, `the fast path took over: ${auto.mode}`);
  assert.deepEqual(auto.tests[fast], { ok: 3, bad: false, diff: 0 }, 'it matched the safe path in all three comparisons');
  for (const mode of ['multi', 'loop', 'base']) {
    if (mode === 'multi' && !auto.hasMulti) continue;
    assert.ok(sky[mode].draw.mode === mode && sky[mode].draw.forced, `?stardraw=${mode} forces the ${mode} path`);
    const d = gridDiff(sky.auto.grid, sky[mode].grid);
    assert.ok(d < 0.5, `the ${mode} path draws the same sky (max block difference ${d.toFixed(2)})`);
  }
});

await check('a GPU that ignores draw offsets still shows the right stars, and says so', async () => {
  const healthy = await newPage(browser);
  const want = await stillSky(healthy.page);
  await healthy.ctx.close();

  const fixed = await newPage(browser, { query: '?fixed&stats', init: IGNORE_DRAW_OFFSETS });
  const got = await stillSky(fixed.page);
  assert.equal(got.draw.mode, 'base', 'stays on the path that never uses a draw offset');
  assert.equal(got.draw.fault, true, 'fault reported');
  for (const path of got.draw.candidates) assert.equal(got.draw.tests[path]?.bad, true, `${path} seen to draw the wrong stars`);
  const d = gridDiff(want.grid, got.grid);
  assert.ok(d < 0.5, `same sky as a healthy GPU (max block difference ${d.toFixed(2)})`);
  await fixed.page.waitForTimeout(250);
  assert.match(await fixed.page.locator('#stats').textContent(), /base-uniform\s+v\S+ {2}star check: (multi WRONG, )?loop WRONG/);
  await shot(fixed.page, 'draw-offset-fault-fixed');
  await fixed.ctx.close();

  // Forced onto the fast path, the same GPU stacks the catalogue's first stars into bright squares.
  const broken = await newPage(browser, { query: `?fixed&stardraw=${got.draw.hasMulti ? 'multi' : 'loop'}`, init: IGNORE_DRAW_OFFSETS });
  const bad = await stillSky(broken.page);
  assert.ok(gridDiff(want.grid, bad.grid) > 5, `the emulated fault is visible on the fast path (${gridDiff(want.grid, bad.grid).toFixed(1)})`);
  await shot(broken.page, 'draw-offset-fault-unfixed');
  await broken.ctx.close();
});

await check('tapping the performance overlay steps through the star draw paths and remembers the choice', async () => {
  const { ctx, page } = await newPage(browser, { query: '?fixed&stats' });
  const state = () => app(page, () => ({ setting: window.starfield.settings.starDraw, mode: window.starfield.renderer.starDraw.mode, forced: window.starfield.renderer.starDraw.forced }));
  await page.waitForFunction(() => window.starfield.renderer.starDraw.tests.multi || window.starfield.renderer.starDraw.tests.loop);
  assert.equal((await state()).setting, 'auto');
  await page.click('#stats');
  assert.deepEqual(await state(), { setting: 'base', mode: 'base', forced: true });
  await page.waitForFunction(() => /base-uniform \(forced\)/.test(document.getElementById('stats').textContent));
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('starfield-flight.settings.v1')).starDraw === 'base', null, { timeout: 5000 });
  await page.reload();
  await page.waitForFunction(() => window.starfield && window.starfield.running && window.starfield.lastFrame, null, { timeout: 30000 });
  assert.deepEqual(await state(), { setting: 'base', mode: 'base', forced: true }, 'kept across a restart');
  await page.click('#stats');
  assert.deepEqual(await state(), { setting: 'loop', mode: 'loop', forced: true });
  const hasMulti = await app(page, () => !!window.starfield.renderer.multiDraw);
  if (hasMulti) { await page.click('#stats'); assert.deepEqual(await state(), { setting: 'multi', mode: 'multi', forced: true }); }
  await page.click('#stats');
  assert.equal((await state()).setting, 'auto');
  assert.equal((await state()).forced, false);
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

await check('the Sol marker points home, on screen and from behind', async () => {
  const { ctx, page } = await newPage(browser);
  // At start the Sun is behind us: the marker sits on the screen edge as an arrow.
  await page.waitForTimeout(300);
  let m = await app(page, () => ({ on: document.querySelector('#sol').classList.contains('on'), edge: document.querySelector('#sol').classList.contains('edge'), text: document.querySelector('#sol .dist').textContent }));
  assert.ok(m.on && m.edge, 'edge arrow while Sol is behind');
  assert.match(m.text, /AU|ly/);
  // Turn around: the Sun is now in view and the marker becomes a reticle around it.
  await app(page, () => { const a = window.starfield; a.ship.lookAlong(a.ship.pos.map((x) => -x)); a.setThrottle(0); });
  await page.waitForTimeout(400);
  m = await app(page, () => {
    const el = document.querySelector('#sol');
    const r = el.getBoundingClientRect();
    return { edge: el.classList.contains('edge'), x: r.left + r.width / 2, y: r.top + r.height / 2, w: innerWidth, h: innerHeight };
  });
  assert.ok(!m.edge, 'reticle when Sol is ahead');
  assert.ok(Math.abs(m.x - m.w / 2) < 3 && Math.abs(m.y - m.h / 2) < 3, `reticle at the centre (${m.x}, ${m.y})`);
  await shot(page, 'sol-ahead');
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

await check('touch joystick steers; pinch changes speed; hold boosts', async () => {
  const { ctx, page } = await newPage(browser);
  const fwd0 = await app(page, () => window.starfield.ship.forward);
  await touchDrag(page, [206, 430], [306, 380], 10, 500);
  const fwd1 = await app(page, () => window.starfield.ship.forward);
  const turned = Math.acos(fwd0[0] * fwd1[0] + fwd0[1] * fwd1[1] + fwd0[2] * fwd1[2]);
  assert.ok(turned > 0.15, `joystick turned the ship by ${turned.toFixed(3)} rad`);
  assert.equal(await app(page, () => window.starfield.steerSources.touch.join()), '0,0', 'stick released');

  const t0 = await app(page, () => window.starfield.ship.throttle);
  await pinch(page, [206, 430], 80, 240);
  const t1 = await app(page, () => window.starfield.ship.throttle);
  assert.ok(t1 > t0 + 0.1, `pinch out raised throttle ${t0.toFixed(2)} -> ${t1.toFixed(2)}`);

  // Press and hold without moving: boost while held.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 300, id: 3 }] });
  await page.waitForTimeout(800);
  assert.equal(await app(page, () => window.starfield.ship.boostHeld), true, 'boosting while held');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(50);
  assert.equal(await app(page, () => window.starfield.ship.boostHeld), false, 'boost released');
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

await check('tapping a star selects it, shows facts and turns towards it', async () => {
  const { ctx, page } = await newPage(browser);
  await app(page, () => window.starfield.setThrottle(0));
  await page.waitForTimeout(600);
  // Find Betelgeuse on screen through the app's own projection.
  const pos = await app(page, () => {
    const a = window.starfield;
    const i = a.names.find((n) => n.name === 'Betelgeuse').index;
    const v = a.proj.toView(a.catalog.position(i));
    return { i, xy: a.proj.toScreen(v) };
  });
  await page.touchscreen.tap(pos.xy[0], pos.xy[1]);
  await page.waitForTimeout(200);
  const sel = await app(page, () => ({ sel: window.starfield.selected, card: !document.getElementById('card').hidden, title: document.querySelector('#card .title').textContent, facts: document.querySelector('#card .facts').textContent }));
  assert.equal(sel.sel?.index, pos.i, 'Betelgeuse selected');
  assert.ok(sel.card && sel.title === 'Betelgeuse', `card shows ${sel.title}`);
  assert.match(sel.facts, /From Sol[\s\S]*ly/);
  await shot(page, 'card');
  // Fly here engages the autopilot to that star.
  await page.click('#card .fly');
  assert.equal(await app(page, () => window.starfield.ship.autopilot && window.starfield.ship.target.kind), 'star');
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

const AU_PER_PC = 206264.80624709636;

/**
 * Watches an autopilot trip frame by frame in the page: how far the subject strays from the
 * middle of the view once the view is on it, and how far the view turns after the ship stops.
 */
const watchTrip = (page, subjectId) => app(page, (id) => {
  const a = window.starfield, AU = 206264.80624709636;
  const w = (window.trip = { offCentre: 0, turnAfter: 0, stopped: null, frames: 0, rollNear: 0, levelOnEntry: null,
    magStart: a.lastFrame.magLimit, magMax: a.lastFrame.magLimit, magRate: 0, magInNeighbourhood: null });
  const tgt = a.ship.target;
  let lastMag = a.lastFrame.magLimit, lastT = null;
  const tick = (ts) => { // ts: the frame's own timestamp, the clock the app steps by
    const s = a.ship, b = id ? a.solar.get(id).pos.map((x) => x / AU) : [0, 0, 0];
    const to = [b[0] - s.pos[0], b[1] - s.pos[1], b[2] - s.pos[2]], l = Math.hypot(...to), f = s.forward;
    const off = Math.acos(Math.min(1, (f[0] * to[0] + f[1] * to[1] + f[2] * to[2]) / l)) * 180 / Math.PI;
    if (s.autopilot && tgt.locked) { w.offCentre = Math.max(w.offCentre, off); w.frames++; }
    // the star limit: how fast it moves (mag/s) and where it stands once the Sun's neighbourhood is fully in
    const mag = a.lastFrame.magLimit;
    if (lastT !== null && ts > lastT) w.magRate = Math.max(w.magRate, Math.abs(mag - lastMag) / ((ts - lastT) / 1000));
    lastMag = mag; lastT = ts;
    w.magMax = Math.max(w.magMax, mag);
    if (w.magInNeighbourhood === null && a.transition.fade >= 1) w.magInNeighbourhood = mag;
    if (a.transition.near) {
      // roll of the view (deg/s) once the Sun's neighbourhood is around the ship
      w.rollNear = Math.max(w.rollNear, Math.abs(s.omega[2]) * 180 / Math.PI);
      if (w.levelOnEntry === null) w.levelOnEntry = a.transition.level;
    }
    if (!s.autopilot) {
      if (!w.stopped) w.stopped = f;
      w.turnAfter = Math.max(w.turnAfter, Math.acos(Math.min(1, f[0] * w.stopped[0] + f[1] * w.stopped[1] + f[2] * w.stopped[2])) * 180 / Math.PI);
    }
    if (!w.done) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}, subjectId);
const tripResult = (page) => app(page, () => { window.trip.done = true; return window.trip; });

await check('tapping the Sol marker flies home along the line of approach, the Sun centred all the way', async () => {
  const { ctx, page } = await newPage(browser);
  await app(page, () => { const a = window.starfield; a.ship.pos = [12, -30, 8]; a.ship.lookAlong([1, 0, 0]); a.setThrottle(0); });
  await page.waitForTimeout(600);
  const box = await page.locator('#sol').boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  assert.equal(await app(page, () => window.starfield.ship.autopilot && window.starfield.ship.target.home), true);
  await watchTrip(page, null);
  await page.waitForFunction(() => !window.starfield.ship.autopilot, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const trip = await tripResult(page);
  const r = await app(page, () => {
    const a = window.starfield, p = a.ship.pos, d = Math.hypot(...p), f = a.ship.forward;
    const n = [0, -Math.sin(23.4392911 * Math.PI / 180), Math.cos(23.4392911 * Math.PI / 180)];
    const from = [12, -30, 8], fl = Math.hypot(...from);
    return { d, elev: Math.asin((p[0] * n[0] + p[1] * n[1] + p[2] * n[2]) / d) * 180 / Math.PI, facing: -(f[0] * p[0] + f[1] * p[1] + f[2] * p[2]) / d, s: a.solarS,
      offLine: Math.acos(Math.min(1, (p[0] * from[0] + p[1] * from[1] + p[2] * from[2]) / (d * fl))) * 180 / Math.PI };
  });
  const au = r.d * AU_PER_PC;
  assert.ok(Math.abs(au - 6) < 0.15, `parked ${au.toFixed(2)} AU from the Sun`);
  // this approach comes in 35 degrees above the planets' plane: steep enough to park on its own line
  assert.ok(r.offLine < 0.5 && Math.abs(r.elev - 35.4) < 0.5, `${r.offLine.toFixed(2)} deg off the line of approach, elevation ${r.elev.toFixed(1)} deg`);
  assert.ok(r.facing > 0.9999, 'facing the Sun');
  assert.ok(trip.frames > 20 && trip.offCentre < 3, `the Sun stayed within ${trip.offCentre.toFixed(2)} deg of the centre`);
  assert.ok(trip.turnAfter < 0.5, `turned ${trip.turnAfter.toFixed(2)} deg after stopping`);
  // the view levelled to the planets' plane on the way, light-years out, not as it arrived
  assert.ok(trip.levelOnEntry > 0.99, `level ${trip.levelOnEntry.toFixed(2)} on reaching the Sun's neighbourhood`);
  assert.ok(trip.rollNear < 3, `the view rolled at up to ${trip.rollNear.toFixed(1)} deg/s inside it`);
  // the starfield keeps its full depth through the Sun's neighbourhood, then thins as the planets
  // resolve, a star at a time (default density: 7.5 in open space, 6.53 among the planets)
  const magEnd = await app(page, () => window.starfield.lastFrame.magLimit);
  assert.ok(Math.abs(trip.magStart - 7.5) < 1e-6 && trip.magMax <= trip.magStart + 1e-9, 'never deeper than the density setting');
  assert.ok(Math.abs(trip.magInNeighbourhood - 7.5) < 1e-6, `star limit ${trip.magInNeighbourhood.toFixed(2)} with the neighbourhood fully in`);
  assert.ok(Math.abs(magEnd - 6.525) < 1e-6, `star limit ${magEnd.toFixed(3)} among the planets`);
  assert.ok(trip.magRate > 0.05 && trip.magRate < 0.6, `it moved at up to ${trip.magRate.toFixed(2)} mag/s`);
  assert.equal(r.s, 1, 'in Solar System mode');
  assert.equal(await app(page, () => window.starfield.transition.state), 'system');
  assert.match(await page.locator('#toast').textContent(), /Home/);
  assert.match(await page.locator('#readout .sol-dist').textContent(), /AU/);
  assert.ok(await page.locator('#labels .label.body.on').count() >= 2, 'planets are labelled');
  await shot(page, 'home');
  // Asking again from here is a no-op.
  await app(page, () => window.starfield.home());
  assert.equal(await app(page, () => window.starfield.ship.autopilot), false, 'already home');
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

await check('flying home from the planets\' plane climbs to 25 degrees with the Sun still centred', async () => {
  const { ctx, page } = await newPage(browser);
  // 300 AU out, in the ecliptic, looking away
  await app(page, () => {
    const a = window.starfield, e = 23.4392911 * Math.PI / 180, AU = 206264.80624709636;
    a.ship.pos = [0, 300 * Math.cos(e) / AU, 300 * Math.sin(e) / AU];
    a.ship.lookAlong([1, 0, 0]);
    a.setThrottle(0);
  });
  await page.waitForTimeout(300);
  await app(page, () => window.starfield.home());
  await watchTrip(page, null);
  await page.waitForFunction(() => !window.starfield.ship.autopilot, null, { timeout: 60000 });
  await page.waitForTimeout(1000);
  const trip = await tripResult(page);
  const r = await app(page, () => {
    const p = window.starfield.ship.pos, d = Math.hypot(...p);
    const n = [0, -Math.sin(23.4392911 * Math.PI / 180), Math.cos(23.4392911 * Math.PI / 180)];
    return { au: d * 206264.80624709636, elev: Math.asin((p[0] * n[0] + p[1] * n[1] + p[2] * n[2]) / d) * 180 / Math.PI };
  });
  assert.ok(Math.abs(r.au - 6) < 0.15 && Math.abs(r.elev - 25) < 0.5, `parked ${r.au.toFixed(2)} AU out, ${r.elev.toFixed(1)} deg above the plane`);
  assert.ok(trip.frames > 20 && trip.offCentre < 3, `the Sun stayed within ${trip.offCentre.toFixed(2)} deg of the centre`);
  assert.ok(trip.turnAfter < 0.5, `turned ${trip.turnAfter.toFixed(2)} deg after stopping`);
  await shot(page, 'home-from-the-plane');
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

await check('search finds stars by name and designation, and planets; the card flies there', async () => {
  const { ctx, page } = await newPage(browser);
  await app(page, () => window.starfield.setThrottle(0));
  await page.click('#search-btn');
  assert.equal(await page.locator('#search').isVisible(), true);
  assert.equal(await app(page, () => document.activeElement === document.querySelector('#search input')), true, 'ready to type');
  assert.ok(await page.locator('#search .result').count() >= 5, 'suggestions before typing');
  await page.keyboard.type('alf CMa');
  await page.waitForFunction(() => document.querySelector('#search .result b')?.textContent === 'Sirius');
  await shot(page, 'search');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#search').isVisible(), false, 'panel closes');
  const sel = await app(page, () => ({ t: window.starfield.ship.target, title: document.querySelector('#card .title').textContent }));
  assert.equal(sel.title, 'Sirius');
  assert.equal(sel.t?.kind, 'star', 'turning towards it');
  await page.click('#card .fly');
  assert.equal(await app(page, () => window.starfield.ship.autopilot && window.starfield.ship.target.name), 'Sirius');
  // planets, typos
  for (const [q, want] of [['jupiter', 'Jupiter'], ['betelguese', 'Betelgeuse'], ['61 Cyg', '61 Cygni A']]) {
    await page.click('#search-btn');
    await page.waitForFunction(() => document.activeElement === document.querySelector('#search input'));
    await page.keyboard.type(q);
    await page.waitForFunction((w) => document.querySelector('#search .result b')?.textContent.startsWith(w.split(' ')[0]), want);
    const first = await page.locator('#search .result b').first().textContent();
    assert.ok(first === want || first.startsWith(want.split(' ')[0]), `"${q}" -> ${first}`);
    await page.keyboard.press('Escape');
  }
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

await check('favourites: save from the card, list with live distances, rename, fly, remove, persist', async () => {
  const { ctx, page } = await newPage(browser);
  await app(page, () => { const a = window.starfield; a.setThrottle(0); a.select(a.search.query('Vega', 1)[0].entry.target); });
  await page.click('#card .fav');
  assert.match(await page.locator('#card .fav').textContent(), /Saved/);
  await app(page, () => window.starfield.select({ kind: 'body', id: 'saturn' }));
  await page.click('#card .fav');
  await page.click('#menu-btn');
  await page.click('#sheet [data-action=favourites]');
  assert.equal(await page.locator('#favourites').isVisible(), true);
  assert.equal(await page.locator('#favourites .fav-row').count(), 2);
  await page.waitForFunction(() => /ly/.test(document.querySelector('#favourites .fav-row .dist')?.textContent || ''));
  assert.match(await page.locator('#favourites .count').textContent(), /2 \/ 100/);
  await shot(page, 'favourites');
  // rename Vega
  await page.locator('#favourites .fav-row').first().locator('.rename').click();
  await page.locator('#favourites .rename-input').fill('Harp star');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#favourites .fav-row b')?.textContent === 'Harp star');
  // persisted
  await page.reload();
  await page.waitForFunction(() => window.starfield?.running && window.starfield.lastFrame);
  const saved = await app(page, () => window.starfield.favourites.items.map((it) => it.name));
  assert.deepEqual(saved, ['Harp star', 'Saturn']);
  // one tap flies there
  await app(page, () => window.starfield.openFavourites());
  await page.locator('#favourites .fav-row .go').first().click();
  assert.equal(await page.locator('#favourites').isVisible(), false);
  assert.equal(await app(page, () => window.starfield.ship.autopilot && window.starfield.ship.target.name), 'Vega');
  // remove
  await app(page, () => window.starfield.openFavourites());
  await page.locator('#favourites .fav-row').last().locator('.remove').click();
  assert.equal(await page.locator('#favourites .fav-row').count(), 1);
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

await check('constellation lines draw subtly and toggle; names show when enabled', async () => {
  const { ctx, page } = await newPage(browser, { settings: { hintSeen: true, milkyWay: 0 } });
  // From near the Sun looking at Orion, standing still.
  await app(page, () => { const a = window.starfield; a.ship.pos = [0.0001, 0, 0]; a.ship.cancelTarget(); a.ship.speed = 0; a.setThrottle(0); a.ship.lookAlong([0.1, 0.99, -0.05]); });
  await page.waitForTimeout(1200);
  const on = await canvasStats(page);
  await page.click('#menu-btn');
  await page.click('#set-lines');
  await page.click('#set-connames');
  await page.click('#sheet .close');
  await page.waitForTimeout(1500);
  const off = await canvasStats(page);
  assert.ok(on.mean > off.mean * 1.01, `lines add light: ${on.mean.toFixed(2)} vs ${off.mean.toFixed(2)} without`);
  assert.ok(on.mean < off.mean * 1.6, 'but stay subtle');
  const names = await page.locator('#labels .label.con.on').allTextContents();
  assert.ok(names.length >= 3 && names.includes('Ori'), `constellation names: ${names.join(' ')}`);
  await shot(page, 'constellations');
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

await check('the Solar System: planets render with names, sizes and AU / km units; tap one for its card', async () => {
  const { ctx, page } = await newPage(browser);
  // 9 Saturn radii out on the sunward side, looking at Saturn
  await app(page, () => {
    const a = window.starfield, s = a.solar.get('saturn'), r = Math.hypot(...s.pos), R = 60268 / 149597870.7;
    const p = s.pos.map((x) => x * (1 - 9 * R / r));
    p[2] += 3 * R;
    a.ship.cancelTarget(); a.ship.speed = 0; a.setThrottle(0);
    a.ship.pos = p.map((x) => x / 206264.80624709636);
    a.ship.lookAlong([s.pos[0] - p[0], s.pos[1] - p[1], s.pos[2] - p[2]]);
  });
  await page.waitForTimeout(1200);
  const v = await app(page, () => {
    const a = window.starfield, sat = a.solarView.screen.find((x) => x.body.id === 'saturn');
    return { s: a.solarS, frame: a.frameBody?.id, r: sat.r, x: sat.x, y: sat.y, bodies: a.renderer.solar ? 1 : 0 };
  });
  assert.equal(v.s, 1);
  assert.equal(v.frame, 'saturn', 'moving with Saturn');
  assert.ok(v.r > 20 && v.r < 60, `Saturn's disc is ${v.r.toFixed(1)} px`);
  const s = await canvasStats(page);
  assert.ok(s.mean > 8, `a lit planet fills part of the view (mean ${s.mean.toFixed(1)})`);
  assert.match(await page.locator('#readout .sol-dist').textContent(), /AU/);
  assert.match(await page.locator('#readout .clock').textContent(), /\d{4}-\d\d-\d\d \d\d:\d\d UTC/);
  await app(page, () => window.starfield.setThrottle(0.6));
  await page.waitForTimeout(1500);
  assert.match(await page.locator('#readout .value').textContent(), /km\/s|AU\/s/, 'speed in km/s or AU/s near planets');
  await app(page, () => window.starfield.setThrottle(0));
  await page.touchscreen.tap(v.x, v.y);
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#card .title').textContent(), 'Saturn');
  assert.match(await page.locator('#card .facts').textContent(), /From you[\s\S]*km[\s\S]*Radius[\s\S]*58,232 km/);
  await shot(page, 'saturn');
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

await check('flying in by hand: out of warp at the edge, a gentle levelling, and the Solar System announced once', async () => {
  const { ctx, page } = await newPage(browser, { query: '?fixed&stats' });
  await app(page, () => {
    const a = window.starfield;
    // In along -y, passing 21 AU from the Sun: from this side the galactic and the planets'
    // planes sit 62 degrees apart in the view (along x they happen to line up).
    a.ship.cancelTarget(); a.ship.pos = [0.0001, 2, 0]; a.ship.lookAlong([0, -1, 0]); a.setThrottle(1); a.ship.speed = 60;
    // what happened on the way, frame by frame
    const w = (window.way = { roll: 0, changes: [], toasts: [] });
    const onTransition = a.onTransition.bind(a);
    a.onTransition = (ev) => { w.changes.push(`${ev.from}>${ev.to}`); onTransition(ev); };
    const toast = a.hud.toast.bind(a.hud);
    a.hud.toast = (text, ms) => { w.toasts.push(text); toast(text, ms); };
    const tick = () => { w.roll = Math.max(w.roll, Math.abs(a.ship.omega[2]) * 180 / Math.PI); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await page.waitForFunction(() => window.starfield.solarS > 0.99, null, { timeout: 20000 });
  const r = await app(page, () => { const a = window.starfield; return { y: a.ship.pos[1], d: Math.hypot(...a.ship.pos), v: a.ship.speed, state: a.transition.state }; });
  assert.ok(r.y > 0, 'still on the near side of the Sun');
  assert.ok(r.v < 0.05, `slowed to ${r.v.toFixed(4)} pc/s`);
  assert.equal(r.state, 'approach');
  assert.match(await page.locator('#readout .clock').textContent(), /UTC/, 'the clock shows in the Sun\'s neighbourhood');

  await page.waitForFunction(() => window.starfield.transition.state === 'system', null, { timeout: 30000 });
  const way = await app(page, () => ({ ...window.way, au: Math.hypot(...window.starfield.ship.pos) * 206264.80624709636 }));
  assert.ok(way.au < 60 && way.au > 20, `arrived ${way.au.toFixed(0)} AU out`);
  assert.deepEqual(way.changes, ['interstellar>approach', 'approach>system']);
  assert.deepEqual(way.toasts, ['Entering the Solar System']);
  assert.ok(way.roll > 1 && way.roll < 22, `the view levelled at up to ${way.roll.toFixed(1)} deg/s`);
  await page.waitForFunction(() => window.starfield.transition.level > 0.999, null, { timeout: 15000 });
  await page.waitForTimeout(300);
  // the overlay reports the state, e.g. "system  system 100%  sky 100%  level 100%" or "body Saturn  ..."
  const line = (await page.locator('#stats').textContent()).split('\n').pop();
  assert.match(line, /^(system|body \w+|approach) {2}system \d+% {2}sky \d+% {2}level \d+%$/, `overlay: ${line}`);

  // Turning round and leaving is announced too, once it is well clear (hysteresis).
  await app(page, () => { const a = window.starfield; a.ship.lookAlong(a.ship.pos.map((x) => x)); });
  await page.waitForFunction(() => window.starfield.transition.state === 'approach', null, { timeout: 30000 });
  const out = await app(page, () => ({ ...window.way, au: Math.hypot(...window.starfield.ship.pos) * 206264.80624709636 }));
  assert.ok(out.au > 75, `left at ${out.au.toFixed(0)} AU`);
  assert.deepEqual(out.toasts, ['Entering the Solar System', 'Leaving the Solar System']);
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

await check('the autopilot flies from the stars to Jupiter with it centred, parks, and stays with it as time runs fast', async () => {
  const { ctx, page } = await newPage(browser);
  await app(page, () => window.starfield.flyToTarget({ kind: 'body', id: 'jupiter' }));
  assert.equal(await app(page, () => window.starfield.ship.autopilot && window.starfield.ship.target.kind), 'body');
  await watchTrip(page, 'jupiter');
  await page.waitForFunction(() => !window.starfield.ship.autopilot, null, { timeout: 60000 });
  await page.waitForTimeout(800);
  const trip = await tripResult(page);
  assert.ok(trip.frames > 20 && trip.offCentre < 3, `Jupiter stayed within ${trip.offCentre.toFixed(2)} deg of the centre on the way in`);
  assert.ok(trip.turnAfter < 0.5, `turned ${trip.turnAfter.toFixed(2)} deg after stopping`);
  const dist = () => app(page, () => {
    const a = window.starfield, j = a.solar.get('jupiter'), p = a.ship.pos.map((x) => x * 206264.80624709636);
    return Math.hypot(p[0] - j.pos[0], p[1] - j.pos[1], p[2] - j.pos[2]) / j.Req;
  });
  const d0 = await dist();
  assert.ok(Math.abs(d0 / 4.5 - 1) < 0.03, `parked ${d0.toFixed(2)} Jupiter radii out`);
  assert.match(await page.locator('#toast').textContent(), /Arrived: Jupiter/);
  // a month per second: Jupiter moves ~0.3 AU/s, the ship moves with it
  const jd0 = await app(page, () => window.starfield.solar.jdUT);
  await app(page, () => window.starfield.setTimeRate(2629800));
  await page.waitForTimeout(1500);
  const jd1 = await app(page, () => window.starfield.solar.jdUT);
  assert.ok(jd1 - jd0 > 20, `the clock ran ${(jd1 - jd0).toFixed(0)} days`);
  const d1 = await dist();
  assert.ok(Math.abs(d1 / d0 - 1) < 0.01, `still ${d1.toFixed(2)} radii from Jupiter`);
  await shot(page, 'jupiter');
  await app(page, () => window.starfield.timeNow());
  await page.waitForTimeout(400); // the next frame moves the planets
  const jd2 = await app(page, () => window.starfield.solar.jdUT);
  assert.ok(Math.abs(jd2 - (Date.now() / 86400000 + 2440587.5)) < 0.01, 'back to now');
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

await check('boost button, sliders, menu, settings and install UI', async () => {
  const { ctx, page } = await newPage(browser);
  const b = await page.locator('#boost').boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(200);
  assert.equal(await app(page, () => window.starfield.ship.boostHeld), true);
  await page.mouse.up();
  assert.equal(await app(page, () => window.starfield.ship.boostHeld), false);

  const track = await page.locator('#speed-slider .track').boundingBox();
  await page.mouse.click(track.x + track.width / 2, track.y + track.height * 0.9);
  const low = await app(page, () => window.starfield.ship.throttle);
  assert.ok(low < 0.2, `speed slider low ${low}`);
  const dtrack = await page.locator('#density-slider .track').boundingBox();
  await page.mouse.click(dtrack.x + dtrack.width / 2, dtrack.y + dtrack.height * 0.1);
  const dens = await app(page, () => window.starfield.settings.density);
  assert.ok(dens > 0.8, `density slider high ${dens}`);
  await page.waitForTimeout(150);
  const lim = await app(page, () => window.starfield.lastFrame.magLimit);
  assert.ok(lim > 9.3, `limiting magnitude follows density: ${lim}`);

  await page.click('#menu-btn');
  assert.equal(await page.locator('#sheet').isVisible(), true);
  assert.equal(await page.locator('#install-section').isVisible(), true, 'install section shown in the browser');
  assert.match(await page.locator('#apk-link').getAttribute('href'), /releases\/latest\/download\/starfield-flight\.apk$/);
  assert.ok((await page.locator('#install-note').textContent()).length > 20);
  await shot(page, 'menu');
  await page.click('#set-labels');
  // saved after a short debounce
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('starfield-flight.settings.v1')).labels === false, null, { timeout: 5000 });
  await page.click('#sheet .close');
  assert.equal(await page.locator('#sheet').isVisible(), false);
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

await check('random jump far from home, then the marker leads back', async () => {
  const { ctx, page } = await newPage(browser);
  await app(page, () => window.starfield.jumpRandom());
  await page.waitForTimeout(500);
  const d = await app(page, () => Math.hypot(...window.starfield.ship.pos) * 3.2616);
  assert.ok(d > 50, `jumped ${d.toFixed(0)} ly from Sol`);
  assert.match(await page.locator('#sol .dist').textContent(), /ly/);
  await shot(page, 'jump');
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

await check('survives WebGL context loss', async () => {
  const { ctx, page } = await newPage(browser);
  await app(page, async () => {
    const ext = window.starfield.renderer.gl.getExtension('WEBGL_lose_context');
    ext.loseContext();
    await new Promise((r) => setTimeout(r, 300));
    ext.restoreContext();
    await new Promise((r) => setTimeout(r, 600));
  });
  const s = await canvasStats(page);
  assert.ok(s.bright > 30, 'drawing again after restore');
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

await check('works offline after the first visit (service worker)', async () => {
  const { ctx, page } = await newPage(browser, { query: '' });
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === 'activated', null, { timeout: 90000, polling: 500 });
  await page.waitForFunction(async () => (await caches.keys()).length > 0 && (await (await caches.open((await caches.keys())[0])).keys()).length > 15, null, { timeout: 90000, polling: 500 });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 30000 });
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => window.starfield && window.starfield.running, null, { timeout: 90000 });
  const s = await canvasStats(page);
  assert.ok(s.bright > 30, 'renders offline');
  await ctx.close();
});

await check('frame time (informational, software rendering)', async () => {
  const { ctx, page } = await newPage(browser, { query: '' });
  await app(page, () => window.starfield.setThrottle(0.75));
  const ms = await app(page, () => new Promise((resolve) => {
    const t = []; let last = performance.now();
    const f = (now) => { t.push(now - last); last = now; if (t.length < 120) requestAnimationFrame(f); else resolve(t); };
    requestAnimationFrame(f);
  }));
  ms.sort((a, b) => a - b);
  const info = await app(page, () => ({ scale: window.starfield.perf.scale, w: window.starfield.renderer.canvas.width }));
  console.log(`  median frame ${ms[60].toFixed(1)} ms, p90 ${ms[108].toFixed(1)} ms on SwiftShader (canvas ${info.w}px, scale ${info.scale})`);
  await ctx.close();
});

await browser.close();
server.close();
const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
