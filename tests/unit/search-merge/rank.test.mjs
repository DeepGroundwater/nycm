import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupBy50mGrid, mergeRank } from "../../../js/search-merge.js";

test("dedupBy50mGrid drops the lower-scored duplicate at the same coords", () => {
  const items = [
    { lon: -73.987, lat: 40.748, label: "A", baseScore: 50 },
    { lon: -73.987, lat: 40.748, label: "A-better", baseScore: 90 },
    { lon: -73.987, lat: 40.748001, label: "A-near", baseScore: 70 },
  ];
  const out = dedupBy50mGrid(items);
  assert.equal(out.length, 1);
  assert.equal(out[0].label, "A-better");
});

test("dedupBy50mGrid keeps distinct points >50m apart", () => {
  const items = [
    { lon: -73.987, lat: 40.748, label: "A", baseScore: 90 },
    { lon: -73.987, lat: 40.749, label: "B", baseScore: 90 },
  ];
  const out = dedupBy50mGrid(items);
  assert.equal(out.length, 2);
});

test("mergeRank orders by baseScore desc", () => {
  const out = mergeRank([
    { lon: -73.9, lat: 40.7, label: "low", baseScore: 30 },
    { lon: -73.91, lat: 40.71, label: "high", baseScore: 90 },
    { lon: -73.92, lat: 40.72, label: "mid", baseScore: 60 },
  ], { lon: -73.9, lat: 40.7 });
  assert.deepEqual(out.map((r) => r.label), ["high", "mid", "low"]);
});

test("mergeRank breaks ties with proximity to biasLL", () => {
  const out = mergeRank([
    { lon: -73.9,  lat: 40.7,  label: "near", baseScore: 50 },
    { lon: -74.0,  lat: 40.8,  label: "far",  baseScore: 50 },
  ], { lon: -73.9, lat: 40.7 });
  assert.equal(out[0].label, "near");
});
