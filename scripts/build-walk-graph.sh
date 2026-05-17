#!/usr/bin/env bash
# Build tiles/walk_graph.bin from OSM PBF extracts for the basemap bbox.
#
# Pulls NY + CT + NJ from Geofabrik (cached locally), merges them, clips to
# $BASEMAP_BBOX, runs the Python pipeline, and splits the output into
# tiles/walk-graph.part-* chunks (committed; the assembled .bin is gitignored).
#
# Requires: osmium-tool, curl, md5sum, uv

set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck disable=SC1091
source scripts/bbox.env

CACHE=pipelines/cache
mkdir -p "$CACHE" tiles

STATES=("new-york" "connecticut" "new-jersey")
PBF_PATHS=()

for state in "${STATES[@]}"; do
  url="https://download.geofabrik.de/north-america/us/${state}-latest.osm.pbf"
  local_pbf="$CACHE/${state}-latest.osm.pbf"
  local_md5="$CACHE/${state}-latest.osm.pbf.md5"

  # Refresh checksums + file weekly (or on missing).
  if [[ ! -f "$local_pbf" || ! -f "$local_md5" ]]; then
    echo "downloading $state..."
    curl -fSL --retry 3 -o "$local_pbf" "$url"
    curl -fSL --retry 3 -o "$local_md5" "${url}.md5"
    (cd "$CACHE" && md5sum -c "$(basename "$local_md5")")
  else
    echo "using cached $local_pbf"
  fi
  PBF_PATHS+=("$local_pbf")
done

MERGED="$CACHE/merged.osm.pbf"
echo "merging ${#PBF_PATHS[@]} state PBFs..."
osmium merge -O -o "$MERGED" "${PBF_PATHS[@]}"

EXTRACT="$CACHE/ny-metro.osm.pbf"
echo "clipping to bbox $BASEMAP_BBOX..."
osmium extract --bbox "$BASEMAP_BBOX" -O -o "$EXTRACT" "$MERGED"

OUT=tiles/walk_graph.bin
echo "running Python pipeline → $OUT"
uv run --directory pipelines python walk_graph.py "$EXTRACT" "$(pwd)/$OUT"

# Sanity: node count should be in the expected range. If grossly off, fail.
SIZE=$(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT")
echo "walk_graph.bin size: $SIZE bytes"
if (( SIZE < 5_000_000 )); then
  echo "ERROR: walk_graph.bin suspiciously small ($SIZE bytes)" >&2
  exit 1
fi

# Chunk for GitHub's 100 MB per-file cap. Match the tiles/ chunking style.
echo "chunking..."
rm -f tiles/walk-graph.part-*
split -b 50M -a 2 "$OUT" tiles/walk-graph.part-
ls -lh tiles/walk-graph.part-*
