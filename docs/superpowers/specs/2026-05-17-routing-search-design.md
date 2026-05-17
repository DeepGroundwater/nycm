# Routing & Search Design

**Date:** 2026-05-17
**Status:** Approved (brainstorming complete; awaiting plan)
**Scope:** Add a search-bar-driven walking + transit route planner to the
existing NYC metro map, powered by an in-browser WebAssembly engine. Geocoding
is the only network dependency at runtime.

---

## 1. Architecture & boundaries

```
                                ┌────────────────────────────────────────────────┐
                                │                 index.html (UI)                │
                                │                                                │
   user types  ──►  search bar ─┼──► geocode.js  ──►  Photon API (POIs)          │
                                │           │                                    │
                                │           ├──►  stopsIndex.js  (local)         │
                                │           │       data/search-stops.json       │
                                │           ▼                                    │
                                │   { from: {lon,lat}, to: {lon,lat}, t0 }       │
                                │           │                                    │
                                │           ▼                                    │
                                │   ┌─────────────────────────────────────────┐  │
                                │   │  router.js (thin glue around WASM)      │  │
                                │   │   - fetches graph blobs (chunked)       │  │
                                │   │   - calls wasm.route(req)               │  │
                                │   └─────────┬───────────────────────────────┘  │
                                │             │                                  │
                                │             ▼                                  │
                                │     ┌──────────────────────────┐               │
                                │     │  nycm-router (Rust→WASM) │               │
                                │     │                          │               │
                                │     │  walk.rs   transit.rs    │               │
                                │     │  (A*)      (RAPTOR)      │               │
                                │     │         stitch.rs        │               │
                                │     │                          │               │
                                │     │  loads: walk_graph.bin   │               │
                                │     │         timetable.bin    │               │
                                │     └──────────────────────────┘               │
                                │             │                                  │
                                │             ▼                                  │
                                │   Itinerary { legs: [Walk|Transit], totals }   │
                                │             │                                  │
                                │             ▼                                  │
                                │   render.js  ──►  MapLibre layers              │
                                │                   + leg-summary card           │
                                └────────────────────────────────────────────────┘

                                        ─── offline / CI ───

   scripts/build-walk-graph.sh    OSM extract (basemap bbox)  ─►  walk_graph.bin
                                  contraction, snap-index           (chunked .part-*)
   scripts/build-timetable.sh     GTFS static (NYCT, LIRR, MNR)  ─►  timetable.bin
```

### Units and contracts

| Unit | Purpose | Inputs | Outputs |
|---|---|---|---|
| `nycm-router` (Rust crate) | Multimodal A*+RAPTOR engine; no I/O, no DOM | `RouteRequest` + graph bytes | `Itinerary` |
| `walk_graph.bin` | Contracted OSM walking graph for basemap bbox | Built offline | Loaded by WASM |
| `timetable.bin` | RAPTOR-ready stops × trips × stop_times | Built offline from GTFS static | Loaded by WASM |
| `router.js` | WASM lifecycle + chunked blob fetch | UI request | `Promise<Itinerary>` |
| `geocode.js` | Resolve query text → coordinates via Photon | Query string | `{lon, lat, label}` |
| `stopsIndex.js` | Instant local search over MTA stations | Query string | Same shape as geocode |
| `render.js` | Draw legs on map + leg-summary card | Itinerary | DOM + map layers |
| `scripts/build-*.sh` | Offline pipelines, CI-runnable | OSM PBF / GTFS zips | The two `.bin` artifacts |

### Boundary discipline

The WASM crate knows nothing about MapLibre, `fetch`, the DOM, or where
coordinates came from — it takes bytes and request structs, returns an
itinerary. Every other module can be tested by stubbing the WASM call. The
OSM/GTFS pipelines are pure file-in / file-out and live alongside
`extract-tiles.sh` / `assemble-tiles.sh`.

### Concerns

- **Bundle size.** Walking graph for the full basemap bbox is the wildcard
  — likely 40–80 MB after contraction. We chunk into `.part-*` like the
  existing pmtiles flow.
  - *Why it could go wrong:* first-load TTI worsens; mobile data plans suffer.
  - *Mitigation:* lazy-load — only fetch graph after the user types into search;
    stream chunks.
- **WASM linear-memory ceiling.** Default `wasm32` is 32-bit; practical browser
  limit is ~2 GB. Loaded graph + timetable will be well under that, but watch
  for accidental clone-of-graph at decode time.
- **GitHub Pages can't enforce chunk ordering.** Keep `.part-*` strategy (already
  proven in this repo).

### Assumptions

- The basemap bbox already used for pmtiles is the canonical "service area"
  — same bbox feeds the walking-graph extract. *Why:* one source of truth;
  the user's mental model stays consistent.
- GTFS static feeds for NYCT/LIRR/MNR are stable enough that we rebuild
  weekly via scheduled GitHub Action, not per-PR. *Why:* daily rebuilds
  churn the repo; weekly matches MTA schedule-change cadence.
- Router and site live in the same repo, deployed together. *Why:* low blast
  radius; avoids cross-repo "yesterday it worked" bisection.

---

## 2. Components (Rust crate internals)

```
nycm-router/
├── Cargo.toml          (deps: wasm-bindgen, serde, bincode, fixedbitset)
├── src/
│   ├── lib.rs          public WASM API
│   ├── types.rs        RouteRequest, Itinerary, Leg, …
│   ├── graph/
│   │   ├── walk.rs     CSR adjacency for walking edges
│   │   └── timetable.rs RAPTOR-ready stops/routes/trips
│   ├── walk.rs         A* over walk graph
│   ├── transit.rs      RAPTOR over timetable
│   ├── stitch.rs       multimodal combiner
│   └── ser.rs          bincode loaders for the two .bin blobs
└── tests/              golden-route fixtures
```

### Public API

```rust
#[wasm_bindgen]
pub struct Router { /* opaque: holds the two graphs */ }

#[wasm_bindgen]
impl Router {
    #[wasm_bindgen(constructor)]
    pub fn new(walk_bytes: &[u8], timetable_bytes: &[u8]) -> Result<Router, JsError>;

    pub fn route(&self, req: JsValue) -> Result<JsValue, JsError>; // serde-bridged
}
```

```rust
struct RouteRequest {
    from: LonLat, to: LonLat,
    depart: i64,            // unix seconds, NY-local epoch
    max_walk_m: f32,        // default 1500
    max_transfers: u8,      // default 4
}

enum Leg {
    Walk { polyline: Vec<LonLat>, seconds: u32, meters: u32 },
    Transit {
        route_id: String, headsign: String, color: String,
        board_stop: StopRef, alight_stop: StopRef,
        board_time: i64, alight_time: i64,
        polyline: Vec<LonLat>,                 // reused from mta-routes.json on JS side
    },
}

struct Itinerary { legs: Vec<Leg>, depart: i64, arrive: i64, transfers: u8 }
```

### Walking graph (`graph/walk.rs`)

Compressed Sparse Row adjacency over OSM nodes filtered to `highway=*` (no
motorway / motorway_link). Each edge stores `(to_node, cost_seconds,
polyline_chunk_ref)`. Snap-to-graph uses a flat-grid spatial index (~250 m
cells) — cheap, no kd-tree dependency. Walking speed = 1.35 m/s. After OSM
parse, one round of **edge contraction** collapses degree-2 chains.

### Transit timetable (`graph/timetable.rs`)

Canonical RAPTOR layout:

```
stops:          [u32]
routes:         [Route { trips_offset, n_trips, stops_offset, n_stops }]
stop_times:     [u32 arrival, u32 departure]   (trip-major)
route_stops:    [u32 stop_id]                  (route-major)
transfers:      CSR { from_stop → [(to_stop, walk_seconds)] }   // ≤300 m
```

The `transfers` table is pre-baked: every pair of stops within 300 m gets a
walking-time edge. RAPTOR uses this for in-station / cross-platform walks
without invoking the full walking router.

### Walking router (`walk.rs`)

Bidirectional A* with haversine heuristic. Two query modes:

- **Point→point.** Standard A*.
- **Point→many-stops.** Single Dijkstra from origin with early termination
  once all candidate stops within `max_walk_m` are settled. This is the
  multimodal access query.

### Transit router (`transit.rs`)

McRAPTOR variant — Pareto-optimal on `(arrival_time, transfers)`. K rounds =
`max_transfers + 1`, default K=5. Multi-criteria buys us "fewest-transfers"
alternatives later without an algorithm change.

### Stitching (`stitch.rs`)

```
1. Walk-only baseline:  point→point A* → t_walk_only
2. Access set:          origin → all stops within 1.5 km   (Dijkstra-to-many)
3. Egress set:          all stops within 1.5 km → destination  (reverse Dijkstra-to-many)
4. RAPTOR (one run):    seed round 0 with every access stop, each labelled with
                         its adjusted departure time (depart + walk_time_to_stop).
                         RAPTOR naturally handles multi-source via the initial bag.
                         For every egress stop reached, compute
                         (arrival_at_egress + walk_time_to_dest, transfers).
                         Keep the Pareto frontier over all egress stops.
5. Pick dominant:       min total arrival across {walk-only, all transit options}
```

The Pareto frontier shape lets us return alternatives later without re-routing.
v1 picks one.

### Concerns

- **Walking polyline payload size.** Long walking legs through dense OSM nodes
  can be hundreds of points. *Mitigation:* Douglas-Peucker (ε=2 m) on walking
  legs before return.
- **Pareto-optimality with continuous walking times.** Theoretically unbounded.
  *Mitigation:* round walk seconds to multiples of 5 s for dominance checks;
  output keeps the exact value.
- **Frequency-based GTFS.** RAPTOR doesn't handle `frequencies.txt` natively.
  NYCT/LIRR/MNR use `stop_times` entries today. *Mitigation:* pipeline asserts
  the absence and fails loudly if that changes.

### Assumptions

- 300 m is a sufficient transfer-walking radius. *Why:* covers Penn Station's
  longest in-station walk with margin.
- 1.5 km is a sane access/egress walk budget. *Why:* ~18 min walking; matches
  defaults in mainstream trip planners. Exposed in `RouteRequest`.
- We pre-bake at build time, not runtime. *Why:* all data is static; even the
  deferred RT overlay only modifies times, not topology.

---

## 3. Data pipelines

### 3a. Walking graph

```
                 ┌──────────────────────────────────────────────────────┐
                 │   scripts/build-walk-graph.sh                        │
                 │                                                      │
   Geofabrik     │   1. download {new-york,connecticut,new-jersey}-     │
   PBFs         ─┼──►      latest.osm.pbf (sha256-verify; skip if       │
   (~400 MB)     │      unchanged)                                      │
                 │   2. osmium merge $PBFS | osmium extract --bbox      │
                 │      $BASEMAP_BBOX  → ny-metro.osm.pbf  (~50 MB)     │
                 │   3. uv run python pipelines/walk_graph.py           │
                 │      ├─ parse PBF with osmium-python                 │
                 │      ├─ keep highway=* minus {motorway, trunk_link,  │
                 │      │   construction, proposed, abandoned, service  │
                 │      │   if access=private}                          │
                 │      ├─ build node→edge adjacency                    │
                 │      ├─ collapse degree-2 chains (contraction)       │
                 │      ├─ build flat-grid snap index (250 m cells)     │
                 │      └─ bincode-serialize → walk_graph.bin           │
                 │   4. split-chunks walk_graph.bin 50M                 │
                 │      → tiles/walk-graph.part-*                       │
                 └──────────────────────────────────────────────────────┘

   Expected sizes:  raw PBF 250 MB → bbox extract 40 MB → bin 30–60 MB
   Expected runtime: ~2 min local, ~3 min CI
```

### 3b. Transit timetable

```
                 ┌──────────────────────────────────────────────────────┐
                 │   scripts/build-timetable.sh                         │
                 │                                                      │
                 │   For each agency in {NYCT, LIRR, MNR}:              │
                 │     1. curl latest GTFS zip                          │
                 │        - NYCT:  http://web.mta.info/developers/      │
                 │                 data/nyct/subway/google_transit.zip  │
                 │        - LIRR:  …data/lirr/google_transit_lirr.zip   │
                 │        - MNR:   …data/mnr/google_transit_mnr.zip     │
                 │     2. uv run python pipelines/timetable.py          │
                 │        ├─ parse stops.txt, routes.txt, trips.txt,    │
                 │        │   stop_times.txt, calendar.txt              │
                 │        ├─ filter to the "current service day"        │
                 │        ├─ sort stop_times by (trip_id, stop_seq)     │
                 │        ├─ assign dense stop_idx & route_idx          │
                 │        ├─ pre-bake transfers (300 m, haversine)      │
                 │        │   across all three agencies                 │
                 │        └─ bincode-serialize → timetable.bin          │
                 │   3. split-chunks timetable.bin 50M (only if needed) │
                 └──────────────────────────────────────────────────────┘

   Expected sizes:  ~10 MB pre-bake, likely single file under 50 MB cap
```

### 3c. Search-stops index

Emitted alongside the timetable:

```
   data/search-stops.json   ~80 KB
   { "Penn Station": [lat,lon, ["LIRR","NJT","ACE","123"]],
     "Atlantic Av-Barclays Center": [lat,lon, ["BDNQR","2345"]],
     … }
```

Feeds `stopsIndex.js` for local-first autocomplete.

### 3d. CI integration

```
   .github/workflows/pages.yml                  (existing — extend)

   on: push to main / weekly schedule
       ├─ assemble-tiles.sh           (already there)
       ├─ build-timetable.sh          (NEW — runs every deploy; ~30s)
       ├─ build-walk-graph.sh         (NEW — gated on cache miss; ~3min)
       ├─ wasm-pack build --release nycm-router  (NEW — Rust→WASM)
       └─ upload-pages-artifact

   .github/workflows/refresh-data.yml            (NEW)
   on: schedule (weekly, Sun 04:00 ET)
       ├─ build-timetable.sh
       ├─ build-walk-graph.sh
       └─ open PR if .part-* hashes changed
```

Weekly PR mechanism keeps `main` clean while still pulling fresh GTFS.

### Concerns

- **Geofabrik vs Overpass for OSM.** Geofabrik gives nightly state-level
  extracts; Overpass rate-limits big bbox queries. We pull NY + CT + NJ
  unconditionally and bbox-clip after merge.
  - *Could go wrong:* Geofabrik occasionally serves stale or partial data.
  - *Mitigation:* sha256-validate against the published checksum file, fail
    on parse anomalies, fail on >5% week-over-week node-count drop.
- **GTFS service-day filtering can drop trips silently** via
  `calendar_dates.txt` exceptions. *Mitigation:* log trip counts before/after,
  fail CI on >5% week-over-week drop.
- **WASM build needs `wasm-pack` + Rust toolchain in CI.** *Mitigation:*
  `dtolnay/rust-toolchain@stable` + `jetli/wasm-pack-action@v0.4.0`.
- **Blob churn in git.** Weekly regen creates new blobs every Sunday — same
  problem flagged in `pending_work.md`. *Mitigation:* call out; design stays
  compatible with later R2 migration.

### Assumptions

- `BASEMAP_BBOX` lives in a shared `scripts/bbox.env`. *Why:* single source of
  truth between pmtiles and walking-graph extracts.
- Weekly refresh suffices. *Why:* MTA changes schedules 2–4×/month.
- Build environment is `uv run python` (matches project Python tooling rule).

---

## 4. Error handling

### Three failure surfaces

```
   ┌──────────┐       ┌──────────┐       ┌─────────────┐       ┌──────────┐
   │  user    │       │ network  │       │   WASM      │       │  pure    │
   │  input   │──────►│ (Photon, │──────►│  boundary   │──────►│  Rust    │
   │          │       │  blobs)  │       │ (JS↔crate)  │       │  kernel  │
   └──────────┘       └──────────┘       └─────────────┘       └──────────┘
       ▲                   ▲                    ▲
       │                   │                    │
   validate              fetch failures      Result<_, JsError>
   here only             here only           here only — panics are bugs
```

### Failure matrix

| Failure | Where caught | UI behavior |
|---|---|---|
| Empty / whitespace query | UI before geocode | Search bar shakes; no request fired |
| Photon timeout / 5xx | `geocode.js` | Inline error chip in dropdown; retry on next keystroke |
| Photon returns 0 results | `geocode.js` | "No matches" + local stop-index results below |
| Blob chunk fetch fails | `router.js` | Toast with retry; routing UI disabled until loaded |
| WASM constructor fails | `router.js` | Console hard error + toast; means the deploy is broken |
| Route returns no path | Rust → `JsError("NoPath")` | "No route found — destination unreachable within the service area" |
| Out-of-bounds origin/dest | Rust → `JsError("OutOfBounds")` | "Outside service area. Routing is limited to NYC + Long Island." |
| Departure > 7 days out | Rust → `JsError("DepartureOutOfRange")` | Won't happen in v1 (UI offers "depart now" only); guard exists for API honesty |

### Rust error model

```rust
#[derive(Debug, thiserror::Error)]
enum RouteError {
    #[error("origin outside service area")] OriginOutOfBounds,
    #[error("destination outside service area")] DestOutOfBounds,
    #[error("no path found")] NoPath,
    #[error("departure time out of range")] DepartureOutOfRange,
}
```

`Result<T, RouteError>` only at the public API. Internals use `expect()` for
invariant violations — those are bugs, not user-recoverable states.

### What we explicitly do not do

- No client-side retry of WASM `route()`. It's deterministic.
- No fallback to a hosted router. Contradicts the "all WASM" constraint.
- No silent coordinate snapping to the basemap bbox.
- No graceful "partial" itineraries. All-or-nothing per request.

### Concerns

- **Photon reliability.** Komoot's hosted instance occasionally rate-limits.
  *Mitigation:* 250 ms debounce; local stop index always works. Escape hatch
  is a one-file swap in `geocode.js`.
- **Bincode version mismatch.** Could be silently broken if the crate rolls
  without rebuilding blobs. *Mitigation:* 4-byte schema-version magic at the
  start of each `.bin`; Rust loader asserts. Mismatch = loud panic at init.

### Assumptions

- User prefers loud failures over silent fallbacks. *Why:* matches the
  project's research-grade ethos and the "Surface tradeoffs" coding rule.
- Toast + retry button is sufficient UX. *Why:* personal/portfolio site,
  not a paying-user product.

---

## 5. Testing strategy

### Layer 1 — Rust unit tests (fast, in-crate)

| Module | What's tested |
|---|---|
| `graph/walk.rs` | CSR invariants, contraction correctness |
| `graph/timetable.rs` | Sort order, stop_idx density, transfer symmetry |
| `walk.rs` | Triangle inequality, deterministic ties, unreachable returns `None` |
| `transit.rs` | RAPTOR round bounds, Pareto dominance |
| `stitch.rs` | Multimodal dominance, walk-only beats transit when faster |

Runs via `cargo test`. Target < 5 s total.

### Layer 2 — Golden-route fixtures

```
   tests/
   ├── fixtures/
   │   ├── tiny_walk.bin      ~30 KB, hand-built 50-node graph around Union Sq
   │   ├── tiny_gtfs.bin      ~10 KB, two routes, four trips
   │   └── routes.toml        the goldens themselves
   └── golden.rs              loads fixtures, runs route(), asserts on Itinerary
```

```toml
[[case]]
name = "walk-only-when-close"
from = [-73.9904, 40.7359]
to   = [-73.9874, 40.7411]
expected_legs = ["Walk"]
expected_minutes_max = 8

[[case]]
name = "transit-preferred-over-long-walk"
from = [-73.9904, 40.7359]
to   = [-73.9442, 40.6782]
expected_legs = ["Walk", "Transit:NQR", "Walk"]
expected_transfers_max = 1
```

### Layer 3 — WASM smoke test (CI)

After `wasm-pack build`, a headless test loads the real basemap-sized blobs
and runs three pinned routes (Times Sq → Penn, JFK → Grand Central, Far
Rockaway → Mineola). Asserts invariants only — no exact-time assertions.
Runs via `node --experimental-wasm-modules`. Target < 30 s including load.

### What we explicitly do not test

- Full OSM walking graph coverage (diminishing returns past ~8 goldens).
- Photon API stub testing (would test the mock, not our code).
- UI rendering snapshots (single-file vanilla JS; brittle, low signal).
- Performance benchmarks (premature; add only if smoke test exceeds 2 s).

### Concerns

- **Goldens drift when GTFS rebuilds.** *Mitigation:* fixtures use synthetic
  tiny GTFS; only Layer 3 uses real blobs and asserts invariants only.
- **Headless WASM memory in CI.** Free runners cap at 7 GB. 60 MB graph +
  10 MB timetable is well within budget. *Mitigation:* if it ever bites,
  smoke runs against a bbox-restricted CI-only blob.

### Assumptions

- 4–8 goldens are enough for v1. *Why:* algorithms are well-understood;
  goldens catch integration bugs, not algorithmic ones.
- No property-based tests. *Why:* over-engineered for this scope.

---

## Summary table

| Aspect | Decision |
|---|---|
| **Modes** | Walking + Subway + LIRR + MNR |
| **Engine** | Hand-rolled Rust → WASM, single `nycm-router` crate |
| **Algorithms** | A* (walking) + McRAPTOR (transit) + stitching |
| **Coverage** | Full basemap bbox (NYC + LI + south Westchester/CT) |
| **Geocoding** | Photon (no key) + local stops index |
| **Transit data** | GTFS static, schedule-only RAPTOR (v1) |
| **Output** | Single best route, polyline + leg-summary card |
| **Data pipelines** | `build-walk-graph.sh` + `build-timetable.sh`, weekly cron + on-deploy |
| **Errors** | Loud at boundaries, no silent fallbacks |
| **Testing** | Rust units + tiny-fixture goldens + WASM smoke test |

## Deferred / out-of-scope for v1

- RT overlay on schedule (live delays influencing the trip plan)
- Multiple-alternative results (Pareto frontier is computed, only one returned)
- Turn-by-turn walking instructions
- Frequency-based GTFS expansion
- Migration of `.part-*` blobs to R2
