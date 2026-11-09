#!/usr/bin/env node
// End-to-end test of the production build in headless Chromium (Playwright, software GL).
//   npm run build && node test/e2e/smoke.mjs [--shots dir]
// Checks rendering, touch steering, pinch-to-throttle, tapping stars, the Sol marker and
// autopilot, boost, sliders, the menu and install UI, WebGL context loss and offline start.
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
  try { await fn(); results.push(['ok', name]); console.log(`ok - ${name}`); }
  catch (err) { results.push(['FAIL', name]); console.log(`not ok - ${name}\n  ${String(err.stack || err).split('\n').slice(0, 5).join('\n  ')}`); }
}

async function newPage(browser, { query = '?fixed', settings = { hintSeen: true }, viewport = { width: 412, height: 860 } } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: true, hasTouch: true, serviceWorkers: 'allow' });
  await ctx.addInitScript((s) => {
    if (!localStorage.getItem('starfield-flight.settings.v1')) localStorage.setItem('starfield-flight.settings.v1', JSON.stringify(s));
  }, settings);
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

await check('tapping the Sol marker flies home and parks near the Sun', async () => {
  const { ctx, page } = await newPage(browser);
  await app(page, () => { const a = window.starfield; a.ship.pos = [12, -30, 8]; a.ship.lookAlong([1, 0, 0]); a.setThrottle(0); });
  await page.waitForTimeout(600);
  const box = await page.locator('#sol').boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  assert.equal(await app(page, () => window.starfield.ship.autopilot && window.starfield.ship.target.kind), 'sol');
  await page.waitForFunction(() => !window.starfield.ship.autopilot, null, { timeout: 40000 });
  const d = await app(page, () => Math.hypot(...window.starfield.ship.pos));
  assert.ok(Math.abs(d - 0.0153) < 0.002, `parked ${d} pc from the Sun`);
  assert.match(await page.locator('#toast').textContent(), /Home/);
  await shot(page, 'home');
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
