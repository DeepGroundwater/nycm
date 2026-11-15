import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stationPredictor, subordinateExtremes, levelBetween, tideMllw } from "../../../js/tide.js";

const here = new URL(".", import.meta.url);
const doc = JSON.parse(readFileSync(new URL("../../../data/nassau-tides.json", here)));
// NOAA's own predictions for stations in the file — the ground truth.
const noaa = JSON.parse(readFileSync(new URL("./noaa-nassau.json", here)));
const byId = id => doc.stations.find(s => s.id === id);

test("every station resolves to a table: its own, or its reference station's", () => {
  assert.ok(doc.stations.length >= 20);
  for (const s of doc.stations) {
    if (s.kind === "harmonic") assert.ok(doc.tables[s.id], s.name);
    else {
      assert.equal(s.kind, "subordinate");
      assert.ok(doc.tables[s.ref], `${s.name} -> ${s.ref}`);
      assert.ok(["ratio", "fixed_ft"].includes(s.height));
    }
    assert.ok(Number.isFinite(stationPredictor(doc, s).level(Date.UTC(2027, 3, 4, 9))), s.name);
  }
});

test("harmonic stations on both shores match NOAA's hourly predictions to within 6 mm", () => {
  for (const [id, rows] of Object.entries(noaa.hourly)) {
    const p = stationPredictor(doc, byId(id));
    let worst = 0;
    for (const [t, v] of rows) worst = Math.max(worst, Math.abs(p.level(Date.parse(t)) - v));
    assert.ok(rows.length > 50);
    assert.ok(worst < 0.006, `${byId(id).name}: worst error ${worst.toFixed(4)} m`);
  }
});

test("subordinate stations match NOAA's highs and lows: within 2 minutes and 6 mm", () => {
  for (const [id, rows] of Object.entries(noaa.hilo)) {
    const st = byId(id), p = stationPredictor(doc, st);
    for (const [t, v, type] of rows) {
      const ms = Date.parse(t);
      const near = p.extremes(ms - 2 * 3.6e6, ms + 2 * 3.6e6).filter(e => e.type === type);
      assert.equal(near.length, 1, `${st.name} ${t}`);
      assert.ok(Math.abs(near[0].time - ms) <= 2 * 60e3, `${st.name} ${t}: off by ${((near[0].time - ms) / 60e3).toFixed(1)} min`);
      assert.ok(Math.abs(near[0].level - v) < 0.006, `${st.name} ${t}: ${near[0].level.toFixed(3)} vs ${v}`);
    }
  }
});

test("a subordinate station's curve passes through its highs and lows and stays between them", () => {
  const st = byId("8516601"), p = stationPredictor(doc, st);   // Long Beach (Inside)
  const a = Date.UTC(2026, 10, 15), b = Date.UTC(2026, 10, 18);
  const ext = p.extremes(a, b);
  assert.ok(ext.length >= 10);
  for (const e of ext) assert.ok(Math.abs(p.level(e.time) - e.level) < 1e-9);
  for (let i = 1; i < ext.length; i++) {
    const lo = Math.min(ext[i - 1].level, ext[i].level), hi = Math.max(ext[i - 1].level, ext[i].level);
    for (let k = 1; k < 10; k++) {
      const v = p.level(ext[i - 1].time + (ext[i].time - ext[i - 1].time) * k / 10);
      assert.ok(v >= lo - 1e-9 && v <= hi + 1e-9);
    }
  }
});

test("offsets are applied as published: Long Beach (Inside) is Sandy Hook x0.84, 18 minutes later, at high water", () => {
  const st = byId("8516601"), ref = doc.tables[st.ref];
  assert.deepEqual([st.high.minutes, st.high.height, st.height], [18, 0.84, "ratio"]);
  const a = Date.UTC(2028, 1, 1), b = Date.UTC(2028, 1, 3);
  const sub = subordinateExtremes(st, ref, a, b).filter(e => e.type === "H");
  for (const e of sub) {
    const refLevel = tideMllw(ref, e.time - 18 * 60e3);
    assert.ok(Math.abs(e.level - refLevel * 0.84) < 1e-6);
  }
});

test("levelBetween is null outside its list", () => {
  const ext = [{ time: 0, level: 1, type: "H" }, { time: 100, level: 0, type: "L" }];
  assert.equal(levelBetween(ext, -1), null);
  assert.equal(levelBetween(ext, 101), null);
  assert.ok(Math.abs(levelBetween(ext, 50) - 0.5) < 1e-12);
});

test("the Sound has a much larger tide than the south-shore bays", () => {
  const range = id => {
    const p = stationPredictor(doc, byId(id)), ext = p.extremes(Date.UTC(2027, 0, 1), Date.UTC(2027, 0, 29));
    const hs = ext.filter(e => e.type === "H").map(e => e.level), ls = ext.filter(e => e.type === "L").map(e => e.level);
    return hs.reduce((a, b) => a + b) / hs.length - ls.reduce((a, b) => a + b) / ls.length;
  };
  assert.ok(range("8516945") > 1.8);          // Kings Point
  assert.ok(range("8515864") < 0.5);          // Amityville
});
