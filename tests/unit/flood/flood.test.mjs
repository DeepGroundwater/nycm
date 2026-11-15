import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeGrid, isWet, paintFlood, countReached, ftToM, mToFt } from "../../../js/flood.js";

const DEM = { offset_m: 20, scale: 100, sill_step_m: 0.02 };

// Mirror of encode_grid() in pipelines/flood_elevation.py, for one cell.
function encode(elev, fill, sea = false) {
  if (sea) return [0, 0, 0, 255];
  const q = Math.min(65535, Math.max(1, Math.round((elev + 20) * 100)));
  const sill = Math.min(255, Math.max(0, Math.round((fill - elev) / 0.02)));
  return [q >> 8, q & 255, sill, 255];
}
const grid = cells => decodeGrid(Uint8ClampedArray.from(cells.flat()), DEM);

test("decode recovers ground to within half a centimetre", () => {
  for (const e of [-19.99, -0.62, 0, 0.5, 1.234, 2.38, 9.999, 41.83, 600]) {
    const { elev } = grid([encode(e, e)]);
    assert.ok(Math.abs(elev[0] - e) <= 0.005 + 1e-6, `${e} -> ${elev[0]}`);
  }
});

test("sea decodes to NaN and is never wet", () => {
  const { elev, reach } = grid([encode(0, 0, true)]);
  assert.ok(Number.isNaN(elev[0]) && Number.isNaN(reach[0]));
  assert.equal(isWet(reach[0], 100), false);
});

test("reach is never below ground", () => {
  for (const [e, f] of [[1, 1], [1, 1.37], [2.5, 7.6], [0.5, 40]]) {
    const { elev, reach } = grid([encode(e, f)]);
    assert.ok(reach[0] >= elev[0]);
  }
});

test("open ground floods as soon as the water tops it; a hollow waits for its sill", () => {
  // beach at 1 m (open), hollow at 1 m behind a 3 m wall
  const { elev, reach } = grid([encode(1, 1), encode(1, 3)]);
  assert.equal(isWet(reach[0], 1.5), true);
  assert.equal(isWet(reach[1], 1.5), false);
  assert.equal(isWet(reach[1], 3.1), true);
  assert.ok(Math.abs(elev[1] - 1) < 0.01);
});

test("wet is strict: water exactly at the threshold is dry", () => {
  const { reach } = grid([encode(2, 2)]);
  assert.equal(isWet(reach[0], reach[0]), false);
});

test("wetness is monotone in water level, and depth is positive when wet", () => {
  const cells = [];
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 400; i++) { const e = 0.5 + rnd() * 5; cells.push(encode(e, e + (rnd() < 0.3 ? rnd() * 3 : 0))); }
  const { elev, reach } = grid(cells);
  let prev = -1;
  const out = new Uint8ClampedArray(cells.length * 4);
  for (let level = 0; level <= 9; level += 0.25) {
    const wet = paintFlood(elev, reach, level, out);
    assert.ok(wet >= prev, `count fell at ${level}`);
    prev = wet;
    for (let i = 0; i < elev.length; i++) {
      const painted = out[i * 4 + 3] > 0;
      assert.equal(painted, isWet(reach[i], level));
      if (painted) assert.ok(level - elev[i] > 0);
    }
  }
  assert.equal(prev, cells.length);   // everything is under water by 9 m
});

test("paintFlood clears cells that dry out when the level drops", () => {
  const { elev, reach } = grid([encode(1, 1)]);
  const out = new Uint8ClampedArray(4);
  assert.equal(paintFlood(elev, reach, 2, out), 1);
  assert.ok(out[3] > 0);
  assert.equal(paintFlood(elev, reach, 0.5, out), 0);
  assert.equal(out[3], 0);
});

test("countReached uses each building's threshold, strictly", () => {
  const w = Float32Array.from([1.5, 2.0, 2.0, 6.2]);
  assert.equal(countReached(w, 1.5), 0);
  assert.equal(countReached(w, 2.0), 1);
  assert.equal(countReached(w, 2.01), 3);
  assert.equal(countReached(w, 10), 4);
});

test("feet/metre conversion round-trips", () => {
  assert.ok(Math.abs(ftToM(1) - 0.3048) < 1e-12);
  for (const ft of [0, 0.25, 6.5, 14]) assert.ok(Math.abs(mToFt(ftToM(ft)) - ft) < 1e-9);
});
