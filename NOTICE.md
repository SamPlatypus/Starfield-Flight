# Third-party data, imagery and algorithms

Starfield Flight bundles the following. None of it is fetched at run time; the app makes no
network requests.

## Star catalogue (`public/data/stars.bin`, `public/data/names.json`)

Built by `tools/build-stars.mjs` from:

| Data | Source | Terms |
| --- | --- | --- |
| Positions, V magnitudes, B−V colours, spectral types, Bayer/Flamsteed designations of the 8,404 stars to V = 6.5 | *The Bright Star Catalogue*, 5th revised ed., D. Hoffleit & W. H. Warren Jr. (1991), Yale University Observatory (CDS V/50), as extracted by the [Star-Sky](https://github.com/SamPlatypus/Star-Sky) app (`tools/sources/yale`) | Free to use with acknowledgement |
| Proper star names | *IAU Catalog of Star Names*, IAU Working Group on Star Names | CC BY 4.0 |
| Distances for the Yale stars, and 321,064 further stars (Hipparcos / Tycho-2 to V = 10 plus everything within 100 ly) | **AT-HYG v4.0**, reduced m10 subset, by David Nash / astronexus, <https://codeberg.org/astronexus/athyg> | **CC BY-SA 4.0** |
| … whose distances come from | **Gaia DR3** (Gaia Collaboration, Vallenari et al. 2023), ESA/Gaia/DPAC; the **Hipparcos** catalogue (ESA 1997) and its new reduction (F. van Leeuwen 2007); the Gliese–Jahreiß catalogue | Credit ESA/Gaia/DPAC; free to use with acknowledgement |
| 296,198 faint stars within 100 pc | **Gaia Catalogue of Nearby Stars** (Gaia Collaboration, Smart et al. 2021, A&A 649, A6), from Gaia EDR3, ESA/Gaia/DPAC, retrieved from the GAVO data centre (Heidelberg) TAP service | Credit ESA/Gaia/DPAC and the paper |

Because AT-HYG is licensed CC BY-SA 4.0, the derived files `public/data/stars.bin` and
`public/data/names.json` are also made available under the
[Creative Commons Attribution-ShareAlike 4.0 International License](https://creativecommons.org/licenses/by-sa/4.0/).
Changes made: catalogues merged and de-duplicated, Gaia photometry converted to Johnson V and
B−V, positions converted to a quantised octree format.

## Milky Way (`public/sky/*.jpg`)

*Deep Star Maps 2020*, Milky Way background without the Hipparcos and Tycho stars
(`milkyway_2020_4k.exr`), resampled to a cube map by `tools/build-milkyway.py`.
Credit: **NASA/Goddard Space Flight Center Scientific Visualization Studio. Gaia DR2: ESA/Gaia/DPAC.**
Visualization by Ernie Wright (USRA). <https://svs.gsfc.nasa.gov/4851>

## Search index and constellation figures (`public/data/search.json`, `public/data/constellations.json`)

Built by `tools/build-stars.mjs`. Names and designations come from the sources above (IAU names,
Bayer and Flamsteed designations and HR numbers from the Bright Star Catalogue, Gliese numbers
from AT-HYG). The constellation stick figures are from
[d3-celestial](https://github.com/ofrohn/d3-celestial) by Olaf Frohn (BSD-3-Clause, licence text
below), as matched to Yale stars by Star-Sky, re-pointed at the 3D catalogue.

## Solar System

Positions, sizes and rotation of the Sun, planets and moons are computed in the app from
published theories (re-implemented, no code copied):

- Planets: E. M. Standish, *Keplerian Elements for Approximate Positions of the Major Planets*
  (JPL Solar System Dynamics), with P. Schlyter's perturbation terms for Jupiter, Saturn and Uranus
  (*How to compute planetary positions*).
- The Moon: J. Meeus, *Astronomical Algorithms* (2nd ed., 1998), chapter 47 (ELP-2000/82 truncated).
- Io, Europa, Ganymede, Callisto and Titan: *Planetary Satellite Mean Elements* (JPL Solar System
  Dynamics), in their Laplace planes.
- Radii, flattening, poles and prime meridians: IAU Working Group on Cartographic Coordinates and
  Rotational Elements, *Report 2015* (B. A. Archinal et al. 2018, Celest. Mech. Dyn. Astr. 130, 22).
- Visual magnitudes: Meeus chapter 41 and A. Mallama & J. L. Hilton (2018), *Computing apparent
  planetary magnitudes for The Astronomical Almanac*.
- ΔT: observed values (IERS) joined to L. V. Morrison & F. R. Stephenson (2004).

The test suite compares these with [astronomy-engine](https://github.com/cosinekitty/astronomy)
(MIT licence), a development dependency only; it is not shipped with the app.

## Algorithms (re-implemented, no code copied)

- B−V to effective temperature: F. J. Ballesteros (2012), *New insights into black bodies*, EPL 97, 34008.
- CIE 1931 colour-matching functions: multi-lobe Gaussian fit of C. Wyman, P.-P. Sloan & P. Shirley (2013), JCGT 2(2).
- Gaia G − V from BP − RP: M. Riello et al. (2021), A&A 649, A3.
- BP − RP to effective temperature along the dwarf sequence: after E. Mamajek, *A Modern Mean Dwarf Stellar Color and Effective Temperature Sequence*.

## Software

[Capacitor](https://capacitorjs.com) (MIT) for the Android app, [Vite](https://vite.dev) (MIT) for
the build, [Playwright](https://playwright.dev) (Apache-2.0) for tests and icon rendering.

## d3-celestial licence

```
Copyright (c) 2015, Olaf Frohn
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
