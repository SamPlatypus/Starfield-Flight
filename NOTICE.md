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

## Algorithms (re-implemented, no code copied)

- B−V to effective temperature: F. J. Ballesteros (2012), *New insights into black bodies*, EPL 97, 34008.
- CIE 1931 colour-matching functions: multi-lobe Gaussian fit of C. Wyman, P.-P. Sloan & P. Shirley (2013), JCGT 2(2).
- Gaia G − V from BP − RP: M. Riello et al. (2021), A&A 649, A3.
- BP − RP to effective temperature along the dwarf sequence: after E. Mamajek, *A Modern Mean Dwarf Stellar Color and Effective Temperature Sequence*.

## Software

[Capacitor](https://capacitorjs.com) (MIT) for the Android app, [Vite](https://vite.dev) (MIT) for
the build, [Playwright](https://playwright.dev) (Apache-2.0) for tests and icon rendering.
