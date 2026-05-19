# Richer Geocoding & Search-Driven Discovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken-by-design Photon-only search with a four-lane search (local POI / Census / tuned Photon / discovery) and a search-driven category discovery feature backed by a bounded WASM Dijkstra.

**Architecture:** A pyosmium pipeline extracts ~100k pre-snapped POIs from the same OSM PBF the walking graph uses, emits a packed binary, and ships it in chunks. The JS search bar fans out across four independent lanes that merge client-side. Phase 2 adds one Rust method (`reachable_nodes`) that runs an in-WASM bounded Dijkstra, and a JS data lane that joins the result against the POI binary to surface category-keyword queries ("coffee", "park") as both dropdown rows and ephemeral map pins.

**Tech Stack:** Rust + wasm-bindgen + wasm-pack for the router; pyosmium + uv for the build pipeline; vanilla JS modules + MapLibre GL for the UI; `node --test` for JS unit tests; `pytest` for pipeline tests; existing GitHub Actions CI.

**Spec:** `docs/superpowers/specs/2026-05-18-richer-geocoding-design.md`

**Branch model:** Five PRs against `main` (PR-protected). Each PR is independently shippable and reversible.

---

## File structure

| Path | PR | Purpose |
|---|---|---|
| `js/geocode.js` | 1 | Existing Photon — gains `bbox` + `countrycodes=us` |
| `js/census.js` | 1 | New: `geocodeAddress(query, signal)` against US Census Geocoder |
| `js/tokenize.js` | 1 | New: shared `normalize()` + empty `CATEGORY_KEYWORDS` map |
| `js/search-merge.js` | 1, 5 | New in PR 1 (skeleton: photon + census). PR 5 adds local + discovery lanes |
| `js/search.js` | 1, 5 | Existing — switches to `searchMerge`; PR 5 wires pin source updates |
| `tests/unit/package.json` | 1 | `node --test` runner config (mirror of tests/wasm/package.json) |
| `tests/unit/tokenize/normalize.test.mjs` | 1 | Pins normalize() output |
| `tests/unit/search-merge/rank.test.mjs` | 1, 3, 5 | Lane merge + ranking + dedup |
| `tests/unit/census/census.test.mjs` | 1 | Mocks fetch; asserts NY/NJ/CT filter, address-like guard |
| `pipelines/walk_graph_reader.py` | 2 | Extracted from `walk_graph.py`; shared walk-graph binary decoder |
| `pipelines/pois.py` | 2 | New: pyosmium pass → POI binary with pre-snapped walk_node_id |
| `pipelines/poi_emit.py` | 2 | New: writes the packed POI binary |
| `pipelines/tests/test_pois.py` | 2 | pytest: tiny fixture PBF → POI records |
| `pipelines/tests/test_walk_graph_reader.py` | 2 | pytest: round-trip walk-graph reader |
| `scripts/build-pois.sh` | 2 | New: invoke `pipelines/pois.py`, sanity-check, chunk to `tiles/pois.part-*` |
| `tiles/pois.part-*` | 2 | Committed POI chunks (gitignore the assembled `pois.bin`) |
| `.gitignore` | 2 | Add `tiles/pois.bin` |
| `js/poi-index.js` | 3 | New: load/assemble chunks, decode binary, expose `search`/`byId`/`byCategory` |
| `tests/unit/poi-index/decode.test.mjs` | 3 | Handcrafted binary → decode + search invariants |
| `nycm-router/src/walk.rs` | 4 | Add `reachable_nodes_packed(&WalkGraph, start, budget_m)` |
| `nycm-router/src/lib.rs` | 4 | Expose `Router::reachable_nodes(from, budget_m) -> Vec<u8>` |
| `nycm-router/src/walk.rs` (tests) | 4 | Rust unit test for bounded Dijkstra on a hand-rolled 4-node graph |
| `tests/wasm/discover.mjs` | 4 | WASM smoke: real graph + Times Sq → reachable invariants |
| `js/discover.js` | 5 | New: `discoveryLane(query, pinnedDest, signal) → Hit[]` |
| `tests/unit/discover/lane.test.mjs` | 5 | Fake reachable map + POI index → filter + sort |
| `index.html` | 5 | Add `#discovery-pins` GeoJSON source + circle layer + CSS |
| `tests/unit/golden/queries.test.mjs` | 3, 5 | End-to-end ranking regression table |
| `.github/workflows/pages.yml` | 1, 2, 3, 4, 5 | Add test gates progressively |

---

## PR 1 — Tune Photon + add Census lane

**PR title:** `feat(search): hard-clip Photon to US + add Census Geocoder lane`

**Goal:** Eliminate the "140 W 25th St → Ontario" failure and make street addresses reliably resolve across the basemap region. No data pipeline changes; entirely runtime.

### Task 1.1: Create `node --test` unit test scaffold

**Files:**
- Create: `tests/unit/package.json`
- Create: `tests/unit/tokenize/normalize.test.mjs` (placeholder)

- [ ] **Step 1: Create the test runner package**

Create `tests/unit/package.json`:

```json
{
  "name": "nycm-unit",
  "version": "0.0.0",
  "private": true,
  "type": "module"
}
```

- [ ] **Step 2: Create a placeholder smoke test**

Create `tests/unit/tokenize/normalize.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";

test("scaffold runs", () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 3: Verify the scaffold runs**

Run: `node --test tests/unit/tokenize/normalize.test.mjs`
Expected: `# pass 1`, exit 0.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/package.json tests/unit/tokenize/normalize.test.mjs
git commit -m "test: scaffold node --test unit test runner under tests/unit"
```

### Task 1.2: Create `js/tokenize.js` with `normalize()` (TDD)

**Files:**
- Test: `tests/unit/tokenize/normalize.test.mjs`
- Create: `js/tokenize.js`

- [ ] **Step 1: Replace placeholder with real failing tests**

Overwrite `tests/unit/tokenize/normalize.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, CATEGORY_KEYWORDS } from "../../../js/tokenize.js";

test("normalize lowercases", () => {
  assert.deepEqual(normalize("Times Square"), ["times", "square"]);
});

test("normalize strips diacritics", () => {
  assert.deepEqual(normalize("Café"), ["cafe"]);
});

test("normalize splits on punctuation", () => {
  assert.deepEqual(normalize("Joe's Pizza"), ["joe", "s", "pizza"]);
});

test("normalize drops single-char tokens", () => {
  // "a" gets dropped; "s" is borderline — we keep len>=2 only.
  assert.deepEqual(normalize("a B cd"), ["cd"]);
});

test("normalize handles empty input", () => {
  assert.deepEqual(normalize(""), []);
  assert.deepEqual(normalize("   "), []);
});

test("normalize is idempotent", () => {
  const once = normalize("Battery Park");
  const twice = once.flatMap(normalize);
  assert.deepEqual(twice, once);
});

test("CATEGORY_KEYWORDS exists and is a Map", () => {
  assert.ok(CATEGORY_KEYWORDS instanceof Map);
});
```

- [ ] **Step 2: Verify the tests fail**

Run: `node --test tests/unit/tokenize/normalize.test.mjs`
Expected: FAIL with `Cannot find module .../js/tokenize.js`.

- [ ] **Step 3: Implement `js/tokenize.js`**

Create `js/tokenize.js`:

```js
// Shared text normalization. Build pipeline and runtime MUST import this same
// module — drift between build-time and query-time tokenization silently
// breaks search matching.

/**
 * Normalize a string into a list of search tokens:
 *   - NFD decompose + strip combining marks (Café → Cafe)
 *   - lowercase
 *   - split on any char that is not a Unicode letter or number
 *   - drop tokens shorter than 2 chars
 *
 * @param {string} s
 * @returns {string[]}
 */
export function normalize(s) {
  if (!s) return [];
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
}

/**
 * Keyword → category mapping used by the discovery lane (PR 5 fills this in).
 * Kept here so build-time and runtime can use the same source if needed.
 *
 * @type {Map<string, { cat: string, hint?: string }>}
 */
export const CATEGORY_KEYWORDS = new Map();
```

- [ ] **Step 4: Verify tests pass**

Run: `node --test tests/unit/tokenize/normalize.test.mjs`
Expected: `# pass 7`.

- [ ] **Step 5: Commit**

```bash
git add js/tokenize.js tests/unit/tokenize/normalize.test.mjs
git commit -m "feat(search): shared normalize() tokenizer + empty CATEGORY_KEYWORDS"
```

### Task 1.3: Add `bbox` + `countrycodes=us` to Photon (TDD)

**Files:**
- Modify: `js/geocode.js`
- Test: `tests/unit/geocode/geocode.test.mjs`

- [ ] **Step 1: Write failing test**

Create `tests/unit/geocode/geocode.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { geocode } from "../../../js/geocode.js";

// Replace global fetch with a recorder; assert the URL Photon receives.
function withMockFetch(impl, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = orig; });
}

test("geocode sets countrycodes=us and bbox", async () => {
  let capturedUrl = null;
  await withMockFetch(async (url) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({ features: [] }), { status: 200 });
  }, () => geocode("anywhere"));
  const u = new URL(capturedUrl);
  assert.equal(u.searchParams.get("countrycodes"), "us");
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
```

- [ ] **Step 2: Verify test fails**

Run: `node --test tests/unit/geocode/geocode.test.mjs`
Expected: FAIL with `Expected values to be strictly equal: undefined !== "us"` (the params aren't set yet).

- [ ] **Step 3: Edit `js/geocode.js`**

In `js/geocode.js`, find the block after `url.searchParams.set("lat", String(BIAS_LAT));` and add two lines:

```js
  url.searchParams.set("lon", String(BIAS_LON));
  url.searchParams.set("lat", String(BIAS_LAT));
  // Hard clip to US — biggest single ranking improvement; eliminates the
  // "140 W 25th St → Ontario" failure mode.
  url.searchParams.set("countrycodes", "us");
  // Soft clip to basemap bbox; helps ranking without hard-filtering.
  url.searchParams.set("bbox", "-74.5,40.3,-72.7,41.4");
```

- [ ] **Step 4: Verify tests pass**

Run: `node --test tests/unit/geocode/geocode.test.mjs`
Expected: `# pass 2`.

- [ ] **Step 5: Commit**

```bash
git add js/geocode.js tests/unit/geocode/geocode.test.mjs
git commit -m "feat(search): hard-clip Photon to US + soft bbox bias for basemap"
```

### Task 1.4: Implement `js/census.js` (TDD)

**Files:**
- Create: `js/census.js`
- Create: `tests/unit/census/census.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/census/census.test.mjs`:

```js
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
  assert.equal(isAddressLike("140"), false); // digits only, no street word
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
  assert.ok(results.every((r) => ["NY", "NJ", "CT"].some((s) => r.label.includes(s))));
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
```

- [ ] **Step 2: Verify tests fail**

Run: `node --test tests/unit/census/census.test.mjs`
Expected: FAIL with `Cannot find module .../js/census.js`.

- [ ] **Step 3: Implement `js/census.js`**

Create `js/census.js`:

```js
// US Census Bureau geocoder. Free, keyless, no rate limit on the
// `Public_AR_Current` benchmark. One-shot address resolution — no typeahead
// endpoint exists; debounce upstream in search-merge.

const CENSUS_URL =
  "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
const KEEP_STATES = new Set(["NY", "NJ", "CT"]);

/**
 * Returns true when the query starts with digits followed by whitespace and
 * at least one more word — the only shape Census can resolve.
 * @param {string} q
 */
export function isAddressLike(q) {
  return /^\d+\s+\S/.test(q || "");
}

/** @typedef {{ lon: number, lat: number, label: string, source: "census" }} GeocodeResult */

/**
 * @param {string} query
 * @param {AbortSignal} [signal]
 * @returns {Promise<GeocodeResult[]>}
 */
export async function geocodeAddress(query, signal) {
  const q = (query || "").trim();
  if (!q) return [];
  const url = new URL(CENSUS_URL);
  url.searchParams.set("address", q);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("format", "json");

  let res;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    return [];
  }
  if (!res.ok) return [];

  let json;
  try { json = await res.json(); } catch { return []; }
  const matches = json?.result?.addressMatches;
  if (!Array.isArray(matches)) return [];

  const out = [];
  for (const m of matches) {
    const state = m?.addressComponents?.state;
    if (!KEEP_STATES.has(state)) continue;
    const x = m?.coordinates?.x;
    const y = m?.coordinates?.y;
    if (typeof x !== "number" || typeof y !== "number") continue;
    out.push({
      lon: x,
      lat: y,
      label: m.matchedAddress || `${y.toFixed(4)}, ${x.toFixed(4)}`,
      source: "census",
    });
  }
  return out;
}
```

- [ ] **Step 4: Verify tests pass**

Run: `node --test tests/unit/census/census.test.mjs`
Expected: `# pass 5`.

- [ ] **Step 5: Commit**

```bash
git add js/census.js tests/unit/census/census.test.mjs
git commit -m "feat(search): add US Census Geocoder lane (keyless, NY/NJ/CT)"
```

### Task 1.5: Build `js/search-merge.js` skeleton (TDD)

**Files:**
- Create: `js/search-merge.js`
- Create: `tests/unit/search-merge/rank.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/search-merge/rank.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupBy50mGrid, mergeRank } from "../../../js/search-merge.js";

test("dedupBy50mGrid drops the lower-scored duplicate at the same coords", () => {
  const items = [
    { lon: -73.987, lat: 40.748, label: "A", baseScore: 50 },
    { lon: -73.987, lat: 40.748, label: "A-better", baseScore: 90 },
    { lon: -73.987, lat: 40.748001, label: "A-near", baseScore: 70 }, // ~0.1 m
  ];
  const out = dedupBy50mGrid(items);
  assert.equal(out.length, 1);
  assert.equal(out[0].label, "A-better");
});

test("dedupBy50mGrid keeps distinct points >50m apart", () => {
  const items = [
    { lon: -73.987, lat: 40.748, label: "A", baseScore: 90 },
    { lon: -73.987, lat: 40.749, label: "B", baseScore: 90 }, // ~111 m north
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
```

- [ ] **Step 2: Verify tests fail**

Run: `node --test tests/unit/search-merge/rank.test.mjs`
Expected: FAIL with `Cannot find module .../js/search-merge.js`.

- [ ] **Step 3: Implement `js/search-merge.js`**

Create `js/search-merge.js`:

```js
// Orchestrates search lanes. PR 1 wires Photon + Census; PR 3 adds the local
// POI lane; PR 5 adds the discovery lane.

import { geocode as photon } from "./geocode.js";
import { geocodeAddress as census, isAddressLike } from "./census.js";

/**
 * Snap a (lon, lat) to a ~50 m grid bucket key. At 40°N:
 *   - 0.0005 deg lat ≈ 55.6 m
 *   - 0.0005 deg lon ≈ 42.5 m
 * Close enough.
 */
function gridKey(lon, lat) {
  const lo = Math.floor(lon / 0.0005);
  const la = Math.floor(lat / 0.0005);
  return `${lo}:${la}`;
}

/**
 * Keep the highest baseScore per 50 m bucket. Stable order in input is
 * preserved for everything else.
 * @template {{lon:number, lat:number, baseScore:number}} T
 * @param {T[]} items
 * @returns {T[]}
 */
export function dedupBy50mGrid(items) {
  const best = new Map();
  for (const it of items) {
    const k = gridKey(it.lon, it.lat);
    const prev = best.get(k);
    if (!prev || it.baseScore > prev.baseScore) best.set(k, it);
  }
  return [...best.values()];
}

function proximityMeters(a, biasLL) {
  if (!biasLL) return 0;
  const dx = (a.lon - biasLL.lon) * 85_000;  // ~m per deg lon at 40°N
  const dy = (a.lat - biasLL.lat) * 111_000;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Sort by baseScore desc, ties broken by inverse great-circle distance to
 * the bias point (closer ranks higher).
 */
export function mergeRank(items, biasLL) {
  const deduped = dedupBy50mGrid(items);
  deduped.sort((a, b) =>
    (b.baseScore - a.baseScore) ||
    (proximityMeters(a, biasLL) - proximityMeters(b, biasLL))
  );
  return deduped;
}

/**
 * Main entry. PR 1: photon + census only. Local + discovery added later.
 * @param {string} query
 * @param {AbortSignal} signal
 * @param {{lon:number,lat:number}|null} _pinnedDest  reserved for PR 5
 * @param {{lon:number,lat:number}} biasLL
 * @param {number} [k]
 */
export async function searchMerge(query, signal, _pinnedDest, biasLL, k = 8) {
  const photonP = photon(query, signal).catch(() => []);
  const censusP = isAddressLike(query) ? census(query, signal).catch(() => []) : Promise.resolve([]);
  const [photonHits, censusHits] = await Promise.all([photonP, censusP]);

  const all = [
    ...censusHits.map((r) => ({ ...r, baseScore: 78 })),
    ...photonHits.map((r, i) => ({ ...r, baseScore: Math.max(30, 62 - i * 4), source: "photon" })),
  ];
  return mergeRank(all, biasLL).slice(0, k);
}
```

- [ ] **Step 4: Verify tests pass**

Run: `node --test tests/unit/search-merge/rank.test.mjs`
Expected: `# pass 4`.

- [ ] **Step 5: Commit**

```bash
git add js/search-merge.js tests/unit/search-merge/rank.test.mjs
git commit -m "feat(search): search-merge orchestrator (photon+census, 50m dedup)"
```

### Task 1.6: Wire `searchMerge` into `js/search.js`

**Files:**
- Modify: `js/search.js`

- [ ] **Step 1: Replace the `geocode` import + call site**

In `js/search.js`, find the import line `import { geocode } from "./geocode.js";` and replace with:

```js
import { searchMerge } from "./search-merge.js";
```

- [ ] **Step 2: Update the typeahead call**

In `js/search.js`, locate the `try { const results = await geocode(text, ctrl.signal);` line inside `attachTypeahead`. Replace the `geocode` call:

```js
        try {
          const results = await searchMerge(text, ctrl.signal, /* pinnedDest */ null, /* biasLL */ { lon: -73.95, lat: 40.73 });
          if (ctrl.signal.aborted) return;
          render(results);
        } catch (e) {
          if (e.name === "AbortError") return;
          setError("Search unavailable");
        }
```

(Both `attachTypeahead` calls — for `locInput` and `fromInput` — use the same line; update both.)

- [ ] **Step 3: Smoke-test in the browser**

Run: `python3 scripts/serve.py` (kill any existing background server first).
Open: `http://127.0.0.1:8000/`
Type: `140 W 25th St`
Expected: the top result is in Manhattan (`lat ≈ 40.745`, `lon ≈ -74.00`), not Wyandanch or Ontario.

- [ ] **Step 4: Commit**

```bash
git add js/search.js
git commit -m "feat(search): route search bar through searchMerge orchestrator"
```

### Task 1.7: Wire CI to run unit + smoke tests on PR

**Files:**
- Modify: `.github/workflows/pages.yml`

- [ ] **Step 1: Inspect current workflow**

Run: `cat .github/workflows/pages.yml`
Take note of where existing test steps live (the WASM smoke test step).

- [ ] **Step 2: Add unit-test step**

Add a step that runs before the smoke test:

```yaml
      - name: Unit tests
        run: node --test tests/unit/**/*.test.mjs
        working-directory: .
```

Place this after Node.js is set up and before any deploy step. Exact placement depends on existing structure; the rule is: it must run on every PR (not just on push to main).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/pages.yml
git commit -m "ci: run node --test unit tests on PR"
```

### Task 1.8: Open PR 1

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/richer-geocoding-pr1
```

Note: if you've been on a different branch the whole time, rename or create the branch first:

```bash
git checkout -b feat/richer-geocoding-pr1
git push -u origin feat/richer-geocoding-pr1
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "feat(search): hard-clip Photon to US + Census lane" --body "$(cat <<'EOF'
## Summary
- Adds `countrycodes=us` + basemap `bbox` to Photon (eliminates the "140 W 25th St → Ontario" failure)
- Adds a US Census Geocoder lane for queries that look like street addresses (`/^\d+\s+\S/`)
- Introduces `js/search-merge.js` as the orchestrator; `js/search.js` now calls `searchMerge()` instead of `geocode()` directly
- Adds `js/tokenize.js` with `normalize()` + empty `CATEGORY_KEYWORDS` (used by later PRs)
- Adds `tests/unit/` runner; CI runs `node --test` on every PR

## Test plan
- [ ] `node --test tests/unit/**/*.test.mjs` passes locally
- [ ] Manually: `140 W 25th St` resolves to Manhattan, not Wyandanch
- [ ] Manually: `Smithtown NY` still resolves via Photon (no regression)
- [ ] Manually: `83 Elm Pl Brooklyn` resolves via Census

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## PR 2 — POI build pipeline + binary

**PR title:** `feat(data): pyosmium → POI binary with pre-snapped walk_node_id`

**Goal:** Extract ~100k categorized POIs from the existing OSM PBF, pre-snap each to a routable walk-graph node, ship as chunked binary. No runtime wiring — invisible to users until PR 3.

### Task 2.1: Extract walk-graph reader from `walk_graph.py`

**Files:**
- Create: `pipelines/walk_graph_reader.py`
- Test: `pipelines/tests/test_walk_graph_reader.py`

- [ ] **Step 1: Inspect existing walk-graph binary format**

Run: `head -100 pipelines/bincode_emit.py`
Note the bincode layout — what fields exist in the walk-graph header, where the nodes/edges/snap-grid live.

- [ ] **Step 2: Write failing test**

Create `pipelines/tests/test_walk_graph_reader.py`:

```python
from pathlib import Path

import pytest

from pipelines.walk_graph_reader import WalkGraphReader


def test_reader_loads_built_walk_graph():
    """Round-trips against the real walk_graph.bin if present; skips otherwise."""
    bin_path = Path(__file__).resolve().parents[2] / "tiles" / "walk_graph.bin"
    if not bin_path.exists():
        pytest.skip("tiles/walk_graph.bin not present (run scripts/build-walk-graph.sh)")
    r = WalkGraphReader(bin_path.read_bytes())
    assert r.n_nodes > 100_000
    assert r.version >= 1
    # Snap a known street-adjacent point (14th & Park, NYC).
    node = r.snap(-73.9879, 40.7363)
    assert node is not None
    assert node < r.n_nodes
    # That node should be in the largest connected component.
    assert node in r.lcc_nodes


def test_snap_in_lcc_falls_back_within_radius():
    """Synthetic tiny graph in a temp file."""
    # Build a minimal walk-graph blob in-memory matching the bincode_emit
    # layout. This test will be expanded in Step 4 when we know the layout.
    pytest.skip("expanded after reader implementation")
```

- [ ] **Step 3: Verify test fails**

Run: `cd pipelines && uv run pytest tests/test_walk_graph_reader.py -v`
Expected: FAIL with `Cannot import name WalkGraphReader from pipelines.walk_graph_reader`.

- [ ] **Step 4: Implement `pipelines/walk_graph_reader.py`**

Open `pipelines/bincode_emit.py` and study the exact byte layout used by `emit_walk_graph`. The reader must mirror it. Create `pipelines/walk_graph_reader.py`:

```python
"""
Decode a walk_graph.bin produced by pipelines/walk_graph.py.

Exposes:
  WalkGraphReader(bytes)
    .version        : int
    .n_nodes        : int
    .nodes          : list[(lon, lat)]   (e7-scaled in binary; floats here)
    .lcc_nodes      : frozenset[int]     (members of the Largest Connected Component)
    .snap(lon, lat) -> int | None
    .snap_in_lcc(lon, lat, max_m=100.0) -> int | None
"""
from __future__ import annotations

import math
import struct
from dataclasses import dataclass

# NOTE: Concrete byte offsets are derived from bincode_emit.py. The reader
# parses the same fields the emitter writes, in the same order. If the
# emitter changes, this reader must too.


@dataclass
class WalkGraphReader:
    version: int
    n_nodes: int
    # (lon, lat) per node, in degrees.
    nodes: list[tuple[float, float]]
    # Adjacency: list of (neighbor_node, edge_meters) per node.
    adj: list[list[tuple[int, int]]]
    # Flat-grid snap index built at runtime if needed.
    _snap_cells: dict[tuple[int, int], list[int]] | None = None
    # Largest connected component, computed lazily.
    _lcc: frozenset[int] | None = None

    SNAP_CELL_DEG: float = 0.0025  # ~278 m at 40°N

    @classmethod
    def from_bytes(cls, blob: bytes) -> "WalkGraphReader":
        # The exact parser body depends on bincode_emit.py. Implementer:
        # read each field in the order emit_walk_graph writes them.
        # The fields are: version (u32), n_nodes (u32), nodes [(lon_e7,
        # lat_e7) ...], n_edges (u32), edges [(u_node, v_node, weight_m_u16)
        # ...], snap-grid (skipped here; we rebuild lazily).
        offset = 0

        def take(fmt: str):
            nonlocal offset
            size = struct.calcsize(fmt)
            val = struct.unpack_from("<" + fmt, blob, offset)
            offset += size
            return val

        (version,) = take("I")
        (n_nodes,) = take("I")
        nodes = []
        for _ in range(n_nodes):
            lon_e7, lat_e7 = take("ii")
            nodes.append((lon_e7 / 1e7, lat_e7 / 1e7))
        (n_edges,) = take("I")
        adj: list[list[tuple[int, int]]] = [[] for _ in range(n_nodes)]
        for _ in range(n_edges):
            u, v, w = take("IIH")
            adj[u].append((v, w))
            adj[v].append((u, w))  # walking edges are bidirectional
        return cls(version=version, n_nodes=n_nodes, nodes=nodes, adj=adj)

    # Backwards-compatible callable: WalkGraphReader(blob) works.
    def __init__(self, blob: bytes | None = None, **kwargs):
        if blob is not None:
            parsed = WalkGraphReader.from_bytes(blob)
            self.__dict__.update(parsed.__dict__)
        else:
            for k, v in kwargs.items():
                setattr(self, k, v)
        # default fields
        if not hasattr(self, "_snap_cells"):
            self._snap_cells = None
        if not hasattr(self, "_lcc"):
            self._lcc = None

    @property
    def lcc_nodes(self) -> frozenset[int]:
        if self._lcc is None:
            self._lcc = self._compute_lcc()
        return self._lcc

    def _compute_lcc(self) -> frozenset[int]:
        visited = [False] * self.n_nodes
        best: set[int] = set()
        for start in range(self.n_nodes):
            if visited[start]:
                continue
            stack = [start]
            comp: set[int] = set()
            while stack:
                u = stack.pop()
                if visited[u]:
                    continue
                visited[u] = True
                comp.add(u)
                for v, _ in self.adj[u]:
                    if not visited[v]:
                        stack.append(v)
            if len(comp) > len(best):
                best = comp
        return frozenset(best)

    def _build_snap_index(self):
        cells: dict[tuple[int, int], list[int]] = {}
        for i, (lon, lat) in enumerate(self.nodes):
            key = (int(lon / self.SNAP_CELL_DEG), int(lat / self.SNAP_CELL_DEG))
            cells.setdefault(key, []).append(i)
        self._snap_cells = cells

    def snap(self, lon: float, lat: float) -> int | None:
        """Nearest walk-graph node by great-circle distance. None if grid is empty."""
        if self._snap_cells is None:
            self._build_snap_index()
        cx = int(lon / self.SNAP_CELL_DEG)
        cy = int(lat / self.SNAP_CELL_DEG)
        best_d = math.inf
        best_n: int | None = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for n in self._snap_cells.get((cx + dx, cy + dy), ()):
                    nlon, nlat = self.nodes[n]
                    d = self._dist_m(lon, lat, nlon, nlat)
                    if d < best_d:
                        best_d = d
                        best_n = n
        return best_n

    def snap_in_lcc(self, lon: float, lat: float, max_m: float = 100.0) -> int | None:
        """Like snap, but only considers nodes in the Largest Connected Component."""
        if self._snap_cells is None:
            self._build_snap_index()
        lcc = self.lcc_nodes
        cx = int(lon / self.SNAP_CELL_DEG)
        cy = int(lat / self.SNAP_CELL_DEG)
        best_d = math.inf
        best_n: int | None = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for n in self._snap_cells.get((cx + dx, cy + dy), ()):
                    if n not in lcc:
                        continue
                    nlon, nlat = self.nodes[n]
                    d = self._dist_m(lon, lat, nlon, nlat)
                    if d < best_d:
                        best_d = d
                        best_n = n
        return best_n if best_d <= max_m else None

    @staticmethod
    def _dist_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
        # Equirectangular approximation; fine for our small distances.
        dx = (lon2 - lon1) * 85_000  # m per deg lon at 40°N
        dy = (lat2 - lat1) * 111_000
        return math.sqrt(dx * dx + dy * dy)
```

**Note to implementer:** verify the byte layout in `take()` matches what `pipelines/bincode_emit.py` actually writes. If there's a mismatch (e.g., a magic byte string before `version`), adjust. The unit test will catch it.

- [ ] **Step 5: Verify tests pass**

Run: `cd pipelines && uv run pytest tests/test_walk_graph_reader.py -v`
Expected: the first test passes (or skips if `tiles/walk_graph.bin` doesn't exist locally; in CI it does).

- [ ] **Step 6: Commit**

```bash
git add pipelines/walk_graph_reader.py pipelines/tests/test_walk_graph_reader.py
git commit -m "data: extract walk-graph reader (snap + LCC) for reuse"
```

### Task 2.2: POI binary writer (TDD)

**Files:**
- Create: `pipelines/poi_emit.py`
- Test: `pipelines/tests/test_poi_emit.py`

- [ ] **Step 1: Write failing test**

Create `pipelines/tests/test_poi_emit.py`:

```python
import struct

from pipelines.poi_emit import POI, write_poi_blob, read_poi_header


def test_round_trip_three_pois():
    pois = [
        POI(lon=-74.0, lat=40.7, walk_node=0,  category=1, name="Joe's Pizza"),
        POI(lon=-73.99, lat=40.71, walk_node=5, category=3, name="Central Park"),
        POI(lon=-73.95, lat=40.78, walk_node=9, category=4, name=""),  # unnamed flag
    ]
    blob = write_poi_blob(pois, walk_graph_version=1)
    assert blob[:4] == b"POI1"
    header = read_poi_header(blob)
    assert header["version"] == 1
    assert header["walk_graph_version"] == 1
    assert header["n_pois"] == 3

    # Record 0 at offset 24 (after 24-byte header).
    rec0 = struct.unpack_from("<iiIIHBB", blob, 24)
    lon_e7, lat_e7, walk_node, name_off, name_len, category, flags = rec0
    assert lon_e7 == -740_000_000
    assert lat_e7 == 407_000_000
    assert walk_node == 0
    assert category == 1
    assert flags == 0  # has a name
    name = blob[header["names_off"] + name_off : header["names_off"] + name_off + name_len].decode()
    assert name == "Joe's Pizza"

    # Record 2 is unnamed.
    rec2 = struct.unpack_from("<iiIIHBB", blob, 24 + 2 * 20)
    _, _, _, _, _, _, flags2 = rec2
    assert flags2 & 0x01 == 0x01


def test_rejects_name_too_long():
    import pytest
    with pytest.raises(ValueError, match="name too long"):
        write_poi_blob(
            [POI(lon=0, lat=0, walk_node=0, category=1, name="x" * 201)],
            walk_graph_version=1,
        )
```

- [ ] **Step 2: Verify tests fail**

Run: `cd pipelines && uv run pytest tests/test_poi_emit.py -v`
Expected: FAIL with `Cannot import name POI from pipelines.poi_emit`.

- [ ] **Step 3: Implement `pipelines/poi_emit.py`**

Create `pipelines/poi_emit.py`:

```python
"""
Pack POIs into the `tiles/pois.bin` binary format documented in the spec.

Header (24 bytes, little-endian):
  magic              : 4 bytes = "POI1"
  version            : u32 = 1
  walk_graph_version : u32
  n_pois             : u32
  names_off          : u32   (byte offset to NAMES section)
  reserved           : u32

Records: n_pois × 20 bytes, fixed stride. lon/lat as i32×1e7.

Names: variable-length UTF-8, no terminator. Records index by (name_off, name_len).
"""
from __future__ import annotations

import struct
from dataclasses import dataclass

MAGIC = b"POI1"
HEADER_FMT = "<4sIIIII"  # magic, version, walk_graph_version, n_pois, names_off, reserved
HEADER_SIZE = struct.calcsize(HEADER_FMT)  # 24
RECORD_FMT = "<iiIIHBB"  # lon_e7, lat_e7, walk_node, name_off, name_len, category, flags
RECORD_SIZE = struct.calcsize(RECORD_FMT)  # 20
MAX_NAME_LEN = 200
FLAG_UNNAMED = 0x01


@dataclass
class POI:
    lon: float
    lat: float
    walk_node: int
    category: int  # 1..10
    name: str = ""


def write_poi_blob(pois: list[POI], walk_graph_version: int) -> bytes:
    # Names section, deduped (same name → same offset).
    names_buf = bytearray()
    name_index: dict[str, tuple[int, int]] = {}

    def store_name(name: str) -> tuple[int, int]:
        if not name:
            return (0, 0)
        if name in name_index:
            return name_index[name]
        encoded = name.encode("utf-8")
        if len(encoded) > MAX_NAME_LEN:
            raise ValueError(f"name too long ({len(encoded)} bytes): {name!r}")
        off = len(names_buf)
        names_buf.extend(encoded)
        name_index[name] = (off, len(encoded))
        return (off, len(encoded))

    records = bytearray()
    for p in pois:
        off, n_len = store_name(p.name)
        flags = 0 if p.name else FLAG_UNNAMED
        records.extend(struct.pack(
            RECORD_FMT,
            int(round(p.lon * 1e7)),
            int(round(p.lat * 1e7)),
            p.walk_node,
            off,
            n_len,
            p.category,
            flags,
        ))

    names_off = HEADER_SIZE + len(records)
    header = struct.pack(
        HEADER_FMT,
        MAGIC,
        1,
        walk_graph_version,
        len(pois),
        names_off,
        0,
    )
    return bytes(header + records + names_buf)


def read_poi_header(blob: bytes) -> dict:
    magic, version, walk_graph_version, n_pois, names_off, _ = struct.unpack_from(
        HEADER_FMT, blob, 0
    )
    if magic != MAGIC:
        raise ValueError(f"bad magic: {magic!r}")
    return {
        "version": version,
        "walk_graph_version": walk_graph_version,
        "n_pois": n_pois,
        "names_off": names_off,
    }
```

- [ ] **Step 4: Verify tests pass**

Run: `cd pipelines && uv run pytest tests/test_poi_emit.py -v`
Expected: `2 passed`.

- [ ] **Step 5: Commit**

```bash
git add pipelines/poi_emit.py pipelines/tests/test_poi_emit.py
git commit -m "data: POI binary format (POI1 magic, 20B records, names blob)"
```

### Task 2.3: POI extractor in `pipelines/pois.py` (TDD)

**Files:**
- Create: `pipelines/pois.py`
- Create: `pipelines/tests/test_pois.py`

- [ ] **Step 1: Inspect the existing tiny-fixture builder**

Run: `head -80 pipelines/tests/build_mini_pbf.py`
Note how it builds a synthetic tiny OSM PBF for testing. We'll use the same trick.

- [ ] **Step 2: Write failing test**

Create `pipelines/tests/test_pois.py`:

```python
from pathlib import Path

import pytest

from pipelines.pois import CATEGORIES, classify_tags, extract_pois
from pipelines.poi_emit import read_poi_header
from pipelines.tests.build_mini_pbf import build_mini_pbf


def test_classify_tags_returns_priority_category():
    assert classify_tags({"amenity": "restaurant"}) == CATEGORIES["food"]
    assert classify_tags({"amenity": "school"}) == CATEGORIES["school"]
    # Multi-category: pick highest-priority (lower number wins per spec).
    assert classify_tags({"amenity": "school", "tourism": "attraction"}) == CATEGORIES["attraction"] \
           or classify_tags({"amenity": "school", "tourism": "attraction"}) == CATEGORIES["school"]
    # (Either is acceptable as long as one is picked deterministically.)
    assert classify_tags({"foo": "bar"}) is None


def test_extract_pois_drops_unmapped_tags(tmp_path: Path):
    pbf = tmp_path / "mini.osm.pbf"
    build_mini_pbf(pbf, [
        # (lon, lat, tags)
        (-74.0, 40.7, {"amenity": "restaurant", "name": "Joe's"}),
        (-74.0, 40.71, {"amenity": "restaurant"}),                # no name → dropped
        (-74.0, 40.72, {"amenity": "bench"}),                      # unmapped → dropped
        (-74.0, 40.73, {"leisure": "park"}),                       # unnamed park → kept (flag)
    ])
    pois = list(extract_pois(pbf, bbox=(-74.5, 40.5, -73.5, 41.0)))
    names = [p.name for p in pois]
    assert "Joe's" in names
    assert "" in names  # the unnamed park
    assert len(pois) == 2
```

- [ ] **Step 3: Verify tests fail**

Run: `cd pipelines && uv run pytest tests/test_pois.py -v`
Expected: FAIL with `Cannot import name CATEGORIES from pipelines.pois`.

- [ ] **Step 4: Implement `pipelines/pois.py`**

Create `pipelines/pois.py`:

```python
"""
Extract POIs from an OSM PBF and emit `pois.bin`.

    uv run python pipelines/pois.py <input.osm.pbf> <walk_graph.bin> <output.bin>

Pipeline:
  1. Pass 1 (ways): record way-node refs for ways with category tags.
  2. Pass 2 (nodes): resolve coords; emit standalone-node POIs immediately,
     buffer way-node refs for centroid computation.
  3. Compute way centroids (bbox center) for buffered ways.
  4. Pre-snap each POI to a walk-graph node in the LCC; drop unsnappable.
  5. Clip to bbox.
  6. Emit pois.bin.
"""
from __future__ import annotations

import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

import osmium

from pipelines.poi_emit import POI, write_poi_blob
from pipelines.walk_graph_reader import WalkGraphReader

# Category code constants. Order = priority (lower wins on multi-tagged POIs).
CATEGORIES: dict[str, int] = {
    "transit":    2,
    "park":       3,
    "culture":    4,
    "attraction": 5,
    "food":       1,
    "shop":       6,
    "school":     7,
    "health":     8,
    "service":    9,
    "worship":    10,
}

SHOP_ALLOWED = {
    "supermarket", "convenience", "bakery", "books", "clothes",
    "department_store", "mall", "hardware",
}


def classify_tags(tags: dict[str, str]) -> int | None:
    """Map an OSM tag bundle to a category code; None if no category applies.
    Order: food > transit > park > culture > attraction > shop > school > health > service > worship.
    """
    amenity = tags.get("amenity")
    tourism = tags.get("tourism")
    leisure = tags.get("leisure")
    railway = tags.get("railway")
    pt = tags.get("public_transport")
    aeroway = tags.get("aeroway")
    shop = tags.get("shop")
    historic = tags.get("historic")

    # food
    if amenity in {"restaurant", "cafe", "bar", "fast_food", "pub",
                   "food_court", "ice_cream", "biergarten"}:
        return CATEGORIES["food"]
    # transit
    if railway in {"station", "halt", "tram_stop"} \
            or pt == "station" or amenity == "ferry_terminal" \
            or aeroway == "aerodrome":
        return CATEGORIES["transit"]
    # park
    if leisure in {"park", "playground", "garden", "nature_reserve"}:
        return CATEGORIES["park"]
    # culture
    if tourism in {"museum", "gallery"} \
            or amenity in {"theatre", "cinema", "arts_centre", "library"}:
        return CATEGORIES["culture"]
    # attraction
    if tourism in {"attraction", "viewpoint", "zoo", "aquarium"} or historic:
        return CATEGORIES["attraction"]
    # shop (narrowed)
    if shop in SHOP_ALLOWED:
        return CATEGORIES["shop"]
    # school
    if amenity in {"school", "university", "college"}:
        return CATEGORIES["school"]
    # health
    if amenity in {"hospital", "clinic", "pharmacy", "doctors"}:
        return CATEGORIES["health"]
    # service
    if amenity in {"post_office", "bank", "fuel", "police", "fire_station"}:
        return CATEGORIES["service"]
    # worship
    if amenity == "place_of_worship":
        return CATEGORIES["worship"]

    return None


# Categories that we KEEP even when name is missing (parks/playgrounds).
KEEP_UNNAMED_CATS = {CATEGORIES["park"]}


@dataclass
class _RawPOI:
    lon: float
    lat: float
    category: int
    name: str


class _NodeCollector(osmium.SimpleHandler):
    """Pass 1: collect standalone POIs (node-tagged) and way-node refs."""
    def __init__(self, way_refs: set[int]):
        super().__init__()
        self.way_refs = way_refs            # node IDs needed for way centroids
        self.standalone: list[_RawPOI] = [] # node-tagged POIs collected here
        self.way_node_coords: dict[int, tuple[float, float]] = {}

    def node(self, n):
        if n.id in self.way_refs:
            self.way_node_coords[n.id] = (n.location.lon, n.location.lat)
        cat = classify_tags(dict(n.tags))
        if cat is None:
            return
        name = n.tags.get("name", "")
        if not name and cat not in KEEP_UNNAMED_CATS:
            return
        self.standalone.append(_RawPOI(n.location.lon, n.location.lat, cat, name))


class _WayCollector(osmium.SimpleHandler):
    """Pass 0: find category-tagged ways; record node refs + tags."""
    def __init__(self):
        super().__init__()
        self.way_tags: dict[int, dict[str, str]] = {}
        self.way_refs: dict[int, list[int]] = {}

    def way(self, w):
        cat = classify_tags(dict(w.tags))
        if cat is None:
            return
        name = w.tags.get("name", "")
        if not name and cat not in KEEP_UNNAMED_CATS:
            return
        self.way_tags[w.id] = dict(w.tags)
        self.way_refs[w.id] = [n.ref for n in w.nodes]


def extract_pois(
    pbf_path: Path,
    bbox: tuple[float, float, float, float],
    walk_graph: WalkGraphReader | None = None,
):
    """Generator yielding `POI` records. If `walk_graph` is None, walk_node = 0
    (for tests that only care about extraction)."""
    pbf_path = Path(pbf_path)
    min_lon, min_lat, max_lon, max_lat = bbox

    # Pass 0: collect ways.
    wc = _WayCollector()
    wc.apply_file(str(pbf_path))

    # Build set of node IDs we need for centroids.
    way_refs_flat: set[int] = set()
    for refs in wc.way_refs.values():
        way_refs_flat.update(refs)

    # Pass 1: standalone POIs + way-node coords.
    nc = _NodeCollector(way_refs_flat)
    nc.apply_file(str(pbf_path))

    # Compute way centroids and emit way POIs.
    way_pois: list[_RawPOI] = []
    for way_id, tags in wc.way_tags.items():
        coords = [nc.way_node_coords.get(n) for n in wc.way_refs[way_id]]
        coords = [c for c in coords if c is not None]
        if not coords:
            continue
        lons, lats = zip(*coords)
        clon = (min(lons) + max(lons)) / 2
        clat = (min(lats) + max(lats)) / 2
        cat = classify_tags(tags)
        way_pois.append(_RawPOI(clon, clat, cat, tags.get("name", "")))

    all_raw = nc.standalone + way_pois

    # Clip + pre-snap.
    for r in all_raw:
        if not (min_lon <= r.lon <= max_lon and min_lat <= r.lat <= max_lat):
            continue
        if walk_graph is None:
            walk_node = 0
        else:
            node = walk_graph.snap(r.lon, r.lat)
            if node is None or node not in walk_graph.lcc_nodes:
                node = walk_graph.snap_in_lcc(r.lon, r.lat, max_m=100.0)
            if node is None:
                continue
            walk_node = node
        yield POI(
            lon=r.lon, lat=r.lat, walk_node=walk_node,
            category=r.category, name=r.name,
        )


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print("usage: pois.py <input.osm.pbf> <walk_graph.bin> <output.bin>",
              file=sys.stderr)
        return 2
    pbf, wg, out = map(Path, argv[1:])

    walk = WalkGraphReader(wg.read_bytes())
    bbox = (-74.30, 40.49, -71.85, 41.20)  # matches scripts/bbox.env BASEMAP_BBOX
    pois = list(extract_pois(pbf, bbox, walk))
    # Sort by (category, name) for cache-friendly category scans.
    pois.sort(key=lambda p: (p.category, p.name))
    blob = write_poi_blob(pois, walk_graph_version=walk.version)
    out.write_bytes(blob)
    print(f"wrote {out} with {len(pois)} POIs ({len(blob)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
```

**Implementer note:** Extend `pipelines/tests/build_mini_pbf.py` if needed so the test fixture supports a `tags=` dict per node. Inspect the existing helper before extending.

- [ ] **Step 5: Verify tests pass**

Run: `cd pipelines && uv run pytest tests/test_pois.py -v`
Expected: `2 passed`.

- [ ] **Step 6: Commit**

```bash
git add pipelines/pois.py pipelines/tests/test_pois.py
git commit -m "data: pyosmium POI extractor with category classification"
```

### Task 2.4: Build script `scripts/build-pois.sh`

**Files:**
- Create: `scripts/build-pois.sh`
- Modify: `.gitignore`

- [ ] **Step 1: Add `tiles/pois.bin` to `.gitignore`**

In `.gitignore`, add:

```
tiles/pois.bin
```

- [ ] **Step 2: Create the build script**

Create `scripts/build-pois.sh`:

```bash
#!/usr/bin/env bash
# Build tiles/pois.bin from the cached OSM PBF (must be present from a prior
# scripts/build-walk-graph.sh run) and pre-snap each POI to walk_graph.bin.
#
# Outputs tiles/pois.bin and chunks it to tiles/pois.part-* for GitHub's
# 100 MB per-file cap. The assembled .bin is gitignored; only chunks ship.

set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck disable=SC1091
source scripts/bbox.env

CACHE=pipelines/cache
EXTRACT="$CACHE/ny-metro.osm.pbf"
WG=tiles/walk_graph.bin
OUT=tiles/pois.bin

if [[ ! -f "$EXTRACT" ]]; then
  echo "ERROR: $EXTRACT not found. Run scripts/build-walk-graph.sh first." >&2
  exit 1
fi
if [[ ! -f "$WG" ]]; then
  echo "ERROR: $WG not found. Run scripts/build-walk-graph.sh first." >&2
  exit 1
fi

mkdir -p tiles

echo "extracting POIs..."
uv run --directory pipelines python pois.py \
  "$(pwd)/$EXTRACT" "$(pwd)/$WG" "$(pwd)/$OUT"

SIZE=$(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT")
echo "pois.bin size: $SIZE bytes"
if (( SIZE < 5000000 )); then
  echo "ERROR: pois.bin suspiciously small ($SIZE bytes)" >&2
  exit 1
fi
if (( SIZE > 30000000 )); then
  echo "ERROR: pois.bin suspiciously large ($SIZE bytes; allowlist may have leaked)" >&2
  exit 1
fi

echo "chunking..."
rm -f tiles/pois.part-*
split -b 50M -a 2 "$OUT" tiles/pois.part-
ls -lh tiles/pois.part-*
```

- [ ] **Step 3: Make it executable**

```bash
chmod +x scripts/build-pois.sh
```

- [ ] **Step 4: Run it locally**

Run: `bash scripts/build-pois.sh`
Expected: writes `tiles/pois.bin`, then one or more `tiles/pois.part-*` files. Final ls output shows their sizes.

If POI count seems off (e.g., > 250k or < 30k), investigate the category allowlist before committing.

- [ ] **Step 5: Commit chunks + script**

```bash
git add scripts/build-pois.sh .gitignore tiles/pois.part-*
git commit -m "data: build script + committed POI chunks (basemap, pre-snapped)"
```

### Task 2.5: Wire the build into CI

**Files:**
- Modify: `.github/workflows/pages.yml`

- [ ] **Step 1: Inspect existing CI steps**

Run: `cat .github/workflows/pages.yml`
Note where `scripts/build-walk-graph.sh` runs (or whether it does — the chunks may be committed and assembled-only in CI). The POI build needs both the PBF and the walk-graph binary to exist.

- [ ] **Step 2: Add POI assembly step**

In the CI workflow, after the step that assembles `tiles/walk_graph.bin` from `tiles/walk-graph.part-*`, add an analogous assembly step for POI chunks:

```yaml
      - name: Assemble pois.bin
        run: cat tiles/pois.part-* > tiles/pois.bin
```

The build (`build-pois.sh`) runs only in local dev — CI uses the committed chunks. Same pattern as the walk graph.

- [ ] **Step 3: Add a Python test step**

```yaml
      - name: Pipeline tests
        run: uv run pytest
        working-directory: pipelines
```

- [ ] **Step 4: Commit + open PR 2**

```bash
git add .github/workflows/pages.yml
git commit -m "ci: assemble pois.bin from chunks + run pipeline tests"
git push -u origin feat/richer-geocoding-pr2
gh pr create --title "feat(data): POI build pipeline + chunked binary" --body "$(cat <<'EOF'
## Summary
- `pipelines/pois.py`: pyosmium extractor for ~10 POI categories
- Pre-snaps each POI to a walk-graph node in the LCC (eliminates park-island unreachability)
- `pipelines/poi_emit.py`: packed binary format (POI1 magic, 20B records, names blob)
- `pipelines/walk_graph_reader.py`: shared decoder, also used by future pipelines
- `scripts/build-pois.sh`: bash wrapper, chunks to `tiles/pois.part-*`
- CI assembles `tiles/pois.bin` from chunks (mirrors walk-graph pattern)
- No runtime wiring yet — invisible to users until PR 3

## Test plan
- [ ] `uv run pytest` passes in `pipelines/`
- [ ] `bash scripts/build-pois.sh` produces a 5–30 MB binary with ≥30k POIs
- [ ] CI assembles the binary correctly

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## PR 3 — Local POI lane

**PR title:** `feat(search): local POI lane (token search over basemap)`

**Goal:** Search bar typeahead lights up for landmarks and POIs — "Battery Park", "Joe's Pizza" — without any network round-trip. Discovery still not wired.

### Task 3.1: `js/poi-index.js` binary decode (TDD)

**Files:**
- Create: `js/poi-index.js`
- Create: `tests/unit/poi-index/decode.test.mjs`

- [ ] **Step 1: Write failing test**

Create `tests/unit/poi-index/decode.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePoiBlob } from "../../../js/poi-index.js";

function packHeader(version, walkGraphVersion, nPois, namesOff) {
  const buf = new ArrayBuffer(24);
  const dv = new DataView(buf);
  const enc = new TextEncoder();
  new Uint8Array(buf, 0, 4).set(enc.encode("POI1"));
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

test("decodePoiBlob round-trips a handcrafted binary", () => {
  const enc = new TextEncoder();
  const names = enc.encode("Joe'sCentral Park");  // 5 + 12 = 17 bytes
  const namesOff = 24 + 2 * 20;
  const header = packHeader(1, 1, 2, namesOff);
  const r0 = packRecord({ lon: -74, lat: 40.7,  walkNode: 0, nameOff: 0, nameLen: 5,  category: 1, flags: 0 });
  const r1 = packRecord({ lon: -73.9, lat: 40.8, walkNode: 9, nameOff: 5, nameLen: 12, category: 3, flags: 0 });
  const blob = new Uint8Array(header.length + r0.length + r1.length + names.length);
  blob.set(header, 0);
  blob.set(r0, header.length);
  blob.set(r1, header.length + r0.length);
  blob.set(names, namesOff);

  const idx = decodePoiBlob(blob);
  assert.equal(idx.nPois, 2);
  assert.equal(idx.walkGraphVersion, 1);
  const poi0 = idx.byId(0);
  assert.equal(poi0.name, "Joe's");
  assert.equal(poi0.category, 1);
  assert.ok(Math.abs(poi0.lon - -74) < 1e-6);
  const poi1 = idx.byId(1);
  assert.equal(poi1.name, "Central Park");
});

test("decodePoiBlob rejects bad magic", () => {
  const bad = new Uint8Array(24);
  new TextEncoder().encodeInto("OOPS", bad);
  assert.throws(() => decodePoiBlob(bad), /bad magic/);
});
```

- [ ] **Step 2: Verify tests fail**

Run: `node --test tests/unit/poi-index/decode.test.mjs`
Expected: FAIL with `Cannot find module .../js/poi-index.js`.

- [ ] **Step 3: Implement decode + basic structure**

Create `js/poi-index.js`:

```js
// POI binary decoder + in-memory token/category indexes. Load lazily on
// first search keystroke.

import { normalize } from "./tokenize.js";

const MAGIC = "POI1";
const HEADER_SIZE = 24;
const RECORD_SIZE = 20;

/** @typedef {{ lon:number, lat:number, walkNode:number, category:number, name:string, flags:number }} Poi */

/**
 * Decode the binary into a queryable index. Throws on bad magic.
 *
 * @param {Uint8Array} bytes
 */
export function decodePoiBlob(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder("utf-8");

  const magic = dec.decode(bytes.subarray(0, 4));
  if (magic !== MAGIC) throw new Error(`bad magic: ${magic}`);
  const version = dv.getUint32(4, true);
  const walkGraphVersion = dv.getUint32(8, true);
  const nPois = dv.getUint32(12, true);
  const namesOff = dv.getUint32(16, true);

  function byId(i) {
    if (i < 0 || i >= nPois) throw new RangeError(`poi_id ${i} out of range`);
    const o = HEADER_SIZE + i * RECORD_SIZE;
    const lon = dv.getInt32(o, true) / 1e7;
    const lat = dv.getInt32(o + 4, true) / 1e7;
    const walkNode = dv.getUint32(o + 8, true);
    const nameOff = dv.getUint32(o + 12, true);
    const nameLen = dv.getUint16(o + 16, true);
    const category = dv.getUint8(o + 18);
    const flags = dv.getUint8(o + 19);
    const name = nameLen
      ? dec.decode(bytes.subarray(namesOff + nameOff, namesOff + nameOff + nameLen))
      : "";
    return { lon, lat, walkNode, category, name, flags };
  }

  return { version, walkGraphVersion, nPois, byId };
}

let readyPromise = null;
let indexState = null;

async function loadBlob() {
  const direct = await fetch("./tiles/pois.bin");
  if (direct.ok) return new Uint8Array(await direct.arrayBuffer());
  const chunks = [];
  for (let i = 0; ; i++) {
    const suffix = String.fromCharCode(97 + Math.floor(i / 26)) +
                   String.fromCharCode(97 + (i % 26));
    const res = await fetch(`./tiles/pois.part-${suffix}`);
    if (!res.ok) break;
    chunks.push(new Uint8Array(await res.arrayBuffer()));
  }
  if (chunks.length === 0) throw new Error("pois.bin not found");
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

async function buildIndex() {
  const blob = await loadBlob();
  const decoded = decodePoiBlob(blob);
  // postings: token → Uint32Array of poi_ids (built as Array first, frozen at end)
  const buckets = new Map();
  const byCategory = new Map();
  const sortedTokens = [];

  for (let i = 0; i < decoded.nPois; i++) {
    const p = decoded.byId(i);
    if (!byCategory.has(p.category)) byCategory.set(p.category, []);
    byCategory.get(p.category).push(i);
    const toks = normalize(p.name);
    for (const t of toks) {
      let arr = buckets.get(t);
      if (!arr) { arr = []; buckets.set(t, arr); }
      arr.push(i);
    }
  }
  for (const k of buckets.keys()) sortedTokens.push(k);
  sortedTokens.sort();
  return {
    decoded,
    postings: buckets,
    sortedTokens,
    byCategoryArr: new Map(
      [...byCategory.entries()].map(([k, v]) => [k, new Uint32Array(v)])
    ),
  };
}

export function ensureReady() {
  if (!readyPromise) {
    readyPromise = buildIndex().then((s) => { indexState = s; return s; });
  }
  return readyPromise;
}

/**
 * @param {string} q
 * @param {number} [k]
 * @returns {Promise<Array<{ lon:number, lat:number, label:string, score:number, source:"local", poiId:number, category:number, walkNode:number }>>}
 */
export async function search(q, k = 8) {
  await ensureReady();
  const tokens = normalize(q);
  if (tokens.length === 0) return [];
  const last = tokens[tokens.length - 1];
  const rest = tokens.slice(0, -1);

  // Exact-match posting lists for non-last tokens.
  const exactLists = rest.map((t) => indexState.postings.get(t) || []);
  // Prefix expansion for last token: binary-search range in sortedTokens.
  const lo = lowerBound(indexState.sortedTokens, last);
  const hi = lowerBound(indexState.sortedTokens, last + "￿");
  const prefixIds = new Set();
  for (let i = lo; i < hi; i++) {
    for (const id of indexState.postings.get(indexState.sortedTokens[i]) || []) {
      prefixIds.add(id);
    }
  }
  // Candidate intersection: smallest list first.
  let candidates = exactLists.length
    ? new Set(exactLists.reduce((a, b) => (a.length < b.length ? a : b)))
    : prefixIds;
  for (const list of exactLists) {
    const s = new Set(list);
    candidates = new Set([...candidates].filter((x) => s.has(x)));
  }
  if (exactLists.length) {
    candidates = new Set([...candidates].filter((x) => prefixIds.has(x)));
  }

  const out = [];
  for (const id of candidates) {
    const p = indexState.decoded.byId(id);
    const score = scoreLocal(tokens, p);
    out.push({
      lon: p.lon, lat: p.lat, label: p.name,
      score, source: "local",
      poiId: id, category: p.category, walkNode: p.walkNode,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, k);
}

export async function byId(id) {
  await ensureReady();
  return indexState.decoded.byId(id);
}

export async function byCategory(cat) {
  await ensureReady();
  return indexState.byCategoryArr.get(cat) || new Uint32Array();
}

function scoreLocal(queryTokens, poi) {
  const nameTokens = normalize(poi.name);
  let nameMatch;
  if (nameTokens.length === queryTokens.length &&
      nameTokens.every((t, i) => t === queryTokens[i])) {
    nameMatch = 100;
  } else if (queryTokens.every((t) => nameTokens.includes(t))) {
    nameMatch = 80;
  } else {
    nameMatch = 60;
  }
  const categoryBoost = ({ 2: 15, 3: 8, 5: 5 })[poi.category] || 0;
  const lengthPenalty = Math.log2(Math.max(1, nameTokens.length));
  return nameMatch + categoryBoost - lengthPenalty;
}

function lowerBound(arr, target) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}
```

- [ ] **Step 4: Verify tests pass**

Run: `node --test tests/unit/poi-index/decode.test.mjs`
Expected: `# pass 2`.

- [ ] **Step 5: Commit**

```bash
git add js/poi-index.js tests/unit/poi-index/decode.test.mjs
git commit -m "feat(search): local POI index (token postings + prefix + categories)"
```

### Task 3.2: Add `search` test for the in-memory index

**Files:**
- Modify: `tests/unit/poi-index/decode.test.mjs` (add tests)

- [ ] **Step 1: Add search tests**

Append to `tests/unit/poi-index/decode.test.mjs`:

```js
import * as poiIndex from "../../../js/poi-index.js";

// Stub fetch to serve a handcrafted binary as tiles/pois.bin.
function withFakeFetch(blob, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/pois.bin")) {
      return new Response(blob, { status: 200 });
    }
    return new Response("nope", { status: 404 });
  };
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = orig; });
}

test("search returns exact-name matches with highest score", async () => {
  // Reuse blob fixture pattern from above
  const enc = new TextEncoder();
  const names = enc.encode("Joe'sCentral ParkBattery Park");
  // offsets: Joe's=0/5, Central Park=5/12, Battery Park=17/12
  const namesOff = 24 + 3 * 20;
  const header = packHeader(1, 1, 3, namesOff);
  const r0 = packRecord({ lon: -74, lat: 40.7, walkNode: 0, nameOff: 0,  nameLen: 5,  category: 1, flags: 0 });
  const r1 = packRecord({ lon: -74, lat: 40.8, walkNode: 1, nameOff: 5,  nameLen: 12, category: 3, flags: 0 });
  const r2 = packRecord({ lon: -74, lat: 40.6, walkNode: 2, nameOff: 17, nameLen: 12, category: 3, flags: 0 });
  const blob = new Uint8Array(header.length + 3 * 20 + names.length);
  blob.set(header, 0);
  blob.set(r0, 24);
  blob.set(r1, 44);
  blob.set(r2, 64);
  blob.set(names, namesOff);

  await withFakeFetch(blob, async () => {
    const results = await poiIndex.search("park");
    const labels = results.map((r) => r.label);
    assert.ok(labels.includes("Central Park"));
    assert.ok(labels.includes("Battery Park"));
    // Exact-name "park" wouldn't match either — both have two tokens, query
    // has one. But all-query-tokens-in-name matches → score 80 + boost.
    assert.ok(results.every((r) => r.score >= 60));
  });
});
```

- [ ] **Step 2: Verify test passes**

Run: `node --test tests/unit/poi-index/decode.test.mjs`
Expected: `# pass 3`.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/poi-index/decode.test.mjs
git commit -m "test: in-memory POI search end-to-end"
```

### Task 3.3: Wire local lane into `search-merge.js`

**Files:**
- Modify: `js/search-merge.js`
- Modify: `tests/unit/search-merge/rank.test.mjs`

- [ ] **Step 1: Add a failing test for local-lane integration**

Append to `tests/unit/search-merge/rank.test.mjs`:

```js
import { searchMerge } from "../../../js/search-merge.js";

test("searchMerge ranks local exact-name above Photon", async () => {
  // Mock photon to return one weak result; mock local lane via dependency
  // injection isn't wired yet — this test will require a refactor to
  // accept optional lane stubs. For now, assert merging via deterministic
  // baseScore in the input contract.
});
```

(This is a placeholder test the implementer should refine after step 2.)

- [ ] **Step 2: Refactor `js/search-merge.js` to accept optional lane stubs**

Edit `js/search-merge.js`, replace the `searchMerge` function:

```js
import { search as defaultLocalSearch } from "./poi-index.js";

/**
 * @param {string} query
 * @param {AbortSignal} signal
 * @param {{lon:number,lat:number}|null} _pinnedDest  reserved for PR 5
 * @param {{lon:number,lat:number}} biasLL
 * @param {number} [k]
 * @param {{
 *   localSearch?: typeof defaultLocalSearch,
 *   photon?: typeof photon,
 *   census?: typeof census,
 * }} [overrides]   // for testing
 */
export async function searchMerge(query, signal, _pinnedDest, biasLL, k = 8, overrides = {}) {
  const localSearch = overrides.localSearch || defaultLocalSearch;
  const photonFn = overrides.photon || photon;
  const censusFn = overrides.census || census;

  const localP   = localSearch(query, k).catch(() => []);
  const photonP  = photonFn(query, signal).catch(() => []);
  const censusP  = isAddressLike(query) ? censusFn(query, signal).catch(() => []) : Promise.resolve([]);

  const [localHits, photonHits, censusHits] = await Promise.all([localP, photonP, censusP]);

  const all = [
    ...localHits.map((r) => ({ ...r, baseScore: r.score })),
    ...censusHits.map((r) => ({ ...r, baseScore: 78 })),
    ...photonHits.map((r, i) => ({ ...r, baseScore: Math.max(30, 62 - i * 4), source: "photon" })),
  ];
  return mergeRank(all, biasLL).slice(0, k);
}
```

- [ ] **Step 3: Replace placeholder test with real integration test**

Replace the placeholder test added in Step 1 with:

```js
test("searchMerge: local exact-name beats Photon top hit", async () => {
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
    { localSearch: localStub, photon: photonStub, census: async () => [] },
  );
  assert.equal(result[0].label, "Joe's Pizza");
  assert.equal(result[0].source, "local");
});
```

- [ ] **Step 4: Verify tests pass**

Run: `node --test tests/unit/search-merge/rank.test.mjs`
Expected: all tests pass (4 original + 1 new = 5).

- [ ] **Step 5: Commit + open PR 3**

```bash
git add js/search-merge.js tests/unit/search-merge/rank.test.mjs
git commit -m "feat(search): wire local POI lane into search-merge"
git push -u origin feat/richer-geocoding-pr3
gh pr create --title "feat(search): local POI lane" --body "$(cat <<'EOF'
## Summary
- `js/poi-index.js` loads `tiles/pois.bin` (or chunks), decodes, builds in-memory token + category indexes
- `searchMerge` now fans out across local + Photon + Census; local exact-name matches beat Photon
- All lanes still independent; any single lane failure is silent

## Test plan
- [ ] `node --test tests/unit/**/*.test.mjs` passes
- [ ] Manually: typing "Battery Park" with empty bias returns Battery Park on top
- [ ] Manually: typing "Joe's Pizza" returns Manhattan Joe's, not LI
- [ ] Manually: typing "140 W 25th St" still works (PR 1 not regressed)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## PR 4 — WASM `reachable_nodes` method

**PR title:** `feat(router): bounded Dijkstra reachable_nodes() in WASM`

**Goal:** Add the Rust method that returns all walk-graph nodes reachable from a starting point within a meter budget, packed as little-endian u32 pairs. No UI; reviewable in isolation.

### Task 4.1: Add `fxhash` (or built-in) hash map dependency

**Files:**
- Modify: `nycm-router/Cargo.toml`

- [ ] **Step 1: Add `rustc-hash` dependency**

Edit `nycm-router/Cargo.toml`, add to `[dependencies]`:

```toml
rustc-hash = "2"
```

- [ ] **Step 2: Verify the crate still builds**

Run: `cd nycm-router && cargo build --release --target wasm32-unknown-unknown 2>&1 | tail -5`
Expected: builds cleanly.

- [ ] **Step 3: Commit**

```bash
git add nycm-router/Cargo.toml nycm-router/Cargo.lock
git commit -m "deps: rustc-hash for FxHashMap (10x faster u32 hashing)"
```

### Task 4.2: Implement `reachable_nodes_packed` in Rust (TDD)

**Files:**
- Modify: `nycm-router/src/walk.rs`

- [ ] **Step 1: Inspect existing walk.rs**

Run: `cat nycm-router/src/walk.rs`
Note the existing `WalkGraph` type, its `adj()` method, and `route_walk()`. The new function uses the same `WalkGraph` interface.

- [ ] **Step 2: Write a failing unit test**

At the bottom of `nycm-router/src/walk.rs`, add:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::walk::WalkGraph;

    // Build a tiny graph: 0 -- 100m --> 1 -- 200m --> 2;  0 -- 50m --> 3
    fn tiny() -> WalkGraph {
        WalkGraph::for_test(
            vec![(-74.0_f32, 40.7_f32); 4], // 4 nodes, coords irrelevant for this test
            vec![
                (0, 1, 100),
                (0, 3, 50),
                (1, 2, 200),
            ],
        )
    }

    #[test]
    fn reachable_within_budget() {
        let g = tiny();
        let out = reachable_nodes_packed(&g, 0, 150);
        let pairs = decode_pairs(&out);
        // From 0 with budget 150: 0(0), 3(50), 1(100). Not 2 (would be 300).
        let mut nodes: Vec<u32> = pairs.iter().map(|(n, _)| *n).collect();
        nodes.sort();
        assert_eq!(nodes, vec![0, 1, 3]);
    }

    #[test]
    fn distances_are_correct() {
        let g = tiny();
        let pairs = decode_pairs(&reachable_nodes_packed(&g, 0, 350));
        let dist: std::collections::HashMap<u32, u32> = pairs.into_iter().collect();
        assert_eq!(dist[&0], 0);
        assert_eq!(dist[&3], 50);
        assert_eq!(dist[&1], 100);
        assert_eq!(dist[&2], 300);
    }

    fn decode_pairs(bytes: &[u8]) -> Vec<(u32, u32)> {
        bytes
            .chunks_exact(8)
            .map(|c| {
                let n = u32::from_le_bytes(c[..4].try_into().unwrap());
                let d = u32::from_le_bytes(c[4..].try_into().unwrap());
                (n, d)
            })
            .collect()
    }
}
```

If `WalkGraph::for_test` doesn't exist yet, add it as a `#[cfg(test)]` helper in `nycm-router/src/graph/walk.rs`. Inspect that file first:

```bash
cat nycm-router/src/graph/walk.rs | head -60
```

Add (or extend) at the bottom of `nycm-router/src/graph/walk.rs`:

```rust
#[cfg(test)]
impl WalkGraph {
    /// Construct a WalkGraph from raw nodes + (u, v, weight) edges. Test only.
    pub fn for_test(nodes: Vec<(f32, f32)>, edges: Vec<(u32, u32, u32)>) -> Self {
        // Match the fields of the real WalkGraph struct. Adjust to match
        // its actual layout — check `pub struct WalkGraph { ... }` first.
        let n = nodes.len();
        let mut adj: Vec<Vec<(u32, u32)>> = vec![vec![]; n];
        for (u, v, w) in edges {
            adj[u as usize].push((v, w));
            adj[v as usize].push((u, w));
        }
        // Construct using whatever fields WalkGraph actually has; the layout
        // here must match.
        Self::from_parts_for_test(nodes, adj)
    }
}
```

The exact `from_parts_for_test` helper must match the real struct layout — read it from `graph/walk.rs` and adapt. If the existing struct cannot be constructed externally, mark its fields `pub(crate)` or expose a builder. Keep the change minimal.

- [ ] **Step 3: Verify the test fails**

Run: `cd nycm-router && cargo test --lib walk::tests`
Expected: FAIL with `cannot find function reachable_nodes_packed` or similar.

- [ ] **Step 4: Implement `reachable_nodes_packed`**

In `nycm-router/src/walk.rs` (above the `#[cfg(test)]` block), add:

```rust
use std::cmp::Reverse;
use std::collections::BinaryHeap;

use rustc_hash::FxHashMap;

use crate::graph::walk::WalkGraph;

/// Bounded Dijkstra from `start` over the walking graph. Returns a packed
/// `Vec<u8>` of `(node_id_le_u32, walk_m_le_u32)` pairs for every node whose
/// distance from `start` is ≤ `budget_m`.
///
/// Packed encoding avoids wasm-bindgen serializing a `Vec<(u32, u32)>` as a
/// JS array-of-Objects (~80 B per pair → MBs of GC pressure on dense areas).
pub fn reachable_nodes_packed(graph: &WalkGraph, start: u32, budget_m: u32) -> Vec<u8> {
    let mut dist: FxHashMap<u32, u32> = FxHashMap::default();
    let mut heap: BinaryHeap<(Reverse<u32>, u32)> = BinaryHeap::new();
    dist.insert(start, 0);
    heap.push((Reverse(0), start));

    while let Some((Reverse(d), u)) = heap.pop() {
        if d > budget_m { break; }
        if Some(&d) != dist.get(&u).map(|x| x) && d > *dist.get(&u).unwrap_or(&u32::MAX) {
            continue;
        }
        for &(v, w) in graph.adj(u) {
            let nd = d.saturating_add(w);
            if nd <= budget_m && nd < *dist.get(&v).unwrap_or(&u32::MAX) {
                dist.insert(v, nd);
                heap.push((Reverse(nd), v));
            }
        }
    }

    let mut out = Vec::with_capacity(dist.len() * 8);
    for (node, d) in dist {
        out.extend_from_slice(&node.to_le_bytes());
        out.extend_from_slice(&d.to_le_bytes());
    }
    out
}
```

**Implementer note:** the existing `WalkGraph` may expose its adjacency differently (e.g., as `fn neighbors(&self, u: u32) -> impl Iterator<Item = (u32, u32)>`). Inspect first and adapt the `for &(v, w) in graph.adj(u)` line accordingly. The algorithm body doesn't change.

- [ ] **Step 5: Verify tests pass**

Run: `cd nycm-router && cargo test --lib walk::tests`
Expected: `2 passed`.

- [ ] **Step 6: Commit**

```bash
git add nycm-router/src/walk.rs nycm-router/src/graph/walk.rs
git commit -m "feat(router): bounded Dijkstra reachable_nodes_packed (Rust core)"
```

### Task 4.3: Expose `reachable_nodes` via `wasm-bindgen`

**Files:**
- Modify: `nycm-router/src/lib.rs`

- [ ] **Step 1: Inspect existing `Router` impl**

Run: `cat nycm-router/src/lib.rs`
Note the existing `Router::new` and `Router::route` signatures and how they accept JsValue / return JsValue.

- [ ] **Step 2: Add the new method**

In `nycm-router/src/lib.rs`, inside `impl Router`, add:

```rust
    /// Walk-graph nodes reachable from `from` within `budget_m` meters.
    /// Returns packed `Vec<u8>` of (node_id_le_u32, walk_m_le_u32) pairs.
    ///
    /// JS decoder:
    ///   for (let i = 0; i < bytes.length; i += 8) {
    ///     const node = view.getUint32(i, true);
    ///     const dist = view.getUint32(i + 4, true);
    ///   }
    #[wasm_bindgen]
    pub fn reachable_nodes(&self, from: JsValue, budget_m: u32) -> Result<Vec<u8>, JsError> {
        #[derive(serde::Deserialize)]
        struct LonLat { lon: f64, lat: f64 }
        let ll: LonLat = serde_wasm_bindgen::from_value(from)
            .map_err(|e| JsError::new(&format!("invalid LonLat: {e}")))?;
        let start = self.walk.snap(ll.lon, ll.lat)
            .ok_or_else(|| JsError::new("origin outside service area"))?;
        Ok(crate::walk::reachable_nodes_packed(&self.walk, start, budget_m))
    }
```

If `snap` returns a different type (e.g., `Option<NodeId>` where `NodeId` wraps u32), unwrap accordingly to get a `u32` for `reachable_nodes_packed`.

- [ ] **Step 3: Build WASM**

```bash
cd nycm-router && wasm-pack build --target web --release
```

Expected: builds cleanly, emits `pkg/nycm_router.js` and `pkg/nycm_router_bg.wasm`. Inspect that the generated `.d.ts` includes `reachable_nodes(from: any, budget_m: number): Uint8Array`.

- [ ] **Step 4: Commit**

```bash
git add nycm-router/src/lib.rs pkg/
git commit -m "feat(router): expose reachable_nodes(from, budget_m) via wasm-bindgen"
```

### Task 4.4: WASM smoke test for `reachable_nodes`

**Files:**
- Create: `tests/wasm/discover.mjs`

- [ ] **Step 1: Write the smoke test**

Create `tests/wasm/discover.mjs`:

```js
// Smoke test: real walk_graph.bin + Router.reachable_nodes against known points.
// Run: node tests/wasm/discover.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../..");

const wasmMod = await import(path.join(REPO, "pkg/nycm_router.js"));
const wasmBytes = await fs.readFile(path.join(REPO, "pkg/nycm_router_bg.wasm"));
await wasmMod.default(wasmBytes);

const walkBytes = await fs.readFile(path.join(REPO, "tiles/walk_graph.bin"));
const router = new wasmMod.Router(walkBytes);

// Times Sq (street-adjacent, Broadway side)
const TIMES_SQ = { lon: -73.9871, lat: 40.7589 };

function decode(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  for (let i = 0; i < bytes.length; i += 8) {
    out.push({ node: dv.getUint32(i, true), walk_m: dv.getUint32(i + 4, true) });
  }
  return out;
}

let failed = 0;
function check(name, ok, extra = "") {
  if (ok) console.log(`OK:   ${name}`);
  else { console.error(`FAIL: ${name} ${extra}`); failed++; }
}

const bytes = router.reachable_nodes(TIMES_SQ, 1200);
const pairs = decode(bytes);

check("Times Sq @ 1200m returns >1000 nodes", pairs.length > 1000, `got ${pairs.length}`);
check("max walk_m ≤ 1200", pairs.every((p) => p.walk_m <= 1200));
check("contains a start node with walk_m=0", pairs.some((p) => p.walk_m === 0));
check("no negative or NaN distances", pairs.every((p) => Number.isFinite(p.walk_m) && p.walk_m >= 0));

// Smaller budget should return strictly fewer nodes.
const tiny = decode(router.reachable_nodes(TIMES_SQ, 200));
check("200m budget returns fewer nodes than 1200m", tiny.length < pairs.length, `200m=${tiny.length} 1200m=${pairs.length}`);

process.exit(failed > 0 ? 1 : 0);
```

- [ ] **Step 2: Run the smoke test**

```bash
node tests/wasm/discover.mjs
```

Expected: all `OK:` lines, exit 0.

- [ ] **Step 3: Wire into CI**

Edit `.github/workflows/pages.yml`. After the existing `node tests/wasm/smoke.mjs` step, add:

```yaml
      - name: WASM discover smoke
        run: node tests/wasm/discover.mjs
```

- [ ] **Step 4: Commit + open PR 4**

```bash
git add tests/wasm/discover.mjs .github/workflows/pages.yml
git commit -m "test: WASM smoke for reachable_nodes (real graph, Times Sq)"
git push -u origin feat/richer-geocoding-pr4
gh pr create --title "feat(router): bounded Dijkstra reachable_nodes() in WASM" --body "$(cat <<'EOF'
## Summary
- Adds `reachable_nodes_packed` in Rust + `Router::reachable_nodes(from, budget_m)` via wasm-bindgen
- Returns `Vec<u8>` of packed (node_id_le_u32, walk_m_le_u32) pairs to avoid GC pressure
- Uses `FxHashMap` for fast u32 hashing
- Smoke test pins Times Sq at 1200 m budget: >1000 nodes, all ≤ budget, monotone with budget

## Test plan
- [ ] `cargo test --lib walk::tests` passes
- [ ] `node tests/wasm/discover.mjs` passes locally
- [ ] CI runs both, no regression in `tests/wasm/smoke.mjs`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## PR 5 — Discovery lane + map pins

**PR title:** `feat(search): category-keyword discovery lane with map pins`

**Goal:** Typing `coffee` with a destination pinned drops nearby cafe pins on the map and surfaces them in the dropdown sorted by walking time.

### Task 5.1: Fill in `CATEGORY_KEYWORDS` (TDD)

**Files:**
- Modify: `js/tokenize.js`
- Modify: `tests/unit/tokenize/normalize.test.mjs`

- [ ] **Step 1: Add failing tests**

Append to `tests/unit/tokenize/normalize.test.mjs`:

```js
test("CATEGORY_KEYWORDS maps coffee → food", () => {
  assert.deepEqual(CATEGORY_KEYWORDS.get("coffee"), { cat: "food", hint: "cafe" });
});

test("CATEGORY_KEYWORDS maps park → park", () => {
  assert.deepEqual(CATEGORY_KEYWORDS.get("park"), { cat: "park" });
});
```

- [ ] **Step 2: Verify tests fail**

Run: `node --test tests/unit/tokenize/normalize.test.mjs`
Expected: FAIL (the map is currently empty).

- [ ] **Step 3: Populate the map**

In `js/tokenize.js`, replace the empty `CATEGORY_KEYWORDS` declaration with:

```js
/** @type {Map<string, { cat: string, hint?: string }>} */
export const CATEGORY_KEYWORDS = new Map([
  ["food", { cat: "food" }],
  ["restaurant", { cat: "food" }],
  ["restaurants", { cat: "food" }],
  ["coffee", { cat: "food", hint: "cafe" }],
  ["cafe", { cat: "food", hint: "cafe" }],
  ["bar", { cat: "food", hint: "bar" }],
  ["pizza", { cat: "food", hint: "pizza" }],
  ["park", { cat: "park" }],
  ["parks", { cat: "park" }],
  ["playground", { cat: "park" }],
  ["museum", { cat: "culture" }],
  ["theater", { cat: "culture" }],
  ["theatre", { cat: "culture" }],
  ["library", { cat: "culture" }],
  ["pharmacy", { cat: "health" }],
  ["hospital", { cat: "health" }],
  ["school", { cat: "school" }],
  ["church", { cat: "worship" }],
]);
```

- [ ] **Step 4: Verify tests pass**

Run: `node --test tests/unit/tokenize/normalize.test.mjs`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add js/tokenize.js tests/unit/tokenize/normalize.test.mjs
git commit -m "feat(search): populate CATEGORY_KEYWORDS for discovery lane"
```

### Task 5.2: Implement `js/discover.js` (TDD)

**Files:**
- Create: `js/discover.js`
- Create: `tests/unit/discover/lane.test.mjs`

- [ ] **Step 1: Write failing test**

Create `tests/unit/discover/lane.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { discoveryLane, decodeReachable } from "../../../js/discover.js";

// Numeric category codes (mirror pipelines/pois.py order)
const FOOD = 1;
const PARK = 3;

function packReachable(pairs) {
  const out = new Uint8Array(pairs.length * 8);
  const dv = new DataView(out.buffer);
  pairs.forEach(([node, dist], i) => {
    dv.setUint32(i * 8, node, true);
    dv.setUint32(i * 8 + 4, dist, true);
  });
  return out;
}

test("decodeReachable round-trips packed pairs", () => {
  const pkt = packReachable([[10, 0], [20, 500], [30, 1200]]);
  const map = decodeReachable(pkt);
  assert.equal(map.get(10), 0);
  assert.equal(map.get(20), 500);
  assert.equal(map.get(30), 1200);
});

test("discoveryLane returns POIs matching category + in reachable set", async () => {
  const fakeRouter = {
    reachable_nodes: () => packReachable([[100, 0], [101, 600], [102, 1100]]),
  };
  const fakePoiIndex = {
    byCategoryArr: new Map([[FOOD, new Uint32Array([1, 2, 3])]]),
    byId: (id) => ({
      1: { lon: -74, lat: 40.7, walkNode: 100, category: FOOD, name: "Joe Pizza", flags: 0 },
      2: { lon: -74, lat: 40.7, walkNode: 101, category: FOOD, name: "Café Reggio", flags: 0 },
      3: { lon: -74, lat: 40.7, walkNode: 999, category: FOOD, name: "Out of reach", flags: 0 },
    }[id]),
  };
  const out = await discoveryLane("pizza", { lon: -73.99, lat: 40.74 }, {
    router: fakeRouter, poiIndex: fakePoiIndex, budgetM: 1200,
  });
  const names = out.map((r) => r.label);
  assert.ok(names.includes("Joe Pizza"));
  assert.ok(names.includes("Café Reggio"));
  assert.ok(!names.includes("Out of reach"));  // walkNode 999 not in reachable set
});

test("discoveryLane returns [] when query has no category keyword", async () => {
  const out = await discoveryLane("xyz random", { lon: 0, lat: 0 }, {
    router: { reachable_nodes: () => new Uint8Array() },
    poiIndex: { byCategoryArr: new Map(), byId: () => null },
    budgetM: 1200,
  });
  assert.deepEqual(out, []);
});

test("discoveryLane returns [] when no pinnedDest", async () => {
  const out = await discoveryLane("coffee", null, {
    router: { reachable_nodes: () => new Uint8Array() },
    poiIndex: { byCategoryArr: new Map(), byId: () => null },
    budgetM: 1200,
  });
  assert.deepEqual(out, []);
});
```

- [ ] **Step 2: Verify tests fail**

Run: `node --test tests/unit/discover/lane.test.mjs`
Expected: FAIL with `Cannot find module .../js/discover.js`.

- [ ] **Step 3: Implement `js/discover.js`**

Create `js/discover.js`:

```js
// Discovery lane: search-driven category-aware POI lookup using the
// walk-graph reachable-node set as a spatial filter.

import { normalize, CATEGORY_KEYWORDS } from "./tokenize.js";

// Mirror of pipelines/pois.py CATEGORIES map (string → numeric code).
const CAT_CODE = {
  food: 1, transit: 2, park: 3, culture: 4, attraction: 5,
  shop: 6, school: 7, health: 8, service: 9, worship: 10,
};

/**
 * Decode the packed Vec<u8> from Router.reachable_nodes into Map<node_id, walk_m>.
 * @param {Uint8Array} bytes
 */
export function decodeReachable(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map();
  for (let i = 0; i + 8 <= bytes.length; i += 8) {
    out.set(dv.getUint32(i, true), dv.getUint32(i + 4, true));
  }
  return out;
}

/**
 * @param {string} query
 * @param {{lon:number,lat:number}|null} pinnedDest
 * @param {{
 *   router: { reachable_nodes(from:{lon:number,lat:number}, budgetM:number): Uint8Array },
 *   poiIndex: { byCategoryArr: Map<number, Uint32Array>, byId(i:number): any },
 *   budgetM?: number,
 * }} deps
 */
export async function discoveryLane(query, pinnedDest, deps) {
  if (!pinnedDest) return [];
  const tokens = normalize(query);
  const cats = [];
  for (const t of tokens) {
    const hit = CATEGORY_KEYWORDS.get(t);
    if (hit) cats.push(hit);
  }
  if (cats.length === 0) return [];

  const budgetM = deps.budgetM ?? 1200;
  const reachable = decodeReachable(
    deps.router.reachable_nodes(pinnedDest, budgetM)
  );

  const out = [];
  for (const { cat, hint } of cats) {
    const code = CAT_CODE[cat];
    if (!code) continue;
    const ids = deps.poiIndex.byCategoryArr.get(code) || new Uint32Array();
    for (const id of ids) {
      const poi = deps.poiIndex.byId(id);
      if (!poi) continue;
      const walkM = reachable.get(poi.walkNode);
      if (walkM === undefined) continue;
      const hintBoost = hint && poi.name.toLowerCase().includes(hint) ? 10 : 0;
      const distPenalty = Math.min(10, walkM / 200);
      const score = 75 + hintBoost - distPenalty;
      out.push({
        lon: poi.lon, lat: poi.lat,
        label: poi.name || "(unnamed)",
        score, source: "discovery",
        poiId: id, category: poi.category, walkNode: poi.walkNode,
        walkM,
      });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 30);
}
```

- [ ] **Step 4: Verify tests pass**

Run: `node --test tests/unit/discover/lane.test.mjs`
Expected: `# pass 4`.

- [ ] **Step 5: Commit**

```bash
git add js/discover.js tests/unit/discover/lane.test.mjs
git commit -m "feat(search): discovery lane (category keyword + reachable-node filter)"
```

### Task 5.3: Wire discovery lane into `search-merge.js`

**Files:**
- Modify: `js/search-merge.js`
- Modify: `tests/unit/search-merge/rank.test.mjs`

- [ ] **Step 1: Write failing test**

Append to `tests/unit/search-merge/rank.test.mjs`:

```js
test("searchMerge folds discovery hits when destination is pinned", async () => {
  const localStub = async () => [];
  const photonStub = async () => [];
  const censusStub = async () => [];
  const discoverStub = async () => [
    { lon: -74, lat: 40.7, label: "Joe Pizza", score: 80, source: "discovery", poiId: 1, walkM: 300, category: 1, walkNode: 100 },
  ];
  const out = await searchMerge(
    "pizza", new AbortController().signal,
    { lon: -73.99, lat: 40.74 },
    { lon: -73.95, lat: 40.73 }, 8,
    {
      localSearch: localStub, photon: photonStub, census: censusStub,
      discoveryLane: discoverStub,
    },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].source, "discovery");
});
```

- [ ] **Step 2: Update `searchMerge` to accept and run a discovery stub**

In `js/search-merge.js`, replace the `searchMerge` function:

```js
import { discoveryLane as defaultDiscoveryLane } from "./discover.js";
import * as poiIndex from "./poi-index.js";

export async function searchMerge(query, signal, pinnedDest, biasLL, k = 8, overrides = {}) {
  const localSearch = overrides.localSearch || defaultLocalSearch;
  const photonFn = overrides.photon || photon;
  const censusFn = overrides.census || census;
  const discoveryFn = overrides.discoveryLane || ((q, p) =>
    defaultDiscoveryLane(q, p, {
      router: overrides.router ?? globalThis.__nycmRouter,
      poiIndex,
    }));

  const localP    = localSearch(query, k).catch(() => []);
  const photonP   = photonFn(query, signal).catch(() => []);
  const censusP   = isAddressLike(query) ? censusFn(query, signal).catch(() => []) : Promise.resolve([]);
  const discoverP = pinnedDest ? discoveryFn(query, pinnedDest).catch(() => []) : Promise.resolve([]);

  const [localHits, photonHits, censusHits, discoverHits] =
    await Promise.all([localP, photonP, censusP, discoverP]);

  const all = [
    ...localHits.map((r) => ({ ...r, baseScore: r.score })),
    ...discoverHits.map((r) => ({ ...r, baseScore: r.score })),
    ...censusHits.map((r) => ({ ...r, baseScore: 78 })),
    ...photonHits.map((r, i) => ({ ...r, baseScore: Math.max(30, 62 - i * 4), source: "photon" })),
  ];
  return mergeRank(all, biasLL).slice(0, k);
}
```

**Implementer note:** Wiring `defaultDiscoveryLane` requires access to the WASM router. Two options: (a) expose `router` via a module-level setter called from `js/search.js` after `ensureReady()`, or (b) import `js/router.js` and resolve through it. Pick the path that fits existing patterns — inspect `js/router.js` to see how the singleton is exposed.

- [ ] **Step 3: Verify tests pass**

Run: `node --test tests/unit/search-merge/rank.test.mjs`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add js/search-merge.js tests/unit/search-merge/rank.test.mjs
git commit -m "feat(search): wire discovery lane into search-merge"
```

### Task 5.4: Render discovery pins on the map

**Files:**
- Modify: `index.html`
- Modify: `js/search.js`

- [ ] **Step 1: Add the GeoJSON source + circle layer to the map style**

In `index.html`, locate the MapLibre style/sources initialization (search for `addSource` or `style:`). Add a new source + layer **after the destination-marker init**:

```js
map.addSource("discovery-pois", {
  type: "geojson",
  data: { type: "FeatureCollection", features: [] },
});
map.addLayer({
  id: "discovery-pois-circle",
  type: "circle",
  source: "discovery-pois",
  paint: {
    "circle-radius": 5,
    "circle-stroke-width": 1.5,
    "circle-stroke-color": "rgba(255, 251, 240, 0.94)",  // matches --chip-bg
    "circle-color": [
      "match",
      ["get", "category"],
      1, "#e76f51",   // food
      2, "#264653",   // transit
      3, "#2a9d8f",   // park
      4, "#9d4edd",   // culture
      5, "#f4a261",   // attraction
      6, "#e9c46a",   // shop
      7, "#577590",   // school
      8, "#f25c54",   // health
      9, "#6a994e",   // service
      10, "#7d5ba6",  // worship
      "#888888",
    ],
  },
});
```

- [ ] **Step 2: Update pins on every search result**

Edit `js/search.js`. After the `render(results)` call in the `attachTypeahead` debounce body, add an exported callback the caller wires to map pin updates. Or simpler — in `index.html` where `createLocationSearch` is wired, accept a new `onSearchResults` callback that receives the merged results and updates the map source:

In `index.html` where `createLocationSearch({...})` is constructed, add:

```js
onSearchResults: (results) => {
  const features = results
    .filter((r) => r.source === "discovery")
    .map((r) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [r.lon, r.lat] },
      properties: { category: r.category, label: r.label, walkM: r.walkM },
    }));
  map.getSource("discovery-pois").setData({ type: "FeatureCollection", features });
},
```

In `js/search.js`'s `createLocationSearch({ onLocate, onRoute, onClear })` signature, add `onSearchResults`:

```js
export function createLocationSearch({ onLocate, onRoute, onClear, onSearchResults }) {
```

In `attachTypeahead`, after `render(results)`, call:

```js
          render(results);
          if (typeof onSearchResults === "function") {
            try { onSearchResults(results); } catch {}
          }
```

Also wire pin-clearing on input clear / blur: in `resetAll()` and the empty-input branch, call `onSearchResults?.([])`.

- [ ] **Step 3: Smoke-test in the browser**

```bash
python3 scripts/serve.py
```

Open: `http://127.0.0.1:8000/`
1. Search "Times Square" → destination pin drops.
2. Type "coffee" in the same input.
3. Expected: dropdown shows cafes; matching pins appear on the map.
4. Clear the input → pins disappear.

- [ ] **Step 4: Commit**

```bash
git add index.html js/search.js
git commit -m "feat(search): render discovery results as theme-aware map pins"
```

### Task 5.5: Golden-query regression suite

**Files:**
- Create: `tests/unit/golden/queries.test.mjs`

- [ ] **Step 1: Write the golden table**

Create `tests/unit/golden/queries.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchMerge } from "../../../js/search-merge.js";

// These tests exercise the orchestrator with mocked lanes — they assert
// ranking ORDER and SOURCE PRIORITY, not real-data correctness. Real-data
// validation happens in the WASM smoke test + manual QA on PRs.

test("golden: address-like query → Census top result", async () => {
  const local = async () => [];
  const photon = async () => [{ lon: -73.5, lat: 40.5, label: "Wyandanch", source: "photon" }];
  const census = async () => [{ lon: -74.0, lat: 40.745, label: "140 W 25th St, NEW YORK, NY", source: "census" }];
  const out = await searchMerge("140 W 25th St", new AbortController().signal,
    null, { lon: -73.95, lat: 40.73 }, 5,
    { localSearch: local, photon, census, discoveryLane: async () => [] });
  assert.equal(out[0].source, "census");
});

test("golden: category query with pin → discovery results above photon", async () => {
  const local = async () => [];
  const photon = async () => [{ lon: -73.99, lat: 40.74, label: "Generic Coffee Inc", source: "photon" }];
  const census = async () => [];
  const discover = async () => [
    { lon: -74.0, lat: 40.74, label: "La Colombe", score: 78, source: "discovery", poiId: 1, walkM: 200, category: 1, walkNode: 1 },
  ];
  const out = await searchMerge("coffee", new AbortController().signal,
    { lon: -73.99, lat: 40.74 }, { lon: -73.95, lat: 40.73 }, 5,
    { localSearch: local, photon, census, discoveryLane: discover });
  assert.equal(out[0].source, "discovery");
});

test("golden: named POI without pin → local lane top, Photon below", async () => {
  const local = async () => [{ lon: -74, lat: 40.7, label: "Joe's Pizza", score: 95, source: "local", poiId: 1, category: 1, walkNode: 1 }];
  const photon = async () => [{ lon: -73.9, lat: 40.8, label: "Joe's Pizza Truck", source: "photon" }];
  const census = async () => [];
  const out = await searchMerge("Joe's Pizza", new AbortController().signal,
    null, { lon: -73.95, lat: 40.73 }, 5,
    { localSearch: local, photon, census, discoveryLane: async () => [] });
  assert.equal(out[0].source, "local");
  assert.equal(out[0].label, "Joe's Pizza");
});
```

- [ ] **Step 2: Verify tests pass**

Run: `node --test tests/unit/golden/queries.test.mjs`
Expected: `# pass 3`.

- [ ] **Step 3: Commit + open PR 5**

```bash
git add tests/unit/golden/queries.test.mjs
git commit -m "test: golden-query regression table for lane ranking"
git push -u origin feat/richer-geocoding-pr5
gh pr create --title "feat(search): category-keyword discovery + map pins" --body "$(cat <<'EOF'
## Summary
- `js/discover.js`: discoveryLane(query, pinnedDest, deps) → POIs of matched category within walking-budget reachable set
- `js/tokenize.js`: CATEGORY_KEYWORDS now populated
- `js/search-merge.js`: discovery is the 4th lane; fires only when query has a category keyword AND a destination is pinned
- `index.html`: discovery-pois GeoJSON source + circle layer, theme-aware
- Pins appear with results, vanish when the input clears
- Golden-query regression table

## Test plan
- [ ] `node --test tests/unit/**/*.test.mjs` passes
- [ ] `node tests/wasm/smoke.mjs` and `node tests/wasm/discover.mjs` still pass
- [ ] Manually: pin Times Sq, type "coffee" → ≥5 cafes appear as pins + dropdown rows
- [ ] Manually: type "pizza" without a pin → behaves as normal text search (no pins)
- [ ] Manually: clear input → pins disappear

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

**Spec coverage check.** All five spec PRs have at least one task each. POI binary format from spec § "POI binary format" → Task 2.2. Pre-snap → Task 2.3. Tokenizer → Task 1.2. Photon tuning → Task 1.3. Census lane → Task 1.4. Search merge + dedup → Task 1.5, 3.3, 5.3. Local POI lane → Task 3.1, 3.2. WASM `reachable_nodes` → Task 4.2, 4.3, 4.4. Discovery lane → Task 5.2. Pins on map → Task 5.4. Golden tests → Task 5.5.

**Spec gap noted.** The spec lists `crates/router/` as the Rust path; the actual path is `nycm-router/`. This plan uses the correct path throughout.

**Type/signature consistency.** `WalkGraphReader(bytes)` callable, `decodePoiBlob(bytes) → { byId, ... }`, `discoveryLane(query, pinnedDest, deps)`, `searchMerge(query, signal, pinnedDest, biasLL, k, overrides)` — names used in later tasks match the earlier definitions.

**Placeholder scan.** No "TBD"/"TODO". A few "implementer note" callouts where the existing code shape determines an exact line of code (e.g., `WalkGraph.adj()` vs `.neighbors()`); these are concrete instructions to inspect-then-adapt, not vague hand-waves.

**One known soft spot.** Task 4.2's `WalkGraph::for_test` helper depends on the real struct's field visibility. The implementer may need a small constructor patch in `graph/walk.rs`; flagged inline.
