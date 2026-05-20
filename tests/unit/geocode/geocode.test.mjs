import { test } from "node:test";
import assert from "node:assert/strict";
import { geocode } from "../../../js/geocode.js";

function withMockFetch(impl, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = orig; });
}

test("geocode sets countrycode=us and bbox", async () => {
  let capturedUrl = null;
  await withMockFetch(async (url) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({ features: [] }), { status: 200 });
  }, () => geocode("anywhere"));
  const u = new URL(capturedUrl);
  // Photon's param is the singular `countrycode`, not `countrycodes`.
  // (Passing the wrong name causes Photon to return a 200 with an error
  // JSON that has no `features` key — silently swallowed by our caller.)
  assert.equal(u.searchParams.get("countrycode"), "us");
  assert.equal(u.searchParams.get("bbox"), "-74.5,40.3,-72.7,41.4");
});

test("geocode preserves existing bias lon/lat", async () => {
  let capturedUrl = null;
  await withMockFetch(async (url) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({ features: [] }), { status: 200 });
  }, () => geocode("x"));
  const u = new URL(capturedUrl);
  assert.ok(u.searchParams.has("lon"));
  assert.ok(u.searchParams.has("lat"));
});
