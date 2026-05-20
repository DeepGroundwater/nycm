import { test } from "node:test";
import assert from "node:assert/strict";
import { geocodeAddress, isAddressLike } from "../../../js/census.js";

function withMockFetch(impl, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = orig; });
}

test("isAddressLike accepts queries starting with digits+space", () => {
  assert.equal(isAddressLike("140 W 25th St"), true);
  assert.equal(isAddressLike("83 Elm Pl Brooklyn"), true);
});

test("isAddressLike rejects non-address-like queries", () => {
  assert.equal(isAddressLike("Joe's Pizza"), false);
  assert.equal(isAddressLike("Times Square"), false);
  assert.equal(isAddressLike(""), false);
  assert.equal(isAddressLike("140"), false);
});

test("geocodeAddress returns results filtered to NY/NJ/CT", async () => {
  const mockResponse = {
    result: {
      addressMatches: [
        { matchedAddress: "1 ABC ST, NYC, NY, 10001",
          coordinates: { x: -74.0, y: 40.7 },
          addressComponents: { state: "NY" } },
        { matchedAddress: "1 XYZ ST, MIAMI, FL, 33101",
          coordinates: { x: -80.2, y: 25.8 },
          addressComponents: { state: "FL" } },
        { matchedAddress: "1 PQR ST, NEWARK, NJ, 07102",
          coordinates: { x: -74.2, y: 40.7 },
          addressComponents: { state: "NJ" } },
      ],
    },
  };
  let capturedUrl = null;
  const results = await withMockFetch(async (url) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify(mockResponse), { status: 200 });
  }, () => geocodeAddress("1 ABC St"));
  assert.equal(results.length, 2);
  assert.ok(capturedUrl.includes("geocoding.geo.census.gov"));
  assert.ok(capturedUrl.includes("benchmark=Public_AR_Current"));
});

test("geocodeAddress returns [] on non-200", async () => {
  const results = await withMockFetch(
    async () => new Response("oops", { status: 500 }),
    () => geocodeAddress("1 ABC St")
  );
  assert.deepEqual(results, []);
});

test("geocodeAddress returns [] when result.addressMatches missing", async () => {
  const results = await withMockFetch(
    async () => new Response(JSON.stringify({ result: {} }), { status: 200 }),
    () => geocodeAddress("1 ABC St")
  );
  assert.deepEqual(results, []);
});

test("geocodeAddress retries with ', NY' when bare query is empty", async () => {
  const captured = [];
  await withMockFetch(async (url) => {
    const u = new URL(String(url));
    const addr = u.searchParams.get("address");
    captured.push(addr);
    // First call (bare) returns empty; second (', NY') returns a match.
    if (addr === "485 W Valley Stream Blvd") {
      return new Response(JSON.stringify({ result: { addressMatches: [] } }),
                          { status: 200 });
    }
    return new Response(JSON.stringify({
      result: { addressMatches: [{
        matchedAddress: "485 W VALLEY STREAM BLVD, VALLEY STREAM, NY, 11580",
        coordinates: { x: -73.71, y: 40.66 },
        addressComponents: { state: "NY" },
      }] },
    }), { status: 200 });
  }, async () => {
    const r = await geocodeAddress("485 W Valley Stream Blvd");
    assert.equal(r.length, 1);
    assert.ok(r[0].label.includes("VALLEY STREAM"));
  });
  assert.deepEqual(captured.slice(0, 2),
    ["485 W Valley Stream Blvd", "485 W Valley Stream Blvd, NY"]);
});

test("geocodeAddress does NOT retry when query already has a state hint", async () => {
  let calls = 0;
  await withMockFetch(async () => {
    calls++;
    return new Response(JSON.stringify({ result: { addressMatches: [] } }),
                        { status: 200 });
  }, () => geocodeAddress("485 W Valley Stream Blvd NY"));
  assert.equal(calls, 1);
});
