// Frame-rate governor: keeps the app at a steady 60 fps or better by trading render
// resolution first and star depth (limiting magnitude) second, and slowly gives quality
// back when there is headroom. Decisions use one-second windows of rAF intervals, so a
// single hitch (GC, notification) does not cause a change.
export class PerfGovernor {
  constructor({ minScale = 0.55, maxScale = 1, minMagCap = 6.5, maxMagCap = 12 } = {}) {
    this.minScale = minScale; this.maxScale = maxScale;
    this.minMagCap = minMagCap; this.maxMagCap = maxMagCap;
    this.scale = maxScale;
    this.magCap = maxMagCap;
    this.samples = [];
    this.windowStart = 0;
    this.refresh = 60;       // measured display refresh rate
    this.fps = 0;
    this.cooldown = 0;
    this.goodWindows = 0;
    this.changed = false;
  }

  /** Feed one frame interval (ms). Returns true when scale or magCap changed. */
  frame(now, dtMs) {
    this.changed = false;
    if (dtMs > 0 && dtMs < 250) this.samples.push(dtMs);
    if (!this.windowStart) this.windowStart = now;
    if (now - this.windowStart < 1000 || this.samples.length < 20) return false;
    const s = this.samples.sort((a, b) => a - b);
    const median = s[s.length >> 1];
    const p90 = s[Math.floor(s.length * 0.9)];
    this.fps = 1000 / median;
    // The fastest sustained interval tells us the display refresh (60, 90, 120 Hz).
    const best = s[Math.floor(s.length * 0.1)];
    this.refresh = Math.max(60, Math.min(144, Math.round(1000 / best / 30) * 30));
    this.samples = [];
    this.windowStart = now;
    if (this.cooldown > 0) { this.cooldown--; return false; }

    const slow = median > 17.8 || p90 > 24;            // below ~56 fps or frequent hitches
    const roomy = median < 1000 / this.refresh + 1.2 && p90 < 18;
    if (slow) {
      this.goodWindows = 0;
      if (this.scale > this.minScale + 1e-3) this.scale = Math.max(this.minScale, this.scale - 0.1);
      else if (this.magCap > this.minMagCap) this.magCap = Math.max(this.minMagCap, this.magCap - 0.5);
      this.cooldown = 1;
      this.changed = true;
    } else if (roomy && (this.scale < this.maxScale || this.magCap < this.maxMagCap)) {
      if (++this.goodWindows >= 4) {
        this.goodWindows = 0;
        if (this.magCap < this.maxMagCap) this.magCap = Math.min(this.maxMagCap, this.magCap + 0.25);
        else this.scale = Math.min(this.maxScale, this.scale + 0.05);
        this.cooldown = 2;
        this.changed = true;
      }
    } else {
      this.goodWindows = 0;
    }
    return this.changed;
  }
}
