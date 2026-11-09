#!/usr/bin/env bash
# Downloads the raw catalogues used to (re)generate public/data and public/sky.
# Only needed when rebuilding data; the app itself never goes online.
#
#   bash tools/fetch-sources.sh
#   node tools/build-stars.mjs
#   python3 tools/build-milkyway.py tools/raw/milkyway_2020_4k.exr public/sky
#
# The Yale Bright Star Catalogue extract lives in tools/sources/yale (copied from the
# Star-Sky repository, which builds it from the CDS V/50 catalogue).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p raw
cd raw

fetch() { echo "-> $2"; curl -fsSL --retry 3 -o "$2" "$1"; }

# AT-HYG v4.0, all stars to V = 10 plus everything within 100 ly (CC BY-SA 4.0).
# Git LFS object on Codeberg; sha256 a9ec5d51...
fetch https://codeberg.org/astronexus/athyg/media/branch/main/data/subsets/athyg_40_reduced_m10.csv.gz athyg_40_reduced_m10.csv.gz
echo "a9ec5d515d1222d5bf86e8e84e762cbd325938cc6bd4b0d8760327386fa7c151  athyg_40_reduced_m10.csv.gz" | sha256sum -c -

# Gaia Catalogue of Nearby Stars (Gaia Collaboration, Smart et al. 2021) from the GAVO
# data centre's TAP service (also at ESA as external.gaiaedr3_gcns_main_1).
echo "-> gcns_main.csv.gz"
curl -fsS --retry 3 "https://dc.zah.uni-heidelberg.de/tap/sync" \
  --data-urlencode "REQUEST=doQuery" --data-urlencode "LANG=ADQL" --data-urlencode "FORMAT=csv" \
  --data-urlencode "MAXREC=400000" \
  --data-urlencode "QUERY=SELECT source_id, ra, dec, parallax, parallax_error, phot_g_mean_mag, phot_bp_mean_mag, phot_rp_mean_mag, dist_50, gcns_prob, wd_prob, ruwe FROM gcns.main" \
  | gzip -9 > gcns_main.csv.gz
rows=$(gunzip -c gcns_main.csv.gz | wc -l)
[ "$rows" -gt 331000 ] || { echo "GCNS download looks truncated ($rows lines)"; exit 1; }

# NASA SVS Deep Star Maps 2020: Milky Way background without Hipparcos/Tycho stars.
fetch https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/milkyway_2020_4k.exr milkyway_2020_4k.exr

echo "done"
