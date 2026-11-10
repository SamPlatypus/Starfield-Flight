// On-screen controls: throttle and density sliders, the boost button, the search and menu
// buttons, the menu sheet (settings, Solar System clock, install UI), the search and
// favourites panels and the info card's buttons. Controls fade to near-invisible when idle
// and wake on interaction.
import { haptic, isNative } from './platform.js';
import { Installer, APK_URL, isAndroid } from './install.js';
import { densityToMag, TIME_RATES } from './settings.js';
import { formatSpeed } from './math.js';
import { throttleToSpeed } from './flight.js';
import { SearchPanel, FavouritesPanel } from './panels.js';
import { formatClock } from './hud.js';

const IDLE_MS = 4500;

class VSlider {
  constructor(el, value, onInput) {
    this.el = el;
    this.track = el.querySelector('.track');
    this.fill = el.querySelector('.fill');
    this.thumb = el.querySelector('.thumb');
    this.onInput = onInput;
    this.set(value);
    const fromEvent = (e) => {
      const r = this.track.getBoundingClientRect();
      return Math.min(1, Math.max(0, (r.bottom - e.clientY) / r.height));
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      this.dragging = true;
      this.offset = fromEvent(e) - this.value;
      // grabbing the thumb keeps it under the finger; touching the track jumps there
      if (Math.abs(this.offset) > 0.08) this.offset = 0;
      this.input(fromEvent(e) - this.offset);
    });
    el.addEventListener('pointermove', (e) => { if (this.dragging) { e.preventDefault(); this.input(fromEvent(e) - this.offset); } });
    const end = () => { this.dragging = false; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 0.03 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -0.03 : 0;
      if (step) { e.preventDefault(); e.stopPropagation(); this.input(this.value + step); }
    });
  }
  input(v) {
    const prev = this.value;
    this.set(v);
    if (this.value !== prev) this.onInput(this.value);
  }
  set(v) {
    this.value = Math.min(1, Math.max(0, v));
    const pct = (this.value * 100).toFixed(2);
    this.fill.style.height = `${pct}%`;
    this.thumb.style.bottom = `calc(${pct}% - 11px)`;
    this.thumb.style.top = 'auto';
    this.el.setAttribute('aria-valuenow', Math.round(this.value * 100));
  }
}

export class Controls {
  constructor(app) {
    this.app = app;
    const $ = (s) => document.querySelector(s);
    this.hud = $('#hud');
    this.sheet = $('#sheet');
    this.card = $('#card');
    const s = app.settings;

    this.speed = new VSlider($('#speed-slider'), s.throttle, (v) => { app.setThrottle(v, 'slider'); this.wake(); });
    this.density = new VSlider($('#density-slider'), s.density, (v) => { app.setDensity(v); this.wake(); });
    this.densityVal = $('#density-slider .val');
    this.speedCap = $('#speed-slider .cap');

    // Boost: hold.
    const boost = $('#boost');
    const on = (e) => { e.preventDefault(); e.stopPropagation(); boost.setPointerCapture(e.pointerId); app.boost('button', true); this.wake(); };
    const off = () => app.boost('button', false);
    boost.addEventListener('pointerdown', on);
    boost.addEventListener('pointerup', off);
    boost.addEventListener('pointercancel', off);
    boost.addEventListener('lostpointercapture', off);
    boost.addEventListener('contextmenu', (e) => e.preventDefault());
    this.boostEl = boost;

    // Search and favourites panels.
    this.search = new SearchPanel(app, $('#search'));
    this.favs = new FavouritesPanel(app, $('#favourites'));

    $('#menu-btn').addEventListener('click', () => this.toggleMenu());
    $('#search-btn').addEventListener('click', () => this.openSearch());
    $('#sol').addEventListener('click', () => { app.home(); this.wake(); });
    this.sheet.querySelector('.close').addEventListener('click', () => this.toggleMenu(false));
    this.sheet.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', () => {
      const a = b.dataset.action;
      this.toggleMenu(false);
      if (a === 'home') app.home();
      else if (a === 'search') this.openSearch();
      else if (a === 'favourites') this.openFavourites();
      else if (a === 'jump') app.jumpRandom();
      else if (a === 'stop') app.allStop();
      else if (a === 'cinema') app.toggleCinema(true);
    }));

    // Settings bindings.
    const bindRange = (id, key, apply) => {
      const el = $(id);
      el.value = s[key];
      el.addEventListener('input', () => { s[key] = +el.value; apply?.(+el.value); app.saveSettings(); });
    };
    const bindCheck = (id, key, apply) => {
      const el = $(id);
      el.checked = !!s[key];
      el.addEventListener('change', () => { s[key] = el.checked; apply?.(el.checked); app.saveSettings(); });
    };
    bindRange('#set-blur', 'blur');
    bindRange('#set-milkyway', 'milkyWay');
    bindRange('#set-fov', 'fov');
    bindRange('#set-gain', 'gain');
    bindCheck('#set-labels', 'labels', (v) => app.hud.setLabels(v));
    bindCheck('#set-level', 'level', (v) => { app.ship.level = v; });
    bindCheck('#set-invert', 'invertPitch', (v) => { app.input.invertPitch = v; });
    bindCheck('#set-haptics', 'haptics', (v) => app.setHaptics(v));
    bindCheck('#set-stats', 'stats', (v) => { $('#stats').hidden = !v; });
    $('#stats').addEventListener('click', () => app.cycleStarDraw());
    bindCheck('#set-lines', 'lines');
    bindCheck('#set-connames', 'conNames', (v) => app.hud.setConNames(v));
    bindCheck('#set-orbits', 'orbits');
    this.syncCheckboxes = () => {
      $('#set-labels').checked = s.labels;
      $('#set-lines').checked = s.lines;
      $('#set-connames').checked = s.conNames;
      $('#set-orbits').checked = s.orbits;
    };

    // Solar System clock.
    this.rates = $('#time-rates');
    for (const [label, rate] of TIME_RATES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.dataset.rate = rate;
      b.addEventListener('click', () => { app.setTimeRate(rate); this.syncRates(); });
      this.rates.append(b);
    }
    $('#time-now').addEventListener('click', () => { app.timeNow(); this.syncRates(); });
    this.clockEl = $('#clock-now');

    // Info card.
    this.card.querySelector('.close').addEventListener('click', () => app.hud.closeCard());
    this.card.querySelector('.fly').addEventListener('click', () => {
      const t = app.hud.cardTarget;
      app.hud.closeCard();
      if (t) app.flyToTarget(t);
    });
    this.card.querySelector('.fav').addEventListener('click', () => { if (app.hud.cardTarget) app.toggleFavourite(app.hud.cardTarget); });

    // Install (web only).
    this.installer = new Installer((what) => this.refreshInstall(what));
    this.installSection = $('#install-section');
    this.installNote = $('#install-note');
    this.installBtn = $('#install-app');
    this.apkLink = $('#apk-link');
    this.apkLink.href = APK_URL;
    this.pill = $('#install-pill');
    this.installBtn.addEventListener('click', () => this.install());
    this.pill.querySelector('.go').addEventListener('click', () => this.install());
    this.pill.querySelector('.x').addEventListener('click', () => {
      this.pill.hidden = true;
      s.installDismissed = true;
      app.saveSettings();
    });
    this.refreshInstall();

    // Idle fading: anything touching a control wakes them.
    this.hud.addEventListener('pointerdown', (e) => { if (e.target.closest('.chrome')) this.wake(); }, true);
    this.wake(8000);
    this.update();
  }

  async install() {
    if (this.installer.canPrompt) {
      const outcome = await this.installer.prompt();
      if (outcome === 'accepted') this.app.hud.toast('Installing… it will appear on your home screen');
    } else {
      this.toggleMenu(true);
      this.installSection.scrollIntoView({ block: 'nearest' });
    }
    this.pill.hidden = true;
  }

  refreshInstall(what) {
    const inst = this.installer;
    const show = inst.relevant;
    this.installSection.hidden = !show;
    this.installNote.textContent = inst.instructions();
    this.installBtn.hidden = !inst.canPrompt;
    // The APK is for Android phones; desktop users can still grab it from the menu.
    this.apkLink.hidden = isNative;
    this.apkLink.classList.toggle('primary', isAndroid && !inst.canPrompt);
    this.pill.hidden = !(show && inst.canPrompt && !this.app.settings.installDismissed);
    if (what === 'installed') this.app.hud.toast('Installed — launch Starfield Flight from your home screen');
  }

  wake(ms = IDLE_MS) {
    this.hud.classList.remove('idle');
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.sheet.hidden || this.search.open || this.favs.open) return;
      this.hud.classList.add('idle');
    }, ms);
  }

  toggleMenu(force) {
    const open = force ?? this.sheet.hidden;
    this.sheet.hidden = !open;
    if (open) {
      this.search.close();
      this.favs.close();
      this.app.hud.closeCard();
      this.syncRates();
      haptic('select');
      this.refreshInstall();
    }
    this.wake();
    return open;
  }

  openSearch() {
    this.sheet.hidden = true;
    this.favs.close();
    this.app.hud.closeCard();
    this.search.show();
    haptic('select');
    this.wake();
  }

  openFavourites() {
    this.sheet.hidden = true;
    this.search.close();
    this.app.hud.closeCard();
    this.favs.show();
    haptic('select');
    this.wake();
  }

  /** Closes the topmost panel (search, favourites, menu); false when none was open. */
  closeTopPanel() {
    if (this.search.close() || this.favs.close()) return true;
    if (!this.sheet.hidden) { this.toggleMenu(false); return true; }
    return false;
  }

  get panelOpen() { return this.search.open || this.favs.open || !this.sheet.hidden; }

  syncRates() {
    for (const b of this.rates.children) b.classList.toggle('on', +b.dataset.rate === this.app.timeRate);
    this.clockEl.textContent = formatClock(this.app.solar.jdUT);
  }

  /** Reflect app state (called every few frames). */
  update() {
    const app = this.app;
    if (!this.speed.dragging && Math.abs(this.speed.value - app.ship.throttle) > 1e-4) this.speed.set(app.ship.throttle);
    if (!this.density.dragging && Math.abs(this.density.value - app.settings.density) > 1e-4) this.density.set(app.settings.density);
    const cap = `mag ${densityToMag(app.settings.density).toFixed(1)}`;
    if (this.densityVal.textContent !== cap) this.densityVal.textContent = cap;
    const sp = formatSpeed(throttleToSpeed(app.ship.throttle));
    if (this.speedEl !== sp) { this.speedEl = sp; this.speed.el.setAttribute('aria-valuetext', sp); }
    this.boostEl.classList.toggle('on', app.ship.boostHeld);
    if (!this.sheet.hidden) this.clockEl.textContent = formatClock(app.solar.jdUT);
  }
}
