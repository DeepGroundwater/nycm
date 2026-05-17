#!/usr/bin/env bash
# Extract NYC metro basemap tiles from the Protomaps daily global build.
# Output: tiles/nyc-metro.pmtiles  (single file, range-requestable by MapLibre)
#
# Requires: `pmtiles` CLI from https://github.com/protomaps/go-pmtiles
#   macOS:   brew install protomaps/tap/pmtiles
#   Linux:   download release binary from the GH releases page
#
# Uses HTTP range requests against the source — does NOT download the full ~110GB build.

set -euo pipefail

cd "$(dirname "$0")/.."

# Source the shared basemap bbox (single source of truth).
# shellcheck disable=SC1091
source "$(dirname "$0")/bbox.env"
BBOX="$BASEMAP_BBOX"
MAXZOOM="$BASEMAP_MAXZOOM"

# Protomaps publishes a fresh daily build at a stable rolling URL.
SRC="https://build.protomaps.com/$(date -u +%Y%m%d).pmtiles"

mkdir -p tiles
pmtiles extract "$SRC" tiles/nyc-metro.pmtiles \
  --bbox="$BBOX" \
  --maxzoom="$MAXZOOM"

pmtiles show tiles/nyc-metro.pmtiles
ls -lh tiles/nyc-metro.pmtiles

# Split into <=50MB chunks so each part stays well under GitHub's 100MB per-file limit.
# Parts are committed; the assembled file is gitignored and rebuilt by scripts/assemble-tiles.sh
# at server start (local) or before Pages deploy (CI).
rm -f tiles/nyc-metro.pmtiles.part-*
split -b 50M -a 2 tiles/nyc-metro.pmtiles tiles/nyc-metro.pmtiles.part-
ls -lh tiles/nyc-metro.pmtiles.part-*
