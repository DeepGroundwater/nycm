#!/usr/bin/env bash
# Build tiles/pois.bin from the cached OSM PBF and pre-snap each POI to
# walk_graph.bin's largest connected component.
#
# Outputs tiles/pois.bin and chunks it to tiles/pois.part-* for GitHub's
# 100 MB per-file cap. The assembled .bin is gitignored; only the chunks ship.
#
# Requires: scripts/build-walk-graph.sh has been run (PBF + walk_graph.bin
# must exist locally).

set -euo pipefail
cd "$(dirname "$0")/.."

EXTRACT=pipelines/cache/ny-metro.osm.pbf
WG=tiles/walk_graph.bin
OUT=tiles/pois.bin

if [[ ! -f "$EXTRACT" ]]; then
  echo "ERROR: $EXTRACT not found. Run scripts/build-walk-graph.sh first." >&2
  exit 1
fi
if [[ ! -f "$WG" ]]; then
  echo "ERROR: $WG not found. Assemble from chunks or run scripts/build-walk-graph.sh first." >&2
  exit 1
fi

mkdir -p tiles

echo "extracting POIs..."
uv run --directory pipelines python pois.py \
  "$(pwd)/$EXTRACT" "$(pwd)/$WG" "$(pwd)/$OUT"

SIZE=$(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT")
echo "pois.bin size: $SIZE bytes"
if (( SIZE < 1000000 )); then
  echo "ERROR: pois.bin suspiciously small ($SIZE bytes)" >&2
  exit 1
fi
if (( SIZE > 30000000 )); then
  echo "ERROR: pois.bin suspiciously large ($SIZE bytes; allowlist may have leaked)" >&2
  exit 1
fi

echo "chunking..."
rm -f tiles/pois.part-*
split -b 50M -a 2 "$OUT" tiles/pois.part-
ls -lh tiles/pois.part-*
