import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tideMsl, tideNavd, datumNavd, covers, extremes, series } from "../../../js/tide.js";

const here = new URL(".", import.meta.url);
const table = JSON.parse(readFileSync(new URL("../../../data/long-beach-tide.json", here)));
// NOAA's own predictions for the same station — the ground truth.
const noaa = JSON.parse(readFileSync(new URL("./noaa-8516663.json", here)));

test("matches NOAA's hourly predictions to within 1.5 cm, across 2024, 2026 and 2031", () => {
  let worst = 0, sumSq = 0;
  for (const [t, v] of noaa.hourly) {
    const e = tideMsl(table, Date.parse(t)) - v;
    worst = Math.max(worst, Math.abs(e)); sumSq += e * e;
  }
  const rms = Math.sqrt(sumSq / noaa.hourly.length);
  assert.ok(noaa.hourly.length > 200);
  assert.ok(worst < 0.015, `worst error ${worst.toFixed(4)} m`);
  assert.ok(rms < 0.006, `rms error ${rms.toFixed(4)} m`);
});

test("stays accurate at both ends of a year, where the yearly table hands over", () => {
  const edge = noaa.hourly.filter(([t]) => /-(01-0|12-2|12-3)/.test(t));
  assert.ok(edge.length > 20);
  for (const [t, v] of edge) assert.ok(Math.abs(tideMsl(table, Date.parse(t)) - v) < 0.015, t);
});

test("is continuous across New Year", () => {
  for (const y of [2026, 2027, 2040]) {
    const t = Date.UTC(y, 0, 1);
    const before = tideMsl(table, t - 1000), after = tideMsl(table, t);
    assert.ok(Math.abs(after - before) < 0.02, `${y}: jump of ${(after - before).toFixed(4)} m`);
  }
});

test("finds the same high and low waters as NOAA: within 6 minutes and 1.5 cm", () => {
  const start = Date.parse(noaa.hilo[0][0]) - 3.6e6, end = Date.parse(noaa.hilo.at(-1)[0]) + 3.6e6;
  const got = extremes(table, start, end);
  assert.equal(got.length, noaa.hilo.length);
  noaa.hilo.forEach(([t, v, type], i) => {
    assert.equal(got[i].type, type);
    assert.ok(Math.abs(got[i].time - Date.parse(t)) <= 6 * 60e3, `${t}: off by ${(got[i].time - Date.parse(t)) / 60e3} min`);
    assert.ok(Math.abs(got[i].level - v) < 0.015);
  });
});

test("highs and lows alternate and highs sit above lows", () => {
  const got = extremes(table, Date.UTC(2027, 4, 1), Date.UTC(2027, 4, 15));
  assert.ok(got.length >= 50);
  for (let i = 1; i < got.length; i++) {
    assert.notEqual(got[i].type, got[i - 1].type);
    const [h, l] = got[i].type === "H" ? [got[i], got[i - 1]] : [got[i - 1], got[i]];
    assert.ok(h.level > l.level);
  }
});

test("NAVD88 is MSL shifted by the table's datum tie", () => {
  const t = Date.UTC(2026, 10, 15, 16, 37);
  assert.ok(Math.abs(tideNavd(table, t) - (tideMsl(table, t) + table.msl_navd88_m)) < 1e-12);
  assert.ok(Math.abs(datumNavd(table, "MHHW") - (0.75 + table.msl_navd88_m)) < 1e-9);
  assert.equal(datumNavd(table, "NOPE"), null);
});

test("a year of predictions stays between the lowest and highest astronomical tide", () => {
  const { LAT, HAT } = table.datums;
  for (const { level } of series(table, Date.UTC(2028, 0, 1), Date.UTC(2028, 11, 31), 20000)) {
    assert.ok(level > LAT - 0.05 && level < HAT + 0.05, `level ${level}`);
  }
});

test("refuses a year outside the table rather than extrapolating", () => {
  assert.equal(covers(table, Date.UTC(2026, 5, 1)), true);
  assert.equal(covers(table, Date.UTC(2099, 5, 1)), false);
  assert.throws(() => tideMsl(table, Date.UTC(2099, 5, 1)), RangeError);
});
