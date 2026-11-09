// Ship: position (parsecs, equatorial J2000 frame centred on the Sun), orientation,
// speed and the steering / autopilot logic. Pure math, no DOM, so it is unit-testable.
import { quat, v3, clamp, ease, GALACTIC_NORTH } from './math.js';

export const SPEED_MIN = 0.003;   // pc/s at the bottom of the throttle (~0.01 ly/s)
export const SPEED_MAX = 60;      // pc/s at full throttle (~196 ly/s)
export const BOOST_FACTOR = 6;
const THROTTLE_DEAD = 0.02;       // bottom 2% of the throttle = all stop
const TURN_RATE = 1.1;            // rad/s at full stick
const ROLL_RATE = 1.6;            // rad/s
const AIM_GAIN = 2.4;             // 1/s, turn-to-target proportional gain
const SOL_STOP = 0.0153;          // pc (~3,000 AU): where the autopilot parks near the Sun

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
    this.omega = [0, 0, 0];    // rad/s in camera axes: x pitch, y yaw, z roll
    this.steer = [0, 0];       // stick: x > 0 turns right, y > 0 pitches up
    this.rollInput = 0;        // -1..1, > 0 rolls the view clockwise
    this.boostHeld = false;
    this.boost = 0;            // smoothed 0..1
    this.level = true;         // keep the galactic plane level when not steering
    this.target = null;        // { kind: 'sol' | 'star' | 'dir', pos?, dir?, name?, index?, stop? }
    this.autopilot = false;    // true: also controls speed and parks at the target
    this.lastManualRoll = -1e9;
    this.time = 0;
    this.events = [];
  }

  get forward() { return quat.rotate(this.q, [0, 0, -1]); }
  get up() { return quat.rotate(this.q, [0, 1, 0]); }
  get targetSpeed() { return throttleToSpeed(this.throttle) * (1 + (BOOST_FACTOR - 1) * this.boost ** 1.5); }

  /** Face `dir` with `up` as close to `upHint` as possible. */
  lookAlong(dir, upHint = GALACTIC_NORTH) {
    this.q = quat.lookRotation(dir, upHint);
    this.omega = [0, 0, 0];
  }

  setTarget(target, autopilot = false) {
    this.target = target;
    this.autopilot = autopilot && !!target && target.kind !== 'dir';
  }

  /** Steer towards the Sun and fly home. */
  goHome() {
    this.setTarget({ kind: 'sol', pos: [0, 0, 0], name: 'Sol', stop: SOL_STOP }, true);
  }

  cancelTarget() { this.target = null; this.autopilot = false; }

  /** Direction (world) and distance to the current target, refreshed from `positionOf` for stars. */
  aim(positionOf) {
    const t = this.target;
    if (!t) return null;
    if (t.kind === 'dir') return { dir: t.dir, dist: Infinity };
    if (t.kind === 'star' && positionOf) t.pos = positionOf(t.index);
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
    if (aim) {
      const local = quat.rotate(quat.conj(this.q), aim.dir);  // target in camera axes
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
      if (this.target.kind === 'dir' && angle < 0.004) this.cancelTarget();
    }
    let wz = -ROLL_RATE * this.rollInput;
    if (this.level && this.time - this.lastManualRoll > 1.5) {
      // Bank gently into turns and otherwise keep galactic north "up".
      const g = quat.rotate(quat.conj(this.q), GALACTIC_NORTH);
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
    let braking = false;
    if (this.autopilot && aim) {
      const t = this.target;
      const remaining = aim.dist - (t.stop || 0);
      // Cruise fast enough to arrive in ~8 s (never slower than the throttle), brake at a
      // constant rate over the last ~2.5 s, and only speed up once roughly facing the target.
      if (t.cruise === undefined) t.cruise = clamp(Math.max(want, remaining / 8), SPEED_MIN, SPEED_MAX * BOOST_FACTOR);
      const decel = t.cruise / 2.5;
      const cruise = t.cruise * (1 + (BOOST_FACTOR - 1) * this.boost ** 1.5);
      const r = Math.max(remaining, 0);
      // Turn first: no forward thrust until the nose is within ~20 degrees of the target.
      const align = clamp((alignCos - 0.94) / (1 - 0.94), 0, 1) ** 2;
      want = Math.min(cruise, Math.max(Math.sqrt(2 * decel * r), r / 0.6)) * align;
      want = Math.min(want, (0.85 * r) / Math.max(dt, 1 / 240)); // never step past the parking point
      braking = want < this.speed;
      if (remaining < 5e-5) {
        this.events.push({ type: 'arrived', target: t });
        this.speed = 0;
        this.throttle = 0;
        // Parked: finish turning so the target sits in the middle of the view.
        this.setTarget({ kind: 'dir', dir: aim.dir });
        want = 0;
      }
    }
    if (braking) {
      this.speed = want; // the braking curve is already smooth; lagging it would overshoot
    } else if (want <= 0) {
      this.speed *= Math.exp(-dt / 0.35);
      if (this.speed < 1e-5) this.speed = 0;
    } else {
      const from = Math.max(this.speed, SPEED_MIN * 0.25);
      const tau = this.autopilot ? 0.35 : this.boostHeld ? 0.3 : 0.55;
      this.speed = Math.exp(Math.log(from) + (Math.log(want) - Math.log(from)) * ease(dt, tau));
    }

    // ---- position (float64)
    const f = this.forward;
    const step = this.speed * dt;
    this.pos[0] += f[0] * step; this.pos[1] += f[1] * step; this.pos[2] += f[2] * step;
  }

  /** Orientation `tau` seconds ago, extrapolated from the current angular velocity. */
  orientationAgo(tau) {
    return quat.normalize(quat.mul(this.q, quat.fromRotationVector(v3.scale(this.omega, -tau))));
  }
}
