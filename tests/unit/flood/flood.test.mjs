import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeGrid, isWet, classify, paintWindow, gridWindow, seaTint, countReached, toCm, ftToM, mToFt,
         SEA, DRY, NEAR_1, NEAR_2, NEAR_3, WET, WATER } from "../../../js/flood.js";

const DEM = { offset_m: 20, scale: 100, sill_step_m: 0.02 };

// Mirror of encode_grid() in pipelines/flood_elevation.py, for one cell.
function encode(elev, fill, sea = false) {
  if (sea) return [0, 0, 0, 255];
  const q = Math.min(65535, Math.max(1, Math.round((elev + 20) * 100)));
  const sill = Math.min(255, Math.max(0, Math.round((fill - elev) / 0.02)));
  return [q >> 8, q & 255, sill, 255];
}
const grid = cells => decodeGrid(Uint8ClampedArray.from(cells.flat()), DEM);
// A whole-grid window over a single row of cells.
const rowWindow = n => ({ c0: 0, r0: 0, ow: n, oh: 1, stride: 1, width: n, height: 1 });

test("decode recovers ground exactly, in centimetres", () => {
  for (const e of [-19.99, -0.62, 0, 0.5, 1.23, 2.38, 9.99, 41.83, 300]) {
    const { elev } = grid([encode(e, e)]);
    assert.equal(elev[0], Math.round(e * 100), `${e}`);
  }
});

test("sea decodes to the SEA marker and is never wet", () => {
  const { elev, reach } = grid([encode(0, 0, true)]);
  assert.equal(elev[0], SEA); assert.equal(reach[0], SEA);
  assert.equal(isWet(reach[0], 10000), false);
  assert.equal(classify(reach[0], 10000), WATER);
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
  assert.equal(isWet(reach[0], toCm(1.5)), true);
  assert.equal(isWet(reach[1], toCm(1.5)), false);
  assert.equal(isWet(reach[1], toCm(3.1)), true);
  assert.equal(elev[1], 100);
});

test("wet is strict: water exactly at the threshold is dry", () => {
  const { reach } = grid([encode(2, 2)]);
  assert.equal(isWet(reach[0], reach[0]), false);
  assert.equal(isWet(reach[0], reach[0] + 1), true);
});

test("nearly-under bands are 1, 2 and 3 feet of margin", () => {
  const level = toCm(1.0);
  const kind = marginFt => classify(level + Math.round(marginFt * 30.48), level);
  assert.equal(classify(level - 1, level), WET);
  assert.equal(kind(0), NEAR_1);          // water exactly at the edge: not yet wet, but closest band
  assert.equal(kind(0.5), NEAR_1);
  assert.equal(kind(1.5), NEAR_2);
  assert.equal(kind(2.5), NEAR_3);
  assert.equal(kind(3.5), DRY);
});

test("a low yard behind a bulkhead is flagged by the bulkhead, not by its own height", () => {
  // yard at 0.5 m, protected until the water reaches 2.0 m
  const { reach } = grid([encode(0.5, 2.0)]);
  assert.equal(classify(reach[0], toCm(0.6)), DRY);      // 1.4 m (4.6 ft) of protection left
  assert.equal(classify(reach[0], toCm(1.5)), NEAR_2);   // 0.5 m (1.6 ft) left
  assert.equal(classify(reach[0], toCm(1.9)), NEAR_1);
  assert.equal(classify(reach[0], toCm(2.1)), WET);
});

test("as the water rises a cell only moves toward wet, never back", () => {
  const order = { [DRY]: 0, [NEAR_3]: 1, [NEAR_2]: 2, [NEAR_1]: 3, [WET]: 4 };
  const { reach } = grid([encode(1.2, 1.2), encode(0.8, 2.6), encode(3.9, 3.9)]);
  for (let i = 0; i < reach.length; i++) {
    let prev = -1;
    for (let cm = -300; cm <= 600; cm += 3) {
      const k = order[classify(reach[i], cm)];
      assert.ok(k >= prev, `cell ${i} went backwards at ${cm} cm`);
      prev = k;
    }
    assert.equal(prev, 4);
  }
});

test("paintWindow: wet count is monotone, painted depth is positive, dry cells are cleared", () => {
  const cells = [];
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 400; i++) { const e = 0.5 + rnd() * 5; cells.push(encode(e, e + (rnd() < 0.3 ? rnd() * 3 : 0))); }
  const g = grid(cells), out = new Uint8ClampedArray(cells.length * 4);
  let prev = -1;
  for (let level = 0; level <= 9; level += 0.25) {
    const wet = paintWindow(g, toCm(level), rowWindow(cells.length), out);
    assert.ok(wet >= prev, `count fell at ${level}`);
    prev = wet;
    for (let i = 0; i < cells.length; i++) {
      const k = classify(g.reach[i], toCm(level));
      assert.equal(out[i * 4 + 3] > 0, k !== DRY);
      if (k === WET) assert.ok(toCm(level) - g.elev[i] > 0);
    }
  }
  assert.equal(prev, cells.length);   // everything is under water by 9 m
});

test("paintWindow tints open water only when asked, and more at a higher tide", () => {
  const g = grid([encode(0, 0, true)]), out = new Uint8ClampedArray(4);
  paintWindow(g, 0, rowWindow(1), out);
  assert.equal(out[3], 0);
  paintWindow(g, 0, rowWindow(1), out, 40);
  assert.equal(out[3], 40);
  assert.ok(seaTint(1.0, -1, 1) > seaTint(-1.0, -1, 1));
  assert.ok(seaTint(3.0, -1, 1) > seaTint(1.0, -1, 1));       // surge reads stronger than any tide
});

test("paintWindow with a stride samples every nth cell", () => {
  const g = grid([encode(1, 1), encode(9, 9), encode(1, 1), encode(9, 9)]), out = new Uint8ClampedArray(2 * 4);
  const wet = paintWindow(g, toCm(2), { c0: 0, r0: 0, ow: 2, oh: 1, stride: 2, width: 4, height: 1 }, out);
  assert.equal(wet, 2);                 // cells 0 and 2; the 9 m cells are skipped
});

const META = { bbox: [-73.745, 40.573, -73.572, 40.66], dem: { width: 3655, height: 2421 } };

test("gridWindow: a view over the whole grid covers it, with a stride that respects the cap", () => {
  const w = gridWindow(META, { west: -74, south: 40.5, east: -73.4, north: 40.7 }, 2048);
  assert.deepEqual([w.c0, w.r0, w.stride], [0, 0, 2]);
  assert.ok(w.ow <= 2048 && w.oh <= 2048);
  assert.ok(w.ow * w.stride >= 3655 && w.oh * w.stride >= 2421);
});

test("gridWindow: a close view gets full resolution and corners that enclose it", () => {
  const view = { west: -73.645, south: 40.622, east: -73.63, north: 40.632 };
  const w = gridWindow(META, view, 2048);
  assert.equal(w.stride, 1);
  const [[west, north], [east], [, south]] = [w.corners[0], w.corners[1], w.corners[2]];
  assert.ok(west <= view.west && east >= view.east && north >= view.north && south <= view.south);
  // one cell is ~4 m: the window should not overshoot the view by more than a cell or two
  assert.ok(view.west - west < 0.0001 && north - view.north < 0.0001);
});

test("gridWindow: corners land on the grid's own cell boundaries", () => {
  const w = gridWindow(META, { west: -73.7, south: 40.6, east: -73.6, north: 40.65 });
  const [bw, , be] = META.bbox;
  assert.ok(Math.abs(w.corners[0][0] - (bw + w.c0 / 3655 * (be - bw))) < 1e-12);
});

test("gridWindow: a view that misses the grid returns null", () => {
  assert.equal(gridWindow(META, { west: -74.2, south: 40.7, east: -74.0, north: 40.8 }), null);
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
