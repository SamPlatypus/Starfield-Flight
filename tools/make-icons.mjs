#!/usr/bin/env node
// Generates the app icon artwork (public/icons/icon.svg) and rasterises it with Playwright
// into the PWA icons and the Android launcher / adaptive icons and splash.
//   node tools/make-icons.mjs
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = join(root, 'public', 'icons');
const res = join(root, 'android', 'app', 'src', 'main', 'res');
mkdirSync(iconsDir, { recursive: true });

// Deterministic pseudo-random numbers so the artwork is reproducible.
let seed = 20261109;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

const STREAKS = Array.from({ length: 34 }, (_, k) => {
  const a = (k / 34) * Math.PI * 2 + (rnd() - 0.5) * 0.16;
  const r0 = 46 + rnd() * 60;
  const r1 = Math.min(250, r0 + 70 + rnd() * 150);
  return { a, r0, r1, w: 2.2 + rnd() * 4.6, o: 0.55 + rnd() * 0.45, hue: rnd() };
});

/**
 * @param scale  size of the artwork relative to the square (1 = full bleed)
 * @param bg     draw the background gradient
 * @param round  clip to a circle (legacy round launcher icon)
 */
function artwork({ scale = 1, bg = true, round = false } = {}) {
  const c = 256;
  const defs = [];
  const parts = [];
  defs.push(`<radialGradient id="bg" cx="50%" cy="50%" r="72%">
    <stop offset="0" stop-color="#1d2c58"/><stop offset="0.42" stop-color="#0b1226"/><stop offset="1" stop-color="#020309"/></radialGradient>`);
  defs.push(`<radialGradient id="core" cx="50%" cy="50%" r="50%">
    <stop offset="0" stop-color="#ffffff"/><stop offset="0.35" stop-color="#fff4da"/><stop offset="1" stop-color="#ffd27a" stop-opacity="0"/></radialGradient>`);
  if (round) defs.push(`<clipPath id="clip"><circle cx="${c}" cy="${c}" r="${c}"/></clipPath>`);
  if (bg) parts.push(`<rect width="512" height="512" fill="url(#bg)"/>`);
  STREAKS.forEach((s, i) => {
    const x0 = c + Math.cos(s.a) * s.r0 * scale, y0 = c + Math.sin(s.a) * s.r0 * scale;
    const x1 = c + Math.cos(s.a) * s.r1 * scale, y1 = c + Math.sin(s.a) * s.r1 * scale;
    const col = s.hue < 0.25 ? '#ffe6c4' : s.hue < 0.75 ? '#e9f1ff' : '#bcd4ff';
    defs.push(`<linearGradient id="s${i}" gradientUnits="userSpaceOnUse" x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}">
      <stop offset="0" stop-color="${col}" stop-opacity="0"/><stop offset="1" stop-color="${col}" stop-opacity="${s.o.toFixed(2)}"/></linearGradient>`);
    parts.push(`<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="url(#s${i})" stroke-width="${(s.w * scale).toFixed(2)}" stroke-linecap="round"/>`);
  });
  const R = 40 * scale, t = 18 * scale, gap = 8 * scale;
  parts.push(`<circle cx="${c}" cy="${c}" r="${(30 * scale).toFixed(1)}" fill="url(#core)"/>`);
  parts.push(`<circle cx="${c}" cy="${c}" r="${(7 * scale).toFixed(1)}" fill="#fffaf0"/>`);
  parts.push(`<g stroke="#ffd27a" stroke-width="${(6.5 * scale).toFixed(2)}" fill="none" stroke-linecap="round">
    <circle cx="${c}" cy="${c}" r="${R.toFixed(1)}"/>
    <path d="M${c} ${c - R - gap}v${-t}M${c} ${c + R + gap}v${t}M${c - R - gap} ${c}h${-t}M${c + R + gap} ${c}h${t}"/></g>`);
  const body = round ? `<g clip-path="url(#clip)">${parts.join('')}</g>` : parts.join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><defs>${defs.join('')}</defs>${body}</svg>`;
}

const master = artwork();
writeFileSync(join(iconsDir, 'icon.svg'), master + '\n');
console.log('wrote public/icons/icon.svg');

let chromium;
try { ({ chromium } = require('playwright')); } catch { console.error('Playwright is needed to rasterise icons'); process.exit(1); }
const browser = await chromium.launch();
const page = await browser.newPage();
async function png(svg, size, file, transparent = false) {
  await page.setViewportSize({ width: size, height: size });
  const scaled = svg.replace('width="512" height="512"', `width="${size}" height="${size}"`);
  await page.setContent(`<html><body style="margin:0;background:${transparent ? 'transparent' : '#000'}">${scaled}</body></html>`);
  mkdirSync(dirname(file), { recursive: true });
  await page.screenshot({ path: file, omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
  console.log(`wrote ${file.slice(root.length + 1)}`);
}

await png(master, 192, join(iconsDir, 'icon-192.png'));
await png(master, 512, join(iconsDir, 'icon-512.png'));
await png(master, 180, join(iconsDir, 'apple-touch-icon.png'));
await png(artwork({ scale: 0.78 }), 512, join(iconsDir, 'maskable-512.png'));

if (existsSync(res)) {
  // Legacy launcher icons (48dp) and adaptive foreground layers (108dp, safe zone 66dp).
  const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, k] of Object.entries(dens)) {
    await png(artwork({ scale: 0.92 }), 48 * k, join(res, `mipmap-${d}`, 'ic_launcher.png'));
    await png(artwork({ scale: 0.92, round: true }), 48 * k, join(res, `mipmap-${d}`, 'ic_launcher_round.png'), true);
    await png(artwork({ scale: 0.6 }), 108 * k, join(res, `mipmap-${d}`, 'ic_launcher_foreground.png'));
  }
  // Splash icon for Android 12+ (shown inside a 160dp circle -> keep it small)
  await png(artwork({ scale: 0.5, bg: false }), 288, join(res, 'drawable-nodpi', 'splash_icon.png'), true);
} else {
  console.log('android/ not found: skipped launcher icons (run after `npx cap add android`)');
}
await browser.close();
