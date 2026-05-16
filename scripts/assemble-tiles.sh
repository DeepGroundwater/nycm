#!/usr/bin/env bash
# Reassemble tiles/nyc-metro.pmtiles from its committed chunks.
# Idempotent: only assembles when the full file is missing or older than any part.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=tiles/nyc-metro.pmtiles
PARTS=(tiles/nyc-metro.pmtiles.part-*)

if [[ ${#PARTS[@]} -eq 0 || ! -e "${PARTS[0]}" ]]; then
  echo "no chunks found at tiles/nyc-metro.pmtiles.part-* — run scripts/extract-tiles.sh first" >&2
  exit 1
fi

needs_rebuild=0
if [[ ! -f "$OUT" ]]; then
  needs_rebuild=1
else
  for p in "${PARTS[@]}"; do
    if [[ "$p" -nt "$OUT" ]]; then needs_rebuild=1; break; fi
  done
fi

if [[ "$needs_rebuild" -eq 1 ]]; then
  echo "assembling $OUT from ${#PARTS[@]} chunks"
  cat "${PARTS[@]}" > "$OUT"
  ls -lh "$OUT"
else
  echo "$OUT is up to date"
fi
