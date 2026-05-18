#!/usr/bin/env bash
# Reassemble tiles/walk_graph.bin from its committed chunks.
# Idempotent: only assembles when the full file is missing or older than any part.
# Mirrors scripts/assemble-tiles.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=tiles/walk_graph.bin
PARTS=(tiles/walk-graph.part-*)

if [[ ${#PARTS[@]} -eq 0 || ! -e "${PARTS[0]}" ]]; then
  echo "no chunks found at tiles/walk-graph.part-* — run scripts/build-walk-graph.sh first" >&2
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
