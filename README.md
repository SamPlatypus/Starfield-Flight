# Starfield Flight

Fly at warp speed through **625,664 real stars in 3D**: every point sits at its catalogued
3D position, and its brightness and colour come from the catalogue and from your distance to it.
A small gold marker always points to **Sol**, so you can find your way home. It runs at 60 fps
on phones, fully offline, as an Android app (APK) or an installable web app.

| Leaving the Solar System | Boost | 2,300 light-years out | Home |
| --- | --- | --- | --- |
| ![Cruising towards Orion](docs/cruise.jpg) | ![Boost streaks](docs/boost.jpg) | ![Far from home](docs/far.jpg) | ![Arriving at the Sun](docs/home.jpg) |

## Install

**Android:** open the latest [release](https://github.com/SamPlatypus/Starfield-Flight/releases/latest)
on your phone, download `starfield-flight.apk`, open it and allow installing from that source
when Android asks. Every push to this repository builds and publishes a new signed APK that
installs as an update.

**Web / iPhone / desktop:** once GitHub Pages is enabled (see [CI](#ci-and-releases)) open the
site and tap **Install app** (the pill at the top, or Menu → Install). Chrome and Edge install it
as a full-screen app; on iPhone use Share → Add to Home Screen. After the first visit it works
with no connection. The same menu has a **Download Android APK** button.

## Flying

| Do this | To |
| --- | --- |
| Drag anywhere | Steer like a joystick: the further from where your finger went down, the faster you turn |
| Tap a star | Turn towards it, see its name, distance, brightness and luminosity, and **Fly here** |
| Tap empty sky | Turn towards that point |
| Press and hold (or ⚡) | **Boost**: 6× speed, wider view, longer streaks |
| Pinch | Change speed |
| Twist two fingers | Roll |
| Speed slider (left) | Throttle, from all stop to ~200 light-years per second (logarithmic) |
| Density slider (right) | How faint a star you can see: limiting magnitude 4.5 (sparse) to 10.5 (dense) |
| Tap the **SOL** marker | Autopilot home: turns, accelerates, and parks 3,000 AU from the Sun |
| Menu (⋯) | Fly home, jump to a random star, all stop, hide controls, motion blur, Milky Way, field of view, star names, install |

Keyboard: WASD or arrows steer, Q/E roll, Space or Shift boost, + / − speed, [ ] density,
H home, M menu, C hide controls, L star names.

Controls fade to near-invisible after a few seconds; the view keeps the plane of the Milky Way
level (turn this off in the menu for free flight) and banks gently into turns.

## What makes it real

- **Positions:** the [Yale Bright Star Catalogue](https://github.com/SamPlatypus/Star-Sky) used by
  Star Sky (all 8,404 stars to V = 6.5, with IAU names, Bayer/Flamsteed designations, V magnitudes,
  B−V colours and spectral types) is matched one-to-one (HR number, position, magnitude) to
  [AT-HYG v4.0](https://codeberg.org/astronexus/athyg), which supplies each star's distance from
  **Gaia DR3** or the **Hipparcos** new reduction: 8,398 Yale stars get a measured distance. Three
  hot stars whose parallaxes are unusable, among them Polis (μ Sgr), are placed by spectroscopic
  parallax and flagged as estimated in their info card; the recurrent nova T CrB and two Mira
  variables, which Yale lists at maximum light, are left out. AT-HYG adds the remaining 321,064
  Hipparcos/Tycho-2 stars to V = 10, and the **Gaia Catalogue of Nearby Stars** adds 296,198 faint
  neighbours (red and white dwarfs) to complete the census within 100 parsecs.
- **Brightness:** every frame, each star's apparent magnitude is computed from its absolute
  magnitude and its true distance to you, `m = M + 5 log10(d / 10 pc)`. From the Sun the sky
  reproduces the catalogue: Sirius −1.46, Canopus −0.72, Arcturus −0.04, Vega 0.03… Fly 8 light-years
  out and Sirius is a blazing −4.
- **Colour:** B−V → effective temperature (Ballesteros 2012) → the colour of a blackbody at that
  temperature through the CIE 1931 colour-matching functions → sRGB. Betelgeuse is orange, Rigel
  blue-white, the Sun a warm white.
- **Milky Way:** the unresolved glow of the Galaxy from NASA's *Deep Star Maps 2020* (the version
  with the Hipparcos and Tycho stars removed, since those are drawn in 3D), as a seamless cube map.
- The tests check distances (Sirius 2.64 pc, Betelgeuse 152.7 pc, Proxima 1.30 pc…), the sky from
  the Sun against the Yale magnitudes, the count of stars brighter than V 4, and that culling never
  drops a visible star.

Distances are only as good as the parallaxes: the bright giants beyond ~500 pc have large
uncertainties, and far from the Sun the catalogues only contain stars that are bright as seen
from Earth, so the sky thins out the further you go. The census within 100 pc is complete down to
the faintest red dwarfs.

## How it stays at 60 fps

- **No vertex buffers.** The catalogue lives in one RGBA32F texture (position in parsecs plus
  packed colour and absolute magnitude); `gl_VertexID / 6` picks a star and `% 6` a corner of its
  quad, so any contiguous range of stars is one draw call (`WEBGL_multi_draw` when available).
- **Magnitude-band octrees.** Stars are grouped into 1-magnitude bands of absolute magnitude, each
  with its own octree. A band is only searched within the distance where its brightest member
  can still be seen (`10^((m_lim − M + 5)/5)` pc), so faint red dwarfs come from the few nodes
  around you while supergiants come from the whole Galaxy, and nodes outside the view frustum
  (swept by the streak length, so stars that just flew past still draw their tails) are skipped.
  Typically 30,000–40,000 of the 625,664 stars are sent to the GPU.
- **Streaks are real motion blur.** Each star is a capsule from where it was a fraction of a second
  ago to where it is now, computed from the ship's velocity and rotation. Its light spreads along
  the streak; boosting lengthens the exposure.
- **Precision:** the ship's position is float64 in JavaScript; the GPU gets it as a float32
  high/low pair, so `(star − high) − low` stays exact near any star, even 3,000 pc from the Sun.
- **Adaptive quality:** a governor watches frame times and lowers render resolution first, then
  the faintest magnitude drawn, if a device cannot hold 60 fps, and gives quality back when there
  is headroom. The canvas is capped at 2× device pixels.
- Nothing allocates per star per frame, the HUD moves with compositor-only transforms, the app
  pauses in the background, and WebGL context loss is recovered.

## Development

```sh
npm install
npm run dev          # Vite dev server
npm test             # unit tests (catalogue accuracy, culling, flight model, colours)
npm run build        # production build in dist/ + offline service worker
npm run test:e2e     # headless Chromium: rendering, touch controls, autopilot, offline start
```

Append `?stats` to the URL (or enable *Performance overlay* in the menu) to see frame rate, stars
submitted and draw calls; `?fixed` pins the render quality.

### Android

Requires JDK 21 and the Android SDK (platform 36, build-tools 36).

```sh
npm run android:sync                      # build the web app and copy it into android/
cd android && ./gradlew assembleRelease   # -> app/build/outputs/apk/release/app-release.apk
```

The Android shell is Capacitor 8: sticky immersive full screen, screen kept on while flying,
edge-to-edge under display cutouts, haptics on boost and arrival, back button closes panels.

### Signing

Release APKs are signed with `ANDROID_KEYSTORE_FILE` / `ANDROID_KEYSTORE_PASSWORD` /
`ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` when set, otherwise with the development key in
`android/keystore/` so that every build from this repository installs and updates out of the box.
That key is public. To sign with your own key, create one and add it as repository secrets:

```sh
keytool -genkeypair -keystore release.p12 -storetype PKCS12 -alias starfield -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 release.p12    # -> secret ANDROID_KEYSTORE_BASE64
```

plus `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`. Android only
installs updates signed with the same key, so uninstall a dev-key build once after switching.

### CI and releases

`.github/workflows/build.yml` runs on every push:

1. **web** – unit tests, production build, end-to-end tests in headless Chromium (screenshots
   are kept as an artifact);
2. **android** – Capacitor sync and Gradle release build, signature check, then the APK is
   uploaded as an artifact and published as a GitHub Release `v1.0.<run>` with
   `starfield-flight.apk` (the in-app download link always points at the latest one);
3. **pages** – deploys the installable offline web app to GitHub Pages. Enable it once in
   *Settings → Pages → Source: GitHub Actions*; until then the job just leaves a notice.

### Rebuilding the data

```sh
bash tools/fetch-sources.sh        # AT-HYG, GCNS (Gaia TAP), NASA Milky Way map -> tools/raw/
node tools/build-stars.mjs         # -> public/data/stars.bin, names.json
pip install numpy pillow OpenEXR
python3 tools/build-milkyway.py tools/raw/milkyway_2020_4k.exr public/sky
node tools/make-icons.mjs          # app icons (PWA + Android)
```

`tools/sources/yale/` holds the Yale extract from Star-Sky. The build prints how every source
was merged (matches, double-star components folded into Yale's combined magnitudes, duplicates
removed) and the quantisation error of the compressed positions (< 800 AU).

## Project layout

```
index.html, src/styles.css   app shell, HUD and controls
src/app.js                   loading, frame loop, commands
src/catalog.js               decoder for public/data/stars.bin
src/culling.js               magnitude-band octree + frustum culling
src/flight.js                ship physics, steering, levelling, boost, autopilot
src/render/                  WebGL2 renderer, shaders, blackbody colours
src/hud.js, src/controls.js, src/input.js   markers, labels, sliders, touch/mouse/keys
src/perf.js                  frame-rate governor
src/install.js, src/platform.js   PWA install / APK link, Capacitor bridges
public/data, public/sky      generated star catalogue and Milky Way cube map
android/                     Capacitor Android project (Gradle)
tools/                       data, icon and service-worker builders
test/                        unit tests and the end-to-end test
```

## Credits

Star data and imagery, with their licences, are listed in [NOTICE.md](NOTICE.md). The star data
files in `public/data` are derived from AT-HYG and are shared under CC BY-SA 4.0.
