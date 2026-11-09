// Persisted user settings (localStorage, works in the browser and the Android WebView).
const KEY = 'starfield-flight.settings.v1';

export const DEFAULTS = {
  throttle: 0.68,      // 0..1 (log speed scale, see flight.js): ~8 ly/s
  density: 0.5,        // 0..1 -> limiting magnitude
  blur: 0.45,          // motion blur / streak length
  milkyWay: 0.6,
  fov: 66,             // degrees across the shorter screen side
  gain: 1,
  labels: true,
  level: true,
  invertPitch: false,
  haptics: true,
  stats: false,
  lines: true,         // constellation stick figures
  conNames: false,     // constellation names (IAU abbreviations)
  orbits: true,        // Solar System orbits
  hintSeen: false,
  installDismissed: false,
};

// Solar System clock rates: [label, simulated seconds per real second].
export const TIME_RATES = [
  ['Paused', 0], ['Real time', 1], ['1 min/s', 60], ['1 hour/s', 3600], ['1 day/s', 86400],
  ['1 week/s', 604800], ['1 month/s', 2629800], ['1 year/s', 31557600],
];

// Density slider -> faintest apparent magnitude drawn. 6.5 is the naked-eye limit.
export const MAG_MIN = 4.5;
export const MAG_MAX = 10.5;
export const densityToMag = (d) => MAG_MIN + (MAG_MAX - MAG_MIN) * d;

export function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

let timer = 0;
export function saveSettings(s) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
  }, 300);
}
