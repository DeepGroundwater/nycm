# Richer Geocoding & Search-Driven Discovery — Design Spec

**Date:** 2026-05-18
**Status:** Draft, awaiting user review
**Branch (suggested):** `feat/richer-geocoding`
**Builds on:** `docs/superpowers/specs/2026-05-17-routing-search-design.md`

## Problem

The current search bar (`js/search.js` → `js/geocode.js` → Photon) returns weak
results for two query classes:

1. **Street addresses.** Photon with a bias point alone is not enough; queries
   like `"140 W 25th St"` rank Wyandanch, NY and Ontario, Canada above the
   correct Manhattan match.
2. **Restaurants / POIs by name.** Coverage is OSM-only and ranking is
   noisy for non-bias queries.

Beyond search quality, we also lack a way for a user to ask *"what's near
here"* — a question the walking graph is uniquely positioned to answer in
walking minutes (not crow-flight meters) because it already knows the
basemap's pedestrian topology.

## Goals

- Make the search bar return correct results for US street addresses and for
  POIs by name across the basemap (NYC + LI + south Westchester/Conn + NJ).
- Allow a user to type a category keyword (`coffee`, `park`, `museum`) while a
  destination is pinned and receive POIs of that category reachable on foot
  from the pin.
- Keep the site keyless (no API keys, no signup).
- Preserve existing routing behavior end-to-end.

## Non-goals (v1)

- Geolocation / "Near me" using the browser's position API.
- Turn-by-turn navigation, route alternatives, transit routing. (Separate
  specs.)
- Semantic queries beyond literal category keywords (`"movie"` won't match
  `cinema`).
- Address-autocomplete UX from Census (Census has no typeahead endpoint).

## Constraints

- Static site, GitHub Pages, `main` is PR-protected.
- GitHub per-file push cap is 100 MB; binary artifacts ship as 50 MB chunks
  reassembled at runtime (existing pattern: `walk-graph.part-*`).
- No API keys.
- The OSM PBFs (NY + CT + NJ Geofabrik extracts) are already downloaded and
  cached during the walking-graph build; reuse them.

---

## Architecture

Four search lanes merge client-side. Each lane is independent; any subset can
fail without breaking the others.

```
                       user types in #loc-input
                                  │
       ┌──────────────┬───────────┴────────┬──────────────┐
       │              │                    │              │
 ┌─────▼─────┐  ┌─────▼─────┐  ┌──────────▼─────┐  ┌─────▼──────┐
 │ LOCAL POI │  │  CENSUS   │  │  PHOTON (OSM)  │  │ DISCOVERY  │
 │  (sync)   │  │ (network) │  │  (network)     │  │  (WASM)    │
 │  trie     │  │ US addr   │  │  +bbox+cc=us   │  │  isochrone │
 │  +postings│  │  keyless  │  │                │  │  + category│
 └─────┬─────┘  └─────┬─────┘  └────────┬───────┘  └─────┬──────┘
       └──────────────┴───────┬─────────┴──────────────  ┘
                              │
                       merge + rank + dedup
                       (50 m geographic grid)
                              │
                       ┌──────▼───────┐
                       │   dropdown   │
                       │   + map pins │  ← pins drawn ONLY when discovery
                       │              │     lane fires; cleared on next query
                       └──────────────┘
```

**Lane invariants:**

- Local POI lane is synchronous and renders first (partial result emit).
- Network lanes are abortable; every keystroke aborts the previous in-flight
  calls via `AbortController`.
- Discovery lane fires only when *(a)* a destination is pinned **and** *(b)*
  the query contains a known category keyword.
- Geographic dedup snaps lon/lat to a 50 m grid; the highest-scored entry per
  bucket wins; ties broken by source priority `local > discovery > census >
  photon`.

---

## File ownership

| Path | Phase | Purpose |
|---|---|---|
| `pipelines/walk_graph_reader.py` | 1 | Extracted from `walk_graph.py`; shared decoder for walk-graph binary |
| `pipelines/pois.py` | 1 | Pyosmium pass over merged PBF; emits POI binary with pre-snapped `walk_node_id` |
| `scripts/build-pois.sh` | 1 | Bash wrapper; reuses cached PBF; splits to `tiles/pois.part-*` |
| `tiles/pois.part-*` | 1 | Committed POI chunks; `tiles/pois.bin` is gitignored |
| `js/tokenize.js` | 1 | Shared `normalize()` + `CATEGORY_KEYWORDS` table |
| `js/poi-index.js` | 1 | Loads chunks, builds in-memory token + category indexes, exposes `search()`, `byId()`, `byCategory()` |
| `js/census.js` | 1 | `geocodeAddress(query, signal)` against US Census |
| `js/geocode.js` | 1 | Existing Photon client — adds `bbox` + `countrycodes=us` |
| `js/search-merge.js` | 1, 2 | Orchestrates four lanes, ranks, dedupes |
| `js/search.js` | 1, 2 | Existing UI controller — switches to merged search; manages pin source updates |
| `crates/router/src/lib.rs` | 2 | Adds `reachable_nodes(from, budget_m) → Vec<u8>` WASM method |
| `js/discover.js` | 2 | Pure data lane: invokes WASM, joins to POIs, ranks |
| `index.html` | 1, 2 | Adds `#discovery-pins` GeoJSON source + circle layer; theme-aware CSS |
| `tests/tokenize/normalize.test.mjs` | 1 | Pins tokenizer behavior |
| `tests/poi-index/decode.test.mjs` | 1 | Binary decode + `byId`/`byCategory`/`search` |
| `tests/search-merge/rank.test.mjs` | 1 | Merge ordering + dedup |
| `tests/discover/lane.test.mjs` | 2 | Reachable-node filter + category match |
| `tests/wasm/discover.mjs` | 2 | WASM smoke: `reachable_nodes` invariants |
| `tests/build/pois-sanity.sh` | 1 | Fixture PBF → POI binary; header + counts |
| `tests/golden/queries.test.mjs` | 1, 2 | End-to-end ranking regression table |

---

## POI binary format

One file, two contiguous sections, little-endian.

```
┌─────────────────────────────────────────────────────────┐
│ HEADER (24 bytes)                                       │
│   magic              : 4 bytes = "POI1"                 │
│   version            : u32 = 1                          │
│   walk_graph_version : u32  (must match walk_graph.bin) │
│   n_pois             : u32                              │
│   names_off          : u32  (offset to NAMES section)   │
│   reserved           : u32                              │
├─────────────────────────────────────────────────────────┤
│ RECORDS (n_pois × 20 bytes, fixed stride)               │
│   lon_e7      : i32   (lon × 1e7, ~1.1 cm precision)    │
│   lat_e7      : i32                                     │
│   walk_node   : u32   (index into walk_graph.bin)       │
│   name_off    : u32   (byte offset into NAMES)          │
│   name_len    : u16   (bytes, ≤ 200)                    │
│   category    : u8    (1..10, see table)                │
│   flags       : u8    (bit 0 = unnamed)                 │
├─────────────────────────────────────────────────────────┤
│ NAMES (variable, UTF-8, no terminator)                  │
│   concatenated; records index by (name_off, name_len)   │
└─────────────────────────────────────────────────────────┘
```

**Rationale:**
- Fixed-stride records → O(1) lookup by `poi_id = record index`.
- Separate NAMES blob → contiguous scan when building the in-memory token
  index; no pointer chase.
- `i32 × 1e7` for lon/lat → 4 bytes vs 8, precision well beyond need.
- `walk_graph_version` in the header → refuse to load if mismatched.

### Categories

| Code | Name | OSM tags |
|---|---|---|
| 1 | `food` | `amenity ∈ {restaurant, cafe, bar, fast_food, pub, food_court, ice_cream, biergarten}` |
| 2 | `transit` | `railway ∈ {station, halt, tram_stop}`, `public_transport=station`, `amenity=ferry_terminal`, `aeroway=aerodrome` |
| 3 | `park` | `leisure ∈ {park, playground, garden, nature_reserve}` |
| 4 | `culture` | `tourism ∈ {museum, gallery}`, `amenity ∈ {theatre, cinema, arts_centre, library}` |
| 5 | `attraction` | `tourism ∈ {attraction, viewpoint, zoo, aquarium}`, `historic=*` |
| 6 | `shop` | `shop ∈ {supermarket, convenience, bakery, books, clothes, department_store, mall, hardware}` |
| 7 | `school` | `amenity ∈ {school, university, college}` |
| 8 | `health` | `amenity ∈ {hospital, clinic, pharmacy, doctors}` |
| 9 | `service` | `amenity ∈ {post_office, bank, fuel, police, fire_station}` |
| 10 | `worship` | `amenity=place_of_worship` |

Unmapped → POI dropped. Multi-tagged POIs pick the highest-priority category
by table order.

---

## Build pipeline

```
pipelines/cache/merged.osm.pbf      (already exists from walk-graph build)
              │
              ▼
   ┌────────────────────────────┐
   │ pipelines/pois.py          │
   │                            │
   │ Pass 1: way nodes          │  ← collect node refs for any way carrying
   │   for ways with category   │    a category tag (park polygons, etc.)
   │   tags, record centroid    │
   │   node refs                │
   │                            │
   │ Pass 2: node coords        │  ← resolve every collected ref + every
   │                            │    standalone node POI
   │                            │
   │ Filter:                    │
   │   - drop unmapped tags     │
   │   - drop POIs with no      │
   │     name=* (except parks/  │
   │     playgrounds, flagged)  │
   │   - clip to basemap bbox   │
   │                            │
   │ Pre-snap:                  │  ← flat-grid snap to walk_graph
   │   for each POI:            │    — same algorithm as router runtime,
   │     node = walk.snap(ll)   │      executed offline. LCC = Largest
   │     if node not in LCC:    │      Connected Component.
   │       node = walk.snap_in_ │
   │              lcc(ll, 100m) │
   │     if still none: drop    │
   │                            │
   │ Emit pois.bin              │  ← records sorted by (category, name) for
   │                            │    cache-friendly category scans
   └─────────────┬──────────────┘
                 ▼
   ┌────────────────────────────┐
   │ scripts/build-pois.sh      │
   │   - uv run pipelines/pois  │
   │   - sanity-check size      │
   │   - split -b 50M           │
   │   - emit tiles/pois.part-* │
   └─────────────┬──────────────┘
                 ▼
   tiles/pois.part-aa, ab, ...    (committed)
   tiles/pois.bin                 (gitignored)
```

**Sanity gates (build fails if violated):**

- `n_pois ≥ 30_000`
- `n_pois ≤ 250_000`
- ≥ 95 % of POIs have a non-empty name (unnamed parks/playgrounds are the rest)
- `pois.bin` size between 5 MB and 30 MB
- Every POI's `walk_node_id < walk_graph.n_nodes`
- `header.walk_graph_version == walk_graph.bin header.version`

**Way centroid for polygon POIs:** bounding-box center if it falls inside the
polygon; otherwise the perimeter vertex nearest the bbox center.

---

## Runtime — search lanes

### Local POI lane (`js/poi-index.js`)

Loaded lazily on first keystroke.

```
ensureReady()
  ├─ fetch tiles/pois.bin (or assemble pois.part-* via the same logic as
  │  walk-graph in js/router.js)
  ├─ verify header.magic == "POI1" and header.version == 1
  ├─ verify header.walk_graph_version matches router.walkGraphVersion()
  │  (refuse to use stale data)
  ├─ build token index in one pass:
  │     for each POI i:
  │       tokens = normalize(name)        // shared from js/tokenize.js
  │       for tok in tokens:
  │         postings[tok].push(i)
  ├─ sort each posting list by category priority then alphabetically
  ├─ build sortedTokens[] for prefix queries via binary search
  └─ build categoryIndex[1..10] → Uint32Array of POI ids
```

In-memory cost: ~100k POIs × ~3 tokens × 4 bytes = ~1.2 MB postings + ~500 KB
token strings. Cold-start build time: ~50 ms.

**`search(q, k)`:**

```
1. tokens = normalize(q)
2. if tokens empty → []
3. last = tokens.pop()                    // treat as prefix
4. exact   = tokens.map(t => postings[t] || [])
5. prefix  = unionOfPostingLists(tokensInRange(last, last + "￿"))
6. cand    = intersect(exact + [prefix])  // small-set-first skip merge
7. score each candidate (table below)
8. return top-k
```

**Local ranking:**

```
score = name_match_score
      + category_boost[category]
      - length_penalty
      + bias_proximity(poi, biasLL)
```

| Component | Value |
|---|---|
| `name_match_score` | 100 if normalized name == query; 80 if all query tokens are name tokens; 60 if last is prefix of any name token |
| `category_boost` | transit +15, park +8, attraction +5, others 0 |
| `length_penalty` | `log2(name_token_count)` |
| `bias_proximity` | 0..+10 by inverse great-circle to map center |

### Census lane (`js/census.js`)

```
geocodeAddress(query, signal) →
  fetch("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
        + "?address=" + encodeURIComponent(query)
        + "&benchmark=Public_AR_Current&format=json",
        { signal })
  parse json.result.addressMatches
  filter matchedAddress to states ∈ {NY, NJ, CT}
  map each → { lon, lat, label, source: "census" }
```

Called only when `/^\d+\s+\S/.test(query)` (starts with digits + space). Census
has no typeahead endpoint; one-shot per debounced query.

### Photon lane (`js/geocode.js`)

```diff
+ url.searchParams.set("countrycodes", "us");
+ url.searchParams.set("bbox", "-74.5,40.3,-72.7,41.4");
```

That is the entire Phase 1 fix to Photon. `countrycodes=us` is a hard filter
(eliminates the Ontario / Vancouver failure); `bbox` is a soft ranking signal.

### Discovery lane (`js/discover.js`, Phase 2)

```
discoveryLane(query, pinnedDest)
  if no category keyword in query → []
  if pinnedDest == null            → []
  budgetM = 1200                              // fixed for v1
  bytes   = await router.reachable_nodes(pinnedDest, budgetM)
  reach   = decodeNodes(bytes)                // Map<u32, u32> node→walk_m
  cats    = categoryKeywordsIn(query)
  out     = []
  for each {cat, hint} in cats:
    for poi_id of poiIndex.byCategory(cat):
      poi = poiIndex.byId(poi_id)
      if reach.has(poi.walk_node):
        walk_m = reach.get(poi.walk_node)
        score  = 75
               + (hint && poi.name.includes(hint) ? 10 : 0)
               - clamp(walk_m / 200, 0, 10)
        out.push({ poi, walk_m, score, source: "discovery" })
  out.sort by score desc
  return out.slice(0, 30)
```

Pin rendering: the up-to-30 results' lon/lat become features on a MapLibre
`#discovery-pins` GeoJSON source; pins are circle markers colored by category.
Source is cleared the instant the input clears or the next query doesn't
trigger discovery. Markers (not DOM elements) keep redraws cheap.

### Category keyword table

Lives in `js/tokenize.js` next to `normalize()` (so build pipeline and runtime
stay in sync — if `pipelines/pois.py` ever needs the same table, it imports a
generated JSON twin).

```js
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

Initial set is intentionally narrow. Widen based on telemetry / user reports.

### Merge orchestrator (`js/search-merge.js`)

```
async function searchMerge(query, signal, pinnedDest, biasLL, k=8) {
  const local = await poiIndex.search(query, k);
  emit("partial", local);

  const isAddrLike = /^\d+\s+\S/.test(query);
  const [photonHits, censusHits, discoveryHits] = await Promise.all([
    photon(query, signal).catch(() => []),
    isAddrLike ? census(query, signal).catch(() => []) : Promise.resolve([]),
    discoveryLane(query, pinnedDest, signal).catch(() => []),
  ]);

  const all = [
    ...local.map(r => ({ ...r, baseScore: r.score })),
    ...discoveryHits.map(r => ({ ...r, baseScore: r.score })),
    ...censusHits.map(r => ({ ...r, baseScore: 78 })),
    ...photonHits.map((r, i) => ({
      ...r, baseScore: Math.max(30, 62 - i*4),
    })),
  ];

  const merged = dedupBy50mGrid(all);
  merged.sort((a, b) =>
    (b.baseScore - a.baseScore) ||
    (proximity(a, biasLL) - proximity(b, biasLL))
  );
  return merged.slice(0, k);
}
```

Score weights summary:

| Source | Base score | Notes |
|---|---|---|
| Local — exact name | 100 + boosts | hard to beat |
| Local — all query tokens are name tokens | 80 + boosts | |
| Local — prefix on last token | 60 + boosts | |
| Discovery hit | 75 + hint bonus − distance penalty (≈65–85) | |
| Census — match in NY/NJ/CT | 78 | only for address-like queries |
| Photon hit #N | max(30, 62 − 4N) | Photon order is noisy beyond #2 |

---

## Phase 2 — WASM method

New Rust method on `Router`:

```rust
#[wasm_bindgen]
impl Router {
    pub fn reachable_nodes(&self, from: LonLat, budget_m: u32) -> Vec<u8> {
        let start = self.snap(from);
        let mut dist: FxHashMap<u32, u32> = FxHashMap::default();
        let mut heap = BinaryHeap::new();
        dist.insert(start, 0);
        heap.push((Reverse(0u32), start));
        while let Some((Reverse(d), u)) = heap.pop() {
            if d > budget_m { break; }
            if d > dist[&u] { continue; }
            for &(v, w) in self.adj(u) {
                let nd = d + w;
                if nd <= budget_m
                    && nd < *dist.get(&v).unwrap_or(&u32::MAX) {
                    dist.insert(v, nd);
                    heap.push((Reverse(nd), v));
                }
            }
        }
        // Pack as little-endian u32 pairs (node_id, walk_m).
        let mut out = Vec::with_capacity(dist.len() * 8);
        for (node, d) in dist {
            out.extend_from_slice(&node.to_le_bytes());
            out.extend_from_slice(&d.to_le_bytes());
        }
        out
    }
}
```

Packed `Vec<u8>` over a `Vec<(u32, u32)>` to avoid wasm-bindgen Object
allocations (~80 bytes per pair → ~1.6 MB GC pressure on 20k nodes; packed
gives ~160 KB).

**Performance budget.**

- Walk graph after contraction: ~5 M nodes, ~15 M directed edges.
- 1200 m budget on dense Manhattan: ~15–25 k nodes touched, ~50 k heap ops.
- Expected wall clock: 5–15 ms in WASM on a 2020-era laptop.
- Cap budget at 2000 m in JS UI for v1 (beyond which the count balloons).

---

## State machine

Discovery is a *transient overlay* on the existing state machine, not a new
sub-state.

```
   DEST_PINNED
       │
       │ user types in #loc-input
       ▼
   ┌─────────────────────────────────┐
   │ overlay: dropdown rows          │
   │ overlay: discovery pins on map  │  ← appear/disappear with the query
   │ (destination pin remains)       │
   └─────────────────────────────────┘
       │
       │ user picks a row
       ▼
   DEST_PINNED  (new destination)
```

When the input gains focus and a destination is pinned, the input shows a
placeholder hint — `Try "coffee", "park", "pharmacy"…` — that disappears on
the first keystroke. No persistent chip rail.

---

## Error handling

Each lane fails independently; the dropdown shows whatever lanes succeeded.

| Lane | Failure mode | Behavior |
|---|---|---|
| Local POI | Chunks 404 / bad magic / version mismatch | Throw once; orchestrator catches, logs `console.warn`, skips local lane on subsequent searches. |
| Census | Non-2xx, network error, AbortError | `.catch(() => [])`. Silent. |
| Photon | Same | Same. Silent. |
| Discovery | WASM not ready (chunks loading) | Awaits `ensureReady()`; on rejection returns `[]` and logs. |
| Discovery | `reachable_nodes` empty (origin on OSM island) | Return `[]`. No error UI; content edge case. |
| Pre-snap mismatch at build | `walk_graph.bin` version differs from POI build cache | `build-pois.sh` exits non-zero. CI fails. Never ships. |
| Tokenizer drift | Build-time `normalize()` ≠ runtime `normalize()` | Unit test pins behavior; build CI fails. Never ships. |

The only user-visible error path: all four lanes return zero results → existing
`"No matches"` row.

---

## Tests

### Unit (Node, no WASM, no network)

- `tests/tokenize/normalize.test.mjs` — pins `normalize()` output for ~30
  fixtures; one shared module imported by build and runtime.
- `tests/poi-index/decode.test.mjs` — handcrafted 5-record binary →
  `byId`/`byCategory`/`search` invariants.
- `tests/search-merge/rank.test.mjs` — fake local + Census + Photon results
  → ordering and dedup.
- `tests/discover/lane.test.mjs` — fake reachable-node map + POI index →
  category filter + walk_m ordering.

### WASM smoke (Node + real `walk_graph.bin`)

- `tests/wasm/smoke.mjs` — existing, unchanged.
- `tests/wasm/discover.mjs` (new) — pins Times Sq, calls
  `reachable_nodes(from, 1200)`, asserts:
  - `nodes.length > 1000`
  - contains `start_node` with `walk_m == 0`
  - `max(walk_m) ≤ 1200`
  - `min nonzero walk_m > 0`

### Build pipeline (Bash)

- `tests/build/pois-sanity.sh` — runs `scripts/build-pois.sh` against a tiny
  fixture PBF under `tests/fixtures/`; asserts header magic, `n_pois > 5`,
  every `walk_node_id < n_nodes`.

### Golden queries (jsdom or thin harness)

`tests/golden/queries.test.mjs` table:

| Query | Pinned dest | Expectation |
|---|---|---|
| `"140 W 25th St"` | none | top 1 has lon ∈ [-74.0, -73.99] (Manhattan) |
| `"pizza"` | Times Sq | top 3 contain ≥ 2 of `{Joe's Pizza, Percy's Pizza, Bleecker Street Pizza}` |
| `"park"` | none | top 5 include `Central Park` OR `Prospect Park` |
| `"coffee"` | Penn Station | top 5 all have `category=food` |
| `"Battery Park"` | none | top 1 has lon ∈ [-74.02, -74.00] (Lower Manhattan) |

### CI wiring

Extend `.github/workflows/pages.yml`:

1. `cargo test`
2. `node --test tests/**/*.test.mjs`
3. `bash scripts/build-pois.sh` (caches the merged PBF; same cache as walk-graph)
4. `node tests/wasm/discover.mjs`

Any failure blocks deploy; `main` is already PR-protected.

---

## Rollout phasing — five PRs

Each PR is independently shippable and reversible.

| PR | Title | Files | Visible effect | Size |
|---|---|---|---|---|
| 1 | Photon tuning + Census lane | `js/geocode.js`, `js/census.js`, `js/search-merge.js` (skeleton), `js/search.js` (wire), tests | `"140 W 25th St"` works; suburban addresses work | ~250 LOC |
| 2 | POI build pipeline + binary | `pipelines/pois.py`, `pipelines/walk_graph_reader.py`, `scripts/build-pois.sh`, tests/fixtures | `tiles/pois.part-*` committed; no runtime wiring | ~400 LOC, mostly Python |
| 3 | Local POI lane in dropdown | `js/poi-index.js`, `js/tokenize.js` (empty `CATEGORY_KEYWORDS`), wire local lane, tests | Typeahead lights up for landmarks/POIs | ~300 LOC |
| 4 | Phase 2: `reachable_nodes` WASM method | `crates/router/src/lib.rs`, `tests/wasm/discover.mjs` | No user-visible feature; data plumbing reviewable in isolation | ~80 LOC Rust + smoke |
| 5 | Phase 2: discovery lane + pins | `js/discover.js`, wire 4th lane, `CATEGORY_KEYWORDS` table, pin source/layer, golden tests | Typing `"coffee"` near a pin shows nearby cafes with map pins | ~400 LOC |

PR 1 ships a same-day visible win. PR 2 lands data without touching UX
(easy review, reversible). PR 3 turns on the local lane. PR 4 isolates the
algorithm. PR 5 ties it together.

PR 4's method is annotated `#[allow(dead_code)]` until PR 5; the intent is
documented in the PR description and `tests/wasm/discover.mjs` keeps the
method exercised in CI.

---

## Open concerns

- **POI bundle size growth.** ~5 MB of binary chunks today; regenerations
  create new git blobs. Same precedent as walk-graph (191 MB) and pmtiles.
  Long-term mitigation: LFS or R2. Out of scope for v1; flagged in
  `memory/pending_work.md`.
- **Pre-snap depends on walk-graph version.** Stamping `walk_graph_version`
  in both binaries gives a hard guard at runtime (refuse to use POI binary
  whose version doesn't match) and at build time (`build-pois.sh` exits if
  it can't find a matching walk-graph).
- **Way-centroid for polygon POIs can be approximate** for highly concave
  shapes (Prospect Park's pond carve-outs, etc.). Acceptable; pre-snap
  to LCC walking-node makes the routing-time location correct even if the
  pin is slightly inside or outside the polygon visually.
- **No semantic queries.** `"movie"` does not match `cinema`; `"hike"` does
  not match `nature_reserve`. Documented limitation; v2 candidate.
- **No geolocation.** v1 has no `"Near me"` referencing the user's actual
  position. Discovery only fires near a *pinned* destination. The
  `discoveryLane(query, pinnedDest)` signature makes geolocation a one-line
  caller change later.
- **Photon `countrycodes=us` is a hard filter.** It excludes Canada and any
  basemap area outside US. The current basemap extends slightly into
  Canada (none) and definitely not Mexico, so this is safe. Document.
- **No backwards-compat break.** All five PRs add code; none rename or
  remove. The existing route smoke test keeps passing across the series.

---

## Why this is worth doing

The site already pre-bakes a basemap-sized walking graph and ships chunks via
GitHub Pages. Adding a POI index alongside is incremental — same PBF, same
build pattern, same chunking. The walking graph gives us a discovery primitive
(walking-minute isochrones) that consumer maps generally lack. Combined with a
keyless geocoder lane (Census) and a tuned Photon, the search bar moves from
"often wrong" to "correct and unique."
