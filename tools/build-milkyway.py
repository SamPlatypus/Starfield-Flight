#!/usr/bin/env python3
"""Bakes the NASA SVS "Deep Star Maps 2020" Milky Way background into a cubemap.

    python3 tools/build-milkyway.py tools/raw/milkyway_2020_4k.exr public/sky

The source (milkyway_2020_4k.exr, 4096x2048, linear half-float RGB, plate carree in
ICRF/J2000 equatorial coordinates with right ascension increasing to the left) is the
version of the map that omits the Hipparcos and Tycho stars: the unresolved glow of the
Galaxy plus faint Gaia DR2 stars. The app draws the bright stars itself, in 3D.

Output: six sRGB JPEG faces (px, nx, py, ny, pz, nz) in the OpenGL cube map convention,
for a world frame where +x points to RA 0h / Dec 0, +y to RA 6h / Dec 0 and +z to the
north celestial pole (the same frame as the star catalogue). Needs numpy, Pillow and
OpenEXR (pip install numpy pillow OpenEXR).
"""
import sys
import numpy as np
import OpenEXR
from PIL import Image

SIZE = 1024      # face size: 0.088 deg per pixel, the source's own resolution
SUPER = 3        # supersampling per axis

# Direction for each face from cube-map coordinates sc, tc in [-1, 1] (OpenGL convention:
# texture row 0 is t = 0, which is how WebGL uploads image row 0).
FACES = {
    'px': lambda sc, tc: (np.ones_like(sc), -tc, -sc),
    'nx': lambda sc, tc: (-np.ones_like(sc), -tc, sc),
    'py': lambda sc, tc: (sc, np.ones_like(sc), tc),
    'ny': lambda sc, tc: (sc, -np.ones_like(sc), -tc),
    'pz': lambda sc, tc: (sc, -tc, np.ones_like(sc)),
    'nz': lambda sc, tc: (-sc, -tc, -np.ones_like(sc)),
}


def srgb_encode(x):
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def sample_equirect(img, ra, dec):
    """Bilinear sample with RA wrap. ra, dec in radians."""
    h, w, _ = img.shape
    col = (0.5 - ra / (2 * np.pi)) * w - 0.5     # RA 0h at the centre, increasing to the left
    row = (0.5 - dec / np.pi) * h - 0.5
    c0 = np.floor(col).astype(np.int64)
    r0 = np.floor(row).astype(np.int64)
    fc = (col - c0)[..., None]
    fr = (row - r0)[..., None]
    c1 = c0 + 1
    r1 = np.clip(r0 + 1, 0, h - 1)
    r0 = np.clip(r0, 0, h - 1)
    c0 %= w
    c1 %= w
    top = img[r0, c0] * (1 - fc) + img[r0, c1] * fc
    bot = img[r1, c0] * (1 - fc) + img[r1, c1] * fc
    return top * (1 - fr) + bot * fr


def main(src, out_dir):
    img = OpenEXR.File(src).channels()['RGB'].pixels.astype(np.float32)
    print('source', img.shape, 'max', float(img.max()))
    n = SIZE * SUPER
    t = (np.arange(n) + 0.5) / n * 2 - 1
    sc, tc = np.meshgrid(t, t)  # sc varies along columns, tc along rows
    for name, fn in FACES.items():
        x, y, z = fn(sc, tc)
        r = np.sqrt(x * x + y * y + z * z)
        ra = np.arctan2(y, x)
        dec = np.arcsin(z / r)
        face = sample_equirect(img, ra, dec)
        face = face.reshape(SIZE, SUPER, SIZE, SUPER, 3).mean(axis=(1, 3))
        rgb = (srgb_encode(face) * 255 + 0.5).astype(np.uint8)
        path = f'{out_dir}/{name}.jpg'
        Image.fromarray(rgb).save(path, quality=88, optimize=True, progressive=False, subsampling=2)
        print('wrote', path)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
