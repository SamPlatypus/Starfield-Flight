// Touch, mouse and keyboard input on the sky.
//
//   one finger drag  virtual joystick: the offset from where the finger went down sets
//                    the turn rate (so you can hold a steady turn without running out of screen)
//   tap              turn towards that point / the star under the finger
//   press and hold   boost while held (keep dragging to steer while boosting)
//   two fingers      pinch to change speed, twist to roll
//   mouse            drag = joystick, wheel = speed, click = tap
//   keyboard         WASD / arrows steer, Q E roll, Space / Shift boost, + - speed,
//                    [ ] density, H home, M menu, C hide controls, L names, / search,
//                    F favourites, K constellation lines, N constellation names
import { clamp } from './math.js';

const TAP_MS = 320, TAP_PX = 10, HOLD_MS = 420, HOLD_PX = 12;

export class Input {
  /** app must provide: steer(source, x, y), boost(source, on), tap(x, y), nudgeThrottle(d),
   *  setThrottle(t), throttle(), roll(rad), nudgeDensity(d), home(), toggleMenu(), toggleCinema(),
   *  toggleLabels(), wake(), stick(el state) */
  constructor(el, stickEl, app) {
    this.el = el;
    this.stickEl = stickEl;
    this.knob = stickEl.querySelector('.knob');
    this.app = app;
    this.pointers = new Map();
    this.mode = null;
    this.holdTimer = 0;
    this.keys = new Set();
    this.invertPitch = false;

    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.up(e, true));
    el.addEventListener('lostpointercapture', (e) => { if (this.pointers.has(e.pointerId)) this.up(e, true); });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.app.nudgeThrottle(-Math.sign(e.deltaY) * Math.min(0.06, Math.abs(e.deltaY) * 0.0006 + 0.01));
    }, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.key(e, true));
    window.addEventListener('keyup', (e) => this.key(e, false));
    window.addEventListener('blur', () => { this.keys.clear(); this.keySteer(); this.app.boost('key', false); });
  }

  get radius() { return clamp(0.15 * Math.min(innerWidth, innerHeight), 55, 110); }

  down(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try { this.el.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    const p = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: 0 };
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1) {
      this.mode = 'stick';
      this.showStick(p.x0, p.y0, 0, 0);
      clearTimeout(this.holdTimer);
      this.holdTimer = setTimeout(() => {
        if (this.mode === 'stick' && this.pointers.size === 1 && p.moved < HOLD_PX) {
          this.holding = true;
          this.app.boost('hold', true);
        }
      }, HOLD_MS);
    } else if (this.pointers.size === 2) {
      // Second finger: switch to pinch / twist; the stick lets go.
      this.mode = 'pinch';
      clearTimeout(this.holdTimer);
      this.app.steer('touch', 0, 0);
      this.hideStick();
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d0: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x), t0: this.app.throttle() };
    }
  }

  move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    p.x = e.clientX; p.y = e.clientY;
    p.moved = Math.max(p.moved, Math.hypot(p.x - p.x0, p.y - p.y0));
    if (this.mode === 'stick') {
      const r = this.radius;
      let dx = (p.x - p.x0) / r, dy = (p.y - p.y0) / r;
      const m = Math.hypot(dx, dy);
      if (m > 1) { dx /= m; dy /= m; }
      this.showStick(p.x0, p.y0, dx * r, dy * r);
      // dead zone, then rescale so the response starts at zero
      const mm = Math.min(1, m);
      const k = mm < 0.07 ? 0 : (mm - 0.07) / 0.93 / (mm || 1);
      this.app.steer('touch', dx * k, (this.invertPitch ? 1 : -1) * dy * k);
    } else if (this.mode === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      if (this.pinch.d0 > 10) this.app.setThrottle(this.pinch.t0 + Math.log2(d / this.pinch.d0) * 0.18);
      let da = angle - this.pinch.angle;
      if (da > Math.PI) da -= 2 * Math.PI; else if (da < -Math.PI) da += 2 * Math.PI;
      this.pinch.angle = angle;
      if (Math.abs(da) < 0.5) this.app.roll(da);
    }
  }

  up(e, cancelled = false) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    clearTimeout(this.holdTimer);
    if (this.mode === 'stick') {
      const quick = performance.now() - p.t0 < TAP_MS && p.moved < TAP_PX;
      this.app.steer('touch', 0, 0);
      this.hideStick();
      if (this.holding) { this.holding = false; this.app.boost('hold', false); }
      else if (quick && !cancelled) this.app.tap(p.x, p.y);
    }
    if (this.pointers.size === 0) {
      this.mode = null;
      if (this.holding) { this.holding = false; this.app.boost('hold', false); }
    }
  }

  showStick(x, y, kx, ky) {
    this.stickEl.classList.add('on');
    this.stickEl.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    this.knob.style.transform = `translate3d(${kx}px, ${ky}px, 0)`;
  }
  hideStick() { this.stickEl.classList.remove('on'); }

  key(e, isDown) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.isContentEditable)) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const steerKeys = ['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'a', 'd', 'w', 's', 'q', 'e'];
    const lk = k.toLowerCase();
    if (steerKeys.includes(lk)) {
      if (isDown) this.keys.add(lk); else this.keys.delete(lk);
      this.keySteer();
      e.preventDefault();
      return;
    }
    if (k === ' ' || k === 'Shift') { this.app.boost('key', isDown); e.preventDefault(); return; }
    if (!isDown) return;
    if (k === '+' || k === '=') this.app.nudgeThrottle(0.04);
    else if (k === '-' || k === '_') this.app.nudgeThrottle(-0.04);
    else if (k === '[') this.app.nudgeDensity(-0.05);
    else if (k === ']') this.app.nudgeDensity(0.05);
    else if (k === 'h') this.app.home();
    else if (k === 'm') this.app.toggleMenu();
    else if (k === 'Escape') { if (!this.app.back()) this.app.toggleMenu(); }
    else if (k === 'c') this.app.toggleCinema();
    else if (k === 'l') this.app.toggleLabels();
    else if (k === '/') { e.preventDefault(); this.app.openSearch(); }
    else if (k === 'f') this.app.openFavourites();
    else if (k === 'k') this.app.toggleLines();
    else if (k === 'n') this.app.toggleConNames();
    else return;
    this.app.wake();
  }

  keySteer() {
    const has = (...ks) => ks.some((x) => this.keys.has(x));
    const x = (has('arrowright', 'd') ? 1 : 0) - (has('arrowleft', 'a') ? 1 : 0);
    let y = (has('arrowup', 'w') ? 1 : 0) - (has('arrowdown', 's') ? 1 : 0);
    if (this.invertPitch) y = -y;
    this.app.steer('key', x * 0.75, y * 0.75);
    this.app.rollRate((this.keys.has('e') ? 1 : 0) - (this.keys.has('q') ? 1 : 0));
  }
}
