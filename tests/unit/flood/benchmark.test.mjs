// The flood model against a real gauge: NOAA HOGN6 / USGS 01311143, Hog Island
// Channel at Island Park. The gauge says how often each water level actually
// happens and where the official flood stages are; the model has to agree that
// ordinary tides reach almost nothing and that the Sep 2026 flood reaches a lot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { countReached, ftToM } from "../../../js/flood.js";
import { tideMsl } from "../../../js/tide.js";

const data = name => JSON.parse(readFileSync(new URL(`../../../data/${name}`, import.meta.url)));
const gauge = data("hog-island-gauge.json"), meta = data("long-beach-flood.json");
const thresholds = Float32Array.from(data("long-beach-buildings.geojson").features, f => f.properties.w);
// Buildings the sea reaches at a level given in the gauge's datum (ft MLLW).
const reached = ftMllw => countReached(thresholds, ftToM(ftMllw - gauge.navd88_above_mllw_ft));
const share = ftMllw => reached(ftMllw) / meta.buildings.count_total;

test("gauge file is internally consistent", () => {
  const s = gauge.flood_stages_ft_mllw;
  assert.ok(s.minor < s.moderate && s.moderate < s.major);
  assert.ok(gauge.navd88_above_mllw_ft > 2 && gauge.navd88_above_mllw_ft < 3.5);
  const days = gauge.record.days_reaching_ft;
  for (let i = 1; i < days.length; i++) assert.ok(days[i][1] <= days[i - 1][1], "a higher level cannot be reached on more days");
  assert.equal(days.at(-1)[1], 0);
  assert.ok(gauge.record.days > 900);
});

test("the replayed event is complete, peaks where the file says, and was a major flood", () => {
  const ev = gauge.event;
  assert.ok(ev.ft_mllw.every(v => typeof v === "number"));
  assert.ok(Math.abs(Math.max(...ev.ft_mllw) - ev.peak.ft_mllw) < 0.1);
  assert.ok(ev.peak.ft_mllw >= gauge.flood_stages_ft_mllw.major);
  assert.equal(gauge.record.highest_days[0].ft, ev.peak.ft_mllw);     // the highest day on record
});

test("major floods are rare at the gauge; ordinary high tides are not", () => {
  const r = gauge.record;
  assert.ok(r.days_at_or_above_stage.major / r.days < 0.01);
  assert.ok(r.daily_high_ft_mllw.median < gauge.flood_stages_ft_mllw.minor);
});

test("benchmark: a typical high tide reaches almost no buildings", () => {
  assert.ok(share(gauge.record.daily_high_ft_mllw.median) < 0.005, `${reached(gauge.record.daily_high_ft_mllw.median)} reached`);
});

test("benchmark: the moderate flood stage still reaches very few", () => {
  assert.ok(share(gauge.flood_stages_ft_mllw.moderate) < 0.02, `${reached(gauge.flood_stages_ft_mllw.moderate)} reached`);
});

test("benchmark: the Sep 2026 peak reaches many times more than the moderate stage", () => {
  const peak = reached(gauge.event.peak.ft_mllw), moderate = reached(gauge.flood_stages_ft_mllw.moderate);
  assert.ok(share(gauge.event.peak.ft_mllw) > 0.08, `${peak} reached`);
  assert.ok(peak > 5 * moderate, `${peak} vs ${moderate}`);
});

test("the tide prediction is calibrated to the gauge: ordinary predicted highs sit near the observed typical high", () => {
  const table = data("long-beach-tide.json");
  assert.equal(table.msl_navd88_m, gauge.calibration.msl_navd88_m);
  // Mean of the daily predicted highs over a year, in the gauge's datum.
  let sum = 0, n = 0;
  for (let d = Date.UTC(2025, 0, 1); d < Date.UTC(2026, 0, 1); d += 864e5) {
    let hi = -Infinity;
    for (let t = d; t < d + 864e5; t += 10 * 6e4) hi = Math.max(hi, tideMsl(table, t));
    sum += (hi + table.msl_navd88_m) / 0.3048 + gauge.navd88_above_mllw_ft; n++;
  }
  const predicted = sum / n, observed = gauge.record.daily_high_ft_mllw.median;
  assert.ok(Math.abs(predicted - observed) < 0.35, `predicted ${predicted.toFixed(2)} ft vs observed ${observed} ft`);
});
