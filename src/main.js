// Entry point: boot the app, show load progress, register the offline service worker (web).
import './styles.css';
import { App } from './app.js';
import { isNative, appVersion } from './platform.js';

export const VERSION = __APP_VERSION__;

const loading = document.getElementById('loading');
const bar = loading.querySelector('.fill');

function fatal(msg) {
  const el = document.getElementById('fatal');
  el.hidden = false;
  el.textContent = msg;
  loading.classList.add('done');
}

async function boot() {
  const app = new App(document.getElementById('sky'));
  window.starfield = app; // for debugging and the automated tests
  try {
    await app.init((p) => { bar.style.width = `${Math.round(p * 100)}%`; });
  } catch (err) {
    console.error(err);
    fatal(/WebGL/i.test(String(err))
      ? 'Starfield Flight needs WebGL 2, which this device or browser does not provide.'
      : `Starfield Flight could not start: ${err.message || err}`);
    return;
  }
  bar.style.width = '100%';
  app.start();
  requestAnimationFrame(() => requestAnimationFrame(() => loading.classList.add('done')));
  const stats = document.getElementById('about-stats');
  const c = app.catalog.header.counts;
  stats.textContent = `${app.catalog.count.toLocaleString('en-US')} stars: ${c.yale.toLocaleString('en-US')} Yale BSC, ` +
    `${c.athyg.toLocaleString('en-US')} Hipparcos/Tycho-2 (AT-HYG), ${c.gcns.toLocaleString('en-US')} Gaia nearby stars, and the Sun.`;
  const native = await appVersion();
  document.getElementById('about-version').textContent = `Version ${VERSION}${native ? ` · build ${native}` : ''}`;
  if (!app.settings.hintSeen) {
    const hint = document.getElementById('hint');
    hint.hidden = false;
    setTimeout(() => hint.classList.add('fade'), 7000);
    setTimeout(() => { hint.hidden = true; }, 8000);
    app.settings.hintSeen = true;
    app.saveSettings();
  }
}

// Stop iOS page pinch-zoom so two-finger gestures reach the starfield.
document.addEventListener('gesturestart', (e) => e.preventDefault());

if (!isNative && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('service worker registration failed', err));
  });
}

boot();
