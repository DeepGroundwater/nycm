import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePoiBlob } from "../../../js/poi-index.js";

function packHeader(version, walkGraphVersion, nPois, namesOff) {
  const buf = new ArrayBuffer(24);
  const dv = new DataView(buf);
  new Uint8Array(buf, 0, 4).set(new TextEncoder().encode("POI1"));
  dv.setUint32(4, version, true);
  dv.setUint32(8, walkGraphVersion, true);
  dv.setUint32(12, nPois, true);
  dv.setUint32(16, namesOff, true);
  dv.setUint32(20, 0, true);
  return new Uint8Array(buf);
}

function packRecord({ lon, lat, walkNode, nameOff, nameLen, category, flags }) {
  const buf = new ArrayBuffer(20);
  const dv = new DataView(buf);
  dv.setInt32(0,  Math.round(lon * 1e7), true);
  dv.setInt32(4,  Math.round(lat * 1e7), true);
  dv.setUint32(8, walkNode, true);
  dv.setUint32(12, nameOff, true);
  dv.setUint16(16, nameLen, true);
  dv.setUint8(18, category);
  dv.setUint8(19, flags);
  return new Uint8Array(buf);
}

function buildBlob(records, namesString) {
  const enc = new TextEncoder();
  const names = enc.encode(namesString);
  const namesOff = 24 + records.length * 20;
  const header = packHeader(1, 1, records.length, namesOff);
  const blob = new Uint8Array(header.length + records.length * 20 + names.length);
  blob.set(header, 0);
  records.forEach((r, i) => blob.set(packRecord(r), 24 + i * 20));
  blob.set(names, namesOff);
  return blob;
}

test("decodePoiBlob round-trips a handcrafted binary", () => {
  // names: "Joe's" (0,5) + "Central Park" (5,12) = "Joe'sCentral Park"
  const blob = buildBlob(
    [
      { lon: -74,   lat: 40.7, walkNode: 0, nameOff: 0, nameLen: 5,  category: 1, flags: 0 },
      { lon: -73.9, lat: 40.8, walkNode: 9, nameOff: 5, nameLen: 12, category: 3, flags: 0 },
    ],
    "Joe'sCentral Park",
  );
  const idx = decodePoiBlob(blob);
  assert.equal(idx.nPois, 2);
  assert.equal(idx.walkGraphVersion, 1);
  assert.equal(idx.version, 1);

  const p0 = idx.byId(0);
  assert.equal(p0.name, "Joe's");
  assert.equal(p0.category, 1);
  assert.ok(Math.abs(p0.lon - -74) < 1e-6);

  const p1 = idx.byId(1);
  assert.equal(p1.name, "Central Park");
  assert.equal(p1.category, 3);
  assert.equal(p1.walkNode, 9);
});

test("decodePoiBlob rejects bad magic", () => {
  const bad = new Uint8Array(24);
  new TextEncoder().encodeInto("OOPS", bad);
  assert.throws(() => decodePoiBlob(bad), /bad magic/);
});

test("decodePoiBlob.byId throws RangeError out of bounds", () => {
  const blob = buildBlob([
    { lon: 0, lat: 0, walkNode: 0, nameOff: 0, nameLen: 1, category: 1, flags: 0 },
  ], "x");
  const idx = decodePoiBlob(blob);
  assert.throws(() => idx.byId(-1), RangeError);
  assert.throws(() => idx.byId(1),  RangeError);
});

// ---- in-memory token index search ---------------------------------------

// Stub fetch to serve a handcrafted blob for the lazy-load path.
import * as poiIndex from "../../../js/poi-index.js";

function withFakeFetch(blob, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/pois.bin")) {
      return new Response(blob, { status: 200 });
    }
    return new Response("nope", { status: 404 });
  };
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = orig;
    poiIndex.__resetForTests();
  });
}

test("search returns POIs whose name tokens all match the query", async () => {
  // Three POIs; query "park" → tokens=["park"], a single-token prefix match
  // hits both "Central Park" and "Battery Park" (token `park` is in both).
  // "Joe's Pizza" doesn't contain `park`, so it's excluded.
  const names = "Joe's PizzaCentral ParkBattery Park";
  // Offsets: Joe's Pizza=0/11, Central Park=11/12, Battery Park=23/12
  const blob = buildBlob(
    [
      { lon: -74,   lat: 40.70, walkNode: 0, nameOff: 0,  nameLen: 11, category: 1, flags: 0 },
      { lon: -73.97, lat: 40.78, walkNode: 1, nameOff: 11, nameLen: 12, category: 3, flags: 0 },
      { lon: -74.02, lat: 40.70, walkNode: 2, nameOff: 23, nameLen: 12, category: 3, flags: 0 },
    ],
    names,
  );
  await withFakeFetch(blob, async () => {
    const results = await poiIndex.search("park");
    const labels = results.map((r) => r.label).sort();
    assert.deepEqual(labels, ["Battery Park", "Central Park"]);
    // All results carry .source = "local" and a numeric score.
    assert.ok(results.every((r) => r.source === "local"));
    assert.ok(results.every((r) => typeof r.score === "number"));
    // category boost: park (3) gets +8, so score should be ≥ 60 + 8.
    assert.ok(results.every((r) => r.score >= 60));
  });
});

test("search ranks exact-name match above token-subset match", async () => {
  // Two POIs: "Central Park" + "Central Park Zoo". Query "Central Park" exactly
  // matches the first; the second has all query tokens but is longer.
  const names = "Central ParkCentral Park Zoo";
  const blob = buildBlob(
    [
      { lon: -74, lat: 40.78, walkNode: 0, nameOff: 0,  nameLen: 12, category: 3, flags: 0 },
      { lon: -74, lat: 40.77, walkNode: 1, nameOff: 12, nameLen: 16, category: 5, flags: 0 },
    ],
    names,
  );
  await withFakeFetch(blob, async () => {
    const results = await poiIndex.search("central park");
    assert.equal(results[0].label, "Central Park");
  });
});

test("search returns [] for empty query", async () => {
  const blob = buildBlob([
    { lon: 0, lat: 0, walkNode: 0, nameOff: 0, nameLen: 1, category: 1, flags: 0 },
  ], "x");
  await withFakeFetch(blob, async () => {
    const r = await poiIndex.search("");
    assert.deepEqual(r, []);
    const r2 = await poiIndex.search("   ");
    assert.deepEqual(r2, []);
  });
});

test("byCategory returns POI ids for a category", async () => {
  const names = "AaBbCc";
  const blob = buildBlob(
    [
      { lon: 0, lat: 0, walkNode: 0, nameOff: 0, nameLen: 2, category: 1, flags: 0 },
      { lon: 0, lat: 0, walkNode: 0, nameOff: 2, nameLen: 2, category: 3, flags: 0 },
      { lon: 0, lat: 0, walkNode: 0, nameOff: 4, nameLen: 2, category: 1, flags: 0 },
    ],
    names,
  );
  await withFakeFetch(blob, async () => {
    const food = await poiIndex.byCategory(1);
    assert.deepEqual([...food].sort((a,b)=>a-b), [0, 2]);
    const park = await poiIndex.byCategory(3);
    assert.deepEqual([...park], [1]);
    const empty = await poiIndex.byCategory(99);
    assert.equal(empty.length, 0);
  });
});
