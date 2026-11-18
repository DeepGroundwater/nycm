#!/usr/bin/env bash
# Build the benchmark file and the calibrated tide table for every gauge the
# flood view answers to. One line per gauge:
#
#   NWPS id | NOAA harmonic tide station nearest to it | observed-data source | event to replay
#
# The observed record comes from USGS NWIS, or from NOAA CO-OPS (--coops) for
# gauges NOAA runs itself. Each tide table is calibrated to its gauge.
#
#   npm install --no-save @neaps/tide-predictor
#   bash scripts/build-flood-gauges.sh
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/gauges

build() {   # id tide-station gauge-file tide-file extra-args...
  local id=$1 station=$2 gauge=$3 tide=$4; shift 4
  node scripts/build-tide-table.mjs "$station" "$tide" --msl-navd88=0 --msl-navd88-source="placeholder" >/dev/null
  node scripts/build-gauge-benchmark.mjs "$id" "$gauge" --tide="$tide" --calibrate-table --years=3 "$@" | tail -4
}

# Nassau County
build HOGN6 8516663 data/hog-island-gauge.json   data/long-beach-tide.json   --event=2026-09-24,2026-09-30 --event-label="Sep 2026"
build KPTN6 8516945 data/kings-point-gauge.json  data/kings-point-tide.json  --coops=8516945 --event=auto
build RKWN6 8516881 data/gauges/RKWN6.json       data/gauges/RKWN6-tide.json --event=auto
build REYN6 8516402 data/gauges/REYN6.json       data/gauges/REYN6-tide.json --event=auto
build FRPN6 8516501 data/gauges/FRPN6.json       data/gauges/FRPN6-tide.json --event=auto
# New York City
build IWDN6 8516891 data/gauges/IWDN6.json       data/gauges/IWDN6-tide.json --event=auto
build RWYN6 8517756 data/gauges/RWYN6.json       data/gauges/RWYN6-tide.json --event=auto
build BATN6 8518750 data/gauges/BATN6.json       data/gauges/BATN6-tide.json --coops=8518750 --event=auto
build KILN6 8519436 data/gauges/KILN6.json       data/gauges/KILN6-tide.json --event=auto
