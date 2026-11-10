// The hand-off between interstellar flight and the Solar System, worked out once per frame
// from how far the ship is from the Sun. Everything that changes on the way in or out reads
// it from here, so the pieces move together and nothing keeps a threshold of its own:
//
//   fade     0..1  the Sun's neighbourhood, 0.2 -> 0.08 light-years: the Sun and planets
//                  exist, the throttle changes from light-years to the distance of the
//                  nearest body
//   system   0..1  the planets resolve, 2,000 -> 150 AU: their orbits grow from a speck to
//                  filling the view. Smooth in log distance, as everything about an
//                  approach is (each second covers the same fraction of what is left)
//   level    0..1  how far the view's level has swung from the galactic plane to the
//                  planets' plane, 60 degrees apart. It follows `system`, never faster than
//                  LEVEL_RATE; an autopilot arrival crosses that whole range in about a
//                  second, so on autopilot it sets off for the destination's level as soon
//                  as the trip starts and the view has long settled when the ship arrives
//   sky      0..1  how far the starfield has stepped back to let the planets read (fewer
//                  faint stars, a dimmer Milky Way). It follows `system` too, never faster
//                  than SKY_RATE, so stars thin out one by one as the orbits open instead
//                  of vanishing together at the edge of the neighbourhood
//   state          where the ship is, with hysteresis so it cannot flicker at an edge:
//                  'interstellar'  beyond the Sun's neighbourhood
//                  'approach'      inside it, still outside the planets
//                  'system'        arrived: inside the Solar System proper
//                  'body'          in the neighbourhood of `host`, moving with it
//
// Pure: no DOM, no rendering. A change of state is queued in `events`.
import { solarIntensity, SOLAR_OUTER_PC, AU_PER_PC } from './system.js';

export const SYSTEM_FAR_AU = 2000;   // the planets' orbits are a speck: `system` starts to rise
export const SYSTEM_NEAR_AU = 150;   // Neptune's orbit spans a third of the view: `system` is 1
export const VOLUME_AU = 60;         // the Solar System proper: just outside Pluto's orbit
export const NEIGHBOURHOOD_AU = SOLAR_OUTER_PC * AU_PER_PC; // ~12,650 AU, where the ship drops out of warp
export const LEAVE = 1.25;           // a zone is left this many times further out than it was entered
export const LEVEL_RATE = 0.25;      // 1/s: the 60-degree swing of the level takes at least 4 s
export const SKY_RATE = 0.4;         // 1/s: the starfield takes at least 2.5 s to step back or return

const smooth = (t) => { const c = Math.min(1, Math.max(0, t)); return c * c * (3 - 2 * c); };

/** 0 at `far` AU and beyond, 1 at `near` AU and within, smooth in log distance. */
export const logRamp = (dAU, far, near) => smooth(Math.log(far / Math.max(dAU, 1e-12)) / Math.log(far / near));

const ZONES = ['interstellar', 'approach', 'system'];
const ENTER = [Infinity, NEIGHBOURHOOD_AU, VOLUME_AU]; // a zone is entered inside this distance

export class SolarTransition {
  constructor(dSunPc = Infinity) {
    this.events = [];
    this.reset(dSunPc);
  }

  /** Puts the ship somewhere new at once (start-up, a jump): nothing eases, nothing is announced. */
  reset(dSunPc = Infinity, host = null) {
    this.zone = 0;
    this.measure(dSunPc);
    this.level = this.system;
    this.sky = this.system;
    while (this.zone < 2 && this.dAU < ENTER[this.zone + 1]) this.zone++;
    this.host = host;
    this.settle();
    this.events.length = 0;
    return this;
  }

  measure(dSunPc) {
    this.dAU = dSunPc * AU_PER_PC;
    this.fade = solarIntensity(dSunPc);
    this.system = logRamp(this.dAU, SYSTEM_FAR_AU, SYSTEM_NEAR_AU);
  }

  settle() {
    this.state = this.host ? 'body' : ZONES[this.zone];
    this.near = this.zone > 0 || !!this.host;      // the Sun and planets exist around the ship
    this.arrived = this.zone === 2 || !!this.host; // inside the Solar System proper
  }

  /**
   * @param dSunPc distance from the Sun (pc)
   * @param host   the body whose neighbourhood the ship is in (SolarSystem.frameBody), or null
   * @param dt     seconds since the last update
   * @param bound  where an autopilot trip ends: 1 in the Solar System, -1 among the stars,
   *               0 when flying by hand
   */
  update(dSunPc, host = null, dt = 0, bound = 0) {
    this.measure(dSunPc);
    const step = LEVEL_RATE * dt;
    const level = bound > 0 ? 1 : bound < 0 ? 0 : this.system;
    this.level += Math.min(step, Math.max(-step, level - this.level));
    const fade = SKY_RATE * dt;
    this.sky += Math.min(fade, Math.max(-fade, this.system - this.sky));
    // Zones nest, so a jump across several is walked one edge at a time.
    let zone = this.zone;
    while (zone < 2 && this.dAU < ENTER[zone + 1]) zone++;
    while (zone > 0 && this.dAU > ENTER[zone] * LEAVE) zone--;
    const from = this.state, fromHost = this.host;
    this.zone = zone;
    this.host = host;
    this.settle();
    if (this.state !== from || host !== fromHost) this.events.push({ type: 'state', from, to: this.state, fromHost, host });
    return this;
  }
}
