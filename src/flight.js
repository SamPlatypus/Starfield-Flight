// Ship: position (parsecs, equatorial J2000 frame centred on the Sun), orientation,
// speed and the steering / autopilot logic. Pure math, no DOM, so it is unit-testable.
//
// Scales run from kilometres near a moon to kiloparsecs across the catalogue, so nothing
// here uses absolute thresholds: the throttle is scaled by `speedScale` (the app lowers it
// inside the Solar System), the autopilot cruises at a speed set by the trip length and
// arrives on a logarithmic tail, and arrival is judged relative to the parking distance.
//
// Under manual control the ship flies where it looks. The autopilot separates the two when
// its target has something to look at (`face` / `locateFace`): the view stays on that
// subject for the whole trip while the ship travels to the viewpoint beside it, so it
// slides into place with the subject centred instead of stopping and then turning to it.
import { quat, v3, clamp, ease, GALACTIC_NORTH } from './math.js';

export const SPEED_MIN = 0.003;   // pc/s at the bottom of the throttle (~0.01 ly/s)
export const SPEED_MAX = 60;      // pc/s at full throttle (~196 ly/s)
export const BOOST_FACTOR = 6;
const THROTTLE_DEAD = 0.02;       // bottom 2% of the throttle = all stop
const TURN_RATE = 1.1;            // rad/s at full stick
const ROLL_RATE = 1.6;            // rad/s
const AIM_GAIN = 2.4;             // 1/s, turn-to-target proportional gain
const SOL_STOP = 0.0153;          // pc: legacy parking distance when no parking point is given
const TAIL = 0.55;                // s: the last stretch of every autopilot trip closes by e each TAIL
const LOOK_RATE_MAX = 2;          // rad/s: fastest the view follows a subject sliding past
const SLIDE_RATE = 0.5;           // rad/s: a slide round the subject is paced to turn the view no faster
const LOCK_ALIGN = 0.98;          // alignment (0..1) at which the view counts as on its subject

export function throttleToSpeed(t) {
  if (t <= THROTTLE_DEAD) return 0;
  const k = Math.min(1, (t - THROTTLE_DEAD) / (1 - THROTTLE_DEAD));
  return SPEED_MIN * (SPEED_MAX / SPEED_MIN) ** k;
}
export function speedToThrottle(v) {
  if (v <= 0) return 0;
  const k = Math.log(Math.max(v, SPEED_MIN) / SPEED_MIN) / Math.log(SPEED_MAX / SPEED_MIN);
  return THROTTLE_DEAD + clamp(k, 0, 1) * (1 - THROTTLE_DEAD);
}

/** Smooth stick response: precise near the centre, full rate at the edge. */
const curve = (s) => Math.sign(s) * Math.abs(s) ** 1.6;

export class Ship {
  constructor() {
    this.pos = [0, 0, 0];
    this.q = quat.identity();
    this.speed = 0;            // pc/s
    this.throttle = 0.5;
    this.speedScale = 1;       // throttle multiplier (< 1 near the Sun's planets)
    this.speedCap = Infinity;  // pc/s: hard limit under manual control, set near the Sun (solarSpeedCap)
    this.omega = [0, 0, 0];    // rad/s in camera axes: x pitch, y yaw, z roll
    this.steer = [0, 0];       // stick: x > 0 turns right, y > 0 pitches up
    this.rollInput = 0;        // -1..1, > 0 rolls the view clockwise
    this.boostHeld = false;
    this.boost = 0;            // smoothed 0..1
    this.level = true;         // keep `levelUp` at the top of the view when not steering
    this.levelUp = GALACTIC_NORTH;
    // { kind: 'star' | 'body' | 'point' | 'dir', pos?, dir?, name?, index?, id?, stop?,
    //   locate?: () => pos, face?: pos, locateFace?: () => pos, arrive?: pc }
    this.target = null;
    this.autopilot = false;    // true: also controls speed and parks at the target
    this.lastManualRoll = -1e9;
    this.time = 0;
    this.events = [];
    this.heading = [0, 0, -1]; // unit direction of travel (world); the view direction except on autopilot
    this.lookPrev = null;      // where the autopilot's subject was last frame (unit, world)
  }

  get forward() { return quat.rotate(this.q, [0, 0, -1]); }
  get up() { return quat.rotate(this.q, [0, 1, 0]); }
  get boostFactor() { return 1 + (BOOST_FACTOR - 1) * this.boost ** 1.5; }
  get targetSpeed() { return throttleToSpeed(this.throttle) * this.speedScale * this.boostFactor; }

  /** Face `dir` with `up` as close to `upHint` as possible. */
  lookAlong(dir, upHint = this.levelUp) {
    this.q = quat.lookRotation(dir, upHint);
    this.omega = [0, 0, 0];
  }

  setTarget(target, autopilot = false) {
    this.target = target;
    this.autopilot = autopilot && !!target && target.kind !== 'dir';
    this.lookPrev = null;
  }

  /**
   * Fly home. With a parking point (pc) the ship travels there with the Sun held in view;
   * without one it stops SOL_STOP short of the Sun on its current line of approach.
   */
  goHome(park = null) {
    if (park) this.setTarget({ kind: 'point', pos: park, face: [0, 0, 0], name: 'Sol', home: true, stop: 0, arrive: 1e-7 }, true);
    else this.setTarget({ kind: 'point', pos: [0, 0, 0], name: 'Sol', home: true, stop: SOL_STOP }, true);
  }

  cancelTarget() { this.target = null; this.autopilot = false; this.lookPrev = null; }

  /** Direction (world) and distance to the current target; moving targets are re-located. */
  aim(positionOf) {
    const t = this.target;
    if (!t) return null;
    if (t.kind === 'dir') return { dir: t.dir, dist: Infinity };
    if (t.locate) t.pos = t.locate();
    else if (t.kind === 'star' && positionOf) t.pos = positionOf(t.index);
    const d = v3.sub(t.pos, this.pos);
    const dist = v3.len(d);
    return { dir: dist > 0 ? v3.scale(d, 1 / dist) : this.forward, dist };
  }

  update(dt, positionOf) {
    this.time += dt;
    const manual = Math.abs(this.steer[0]) > 0.02 || Math.abs(this.steer[1]) > 0.02;
    if (manual && this.target) this.cancelTarget();
    if (Math.abs(this.rollInput) > 0.02) this.lastManualRoll = this.time;

    // ---- desired angular velocity (camera axes)
    let wx = TURN_RATE * curve(this.steer[1]);
    let wy = -TURN_RATE * curve(this.steer[0]);
    let alignCos = 1;
    const aim = this.aim(positionOf);
    // Where to look: at the target, or on autopilot at the subject it is being flown to see.
    let look = aim ? aim.dir : null, subject = null;
    if (aim && this.autopilot) {
      const t = this.target, p = t.locateFace ? t.locateFace() : t.face;
      const d = p ? v3.sub(p, this.pos) : null, l = d ? v3.len(d) : 0;
      if (l > 0) { look = v3.scale(d, 1 / l); subject = p; }
    }
    if (look) {
      const local = quat.rotate(quat.conj(this.q), look);  // in camera axes
      alignCos = clamp(-local[2], -1, 1);
      const angle = Math.acos(alignCos);
      // rotation axis taking -z onto `local`: (-z) x local = (local.y, -local.x, 0)
      const ax = local[1], ay = -local[0], al = Math.hypot(ax, ay);
      if (al > 1e-9) {
        const rate = Math.min(TURN_RATE, AIM_GAIN * angle);
        wx = (ax / al) * rate;
        wy = (ay / al) * rate;
      } else if (alignCos < 0) {
        wy = TURN_RATE; // directly behind: pick a side
      }
      if (subject) {
        // The subject drifts across the view as the ship slides past it: turn with it, so
        // the proportional term above only has the remaining error to close.
        if (this.lookPrev && dt > 0) {
          const w = quat.rotate(quat.conj(this.q), v3.scale(v3.cross(this.lookPrev, look), 1 / dt));
          const rate = Math.hypot(w[0], w[1]), k = rate > LOOK_RATE_MAX ? LOOK_RATE_MAX / rate : 1;
          wx += w[0] * k;
          wy += w[1] * k;
        }
        this.lookPrev = look;
      }
      if (this.target.kind === 'dir' && angle < 0.004) this.cancelTarget();
    }
    let wz = -ROLL_RATE * this.rollInput;
    if (this.level && this.time - this.lastManualRoll > 1.5) {
      // Bank gently into turns and otherwise keep `levelUp` (galactic or ecliptic north) up.
      const g = quat.rotate(quat.conj(this.q), this.levelUp);
      const weight = clamp(Math.hypot(g[0], g[1]) * 1.4 - 0.15, 0, 1);
      const levelErr = Math.atan2(-g[0], g[1]);
      const bank = clamp(0.35 * this.omega[1], -0.5, 0.5);
      wz += 1.3 * (levelErr + bank) * weight;
    }
    const k = ease(dt, 0.14);
    this.omega[0] += (wx - this.omega[0]) * k;
    this.omega[1] += (wy - this.omega[1]) * k;
    this.omega[2] += (clamp(wz, -ROLL_RATE, ROLL_RATE) - this.omega[2]) * k;
    this.q = quat.normalize(quat.mul(this.q, quat.fromRotationVector(v3.scale(this.omega, dt))));

    // ---- speed
    this.boost += ((this.boostHeld ? 1 : 0) - this.boost) * ease(dt, this.boostHeld ? 0.35 : 0.6);
    let want = this.targetSpeed;
    let limit = Infinity;   // the autopilot's braking curve: never exceeded, so it cannot overshoot
    let steer = 0;          // 0: travelling where the ship looks, 1: straight at the parking point
    if (this.autopilot && aim) {
      const t = this.target;
      const remaining = aim.dist - (t.stop || 0);
      // Cruise fast enough to arrive in ~8 s (never slower than the throttle), brake at a
      // constant rate, then close the last stretch logarithmically so arrivals look the
      // same from 2,000 light-years or from 2,000 km. Only accelerate once facing the target.
      if (t.cruise === undefined) {
        t.cruise = clamp(Math.max(want, remaining / 8), 1e-16, SPEED_MAX * BOOST_FACTOR);
        // within 1 % of the parking distance, or float64 resolution at the target
        t.arrive = t.arrive ?? Math.max((t.stop || 0) * 0.01, v3.len(t.pos) * 1e-13, 1e-14);
      }
      const decel = t.cruise / 2.5;
      const cruise = t.cruise * this.boostFactor;
      const r = Math.max(remaining, 0);
      const align = clamp((alignCos - 0.94) / (1 - 0.94), 0, 1) ** 2;
      // Sliding round the subject by an angle a turns the view at up to tan(a / 2) / (2 tail):
      // a wide slide gets a longer tail so that stays a glide.
      let tail = TAIL;
      if (subject) {
        const s = v3.sub(subject, t.pos), sl = v3.len(s);
        const c = sl > 0 ? clamp(v3.dot(aim.dir, s) / sl, -1, 1) : 1;
        tail = clamp(Math.sqrt((1 - c) / (1 + c + 1e-9)) / (2 * SLIDE_RATE), TAIL, 3 * TAIL);
      }
      limit = Math.min(cruise, Math.sqrt(2 * decel * r), r / tail);
      limit = Math.min(limit, (0.85 * r) / Math.max(dt, 1 / 240)); // never step past the parking point
      want = limit * align;
      if (subject) {
        // Until the view is on the subject the ship keeps going where it looks; from then
        // on it heads for the parking point however far that is from the line of sight.
        if (align >= LOCK_ALIGN) t.locked = true;
        steer = t.locked ? 1 : align;
      }
      if (remaining < t.arrive) {
        this.events.push({ type: 'arrived', target: t });
        this.speed = 0;
        this.throttle = 0;
        // Parked: hold the view on what we came to see (it is already there after a slide).
        const p = t.locateFace ? t.locateFace() : t.face;
        const face = p ? v3.sub(p, this.pos) : aim.dir;
        const fl = v3.len(face);
        this.setTarget({ kind: 'dir', dir: fl > 0 ? v3.scale(face, 1 / fl) : this.forward });
        want = 0;
        limit = 0;
      }
    }
    if (this.speed > limit) this.speed = limit; // the braking curve is already smooth; lagging it would overshoot
    if (want <= 0) {
      this.speed *= Math.exp(-dt / 0.35);
      if (this.speed < 1e-16) this.speed = 0;
    } else if (want !== this.speed) {
      // Eases towards the wanted speed in log space, up or down: a ship still turning onto
      // its target sheds its old speed over a moment instead of stopping dead.
      const from = Math.max(this.speed, want * 0.02);
      const tau = this.autopilot ? 0.35 : this.boostHeld ? 0.3 : 0.55;
      this.speed = Math.min(limit, Math.exp(Math.log(from) + (Math.log(want) - Math.log(from)) * ease(dt, tau)));
    }
    // Near the Sun the ship drops out of warp rather than coasting through the planets.
    if (!this.autopilot && this.speed > this.speedCap) this.speed = this.speedCap;

    // ---- position (float64)
    let h = this.forward;
    if (steer > 0 && aim) {
      const d = aim.dir, k = 1 - steer;
      const m = [h[0] * k + d[0] * steer, h[1] * k + d[1] * steer, h[2] * k + d[2] * steer];
      const ml = v3.len(m);
      h = ml > 1e-6 ? v3.scale(m, 1 / ml) : d;
    }
    this.heading = h;
    const step = this.speed * dt;
    this.pos[0] += h[0] * step; this.pos[1] += h[1] * step; this.pos[2] += h[2] * step;
  }

  /** Orientation `tau` seconds ago, extrapolated from the current angular velocity. */
  orientationAgo(tau) {
    return quat.normalize(quat.mul(this.q, quat.fromRotationVector(v3.scale(this.omega, -tau))));
  }
}
