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

test("searchMerge: local exact-name beats Photon top hit", async () => {
  const { searchMerge } = await import("../../../js/search-merge.js");
  const localStub = async () => [{
    lon: -74.0, lat: 40.7, label: "Joe's Pizza",
    score: 110, source: "local", poiId: 1, category: 1, walkNode: 0,
  }];
  const photonStub = async () => [{
    lon: -73.9, lat: 40.8, label: "Joe's Pizza Truck", source: "photon",
  }];
  const result = await searchMerge(
    "Joe's Pizza", new AbortController().signal,
    null, { lon: -73.95, lat: 40.73 }, 8,
    { local: localStub, photon: photonStub, census: async () => [] },
  );
  assert.equal(result[0].label, "Joe's Pizza");
  assert.equal(result[0].source, "local");
});

test("searchMerge: census still beats photon for address queries", async () => {
  const { searchMerge } = await import("../../../js/search-merge.js");
  const localStub = async () => [];
  const photonStub = async () => [{ lon: -73.5, lat: 40.5, label: "Wyandanch", source: "photon" }];
  const censusStub = async () => [{ lon: -74.0, lat: 40.745, label: "140 W 25th St, NEW YORK, NY", source: "census" }];
  const result = await searchMerge(
    "140 W 25th St", new AbortController().signal,
    null, { lon: -73.95, lat: 40.73 }, 8,
    { local: localStub, photon: photonStub, census: censusStub },
  );
  assert.equal(result[0].source, "census");
});

test("searchMerge: local lane failure is silent (other lanes still answer)", async () => {
  const { searchMerge } = await import("../../../js/search-merge.js");
  const localStub = async () => { throw new Error("simulated index load failure"); };
  const photonStub = async () => [{ lon: -73.9, lat: 40.7, label: "Photon Hit", source: "photon" }];
  const result = await searchMerge(
    "anything", new AbortController().signal,
    null, { lon: -73.95, lat: 40.73 }, 8,
    { local: localStub, photon: photonStub, census: async () => [] },
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].label, "Photon Hit");
});
