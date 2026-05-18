# Plan A: Walking Router Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a search bar and walking-only route planner to the NYC metro map: user types an origin and destination, hits enter, and a walking route is drawn on the map with distance/time. All routing runs in-browser via a Rust→WASM module. No transit yet — that's Plan B.

**Architecture:** A new standalone Rust crate `nycm-router` compiled to WASM via `wasm-pack --target web`. The crate holds a Compressed Sparse Row walking graph built offline from OSM PBF extracts, and runs bidirectional A* with a haversine heuristic. JS-side: small ES modules in `js/` for WASM lifecycle, Photon geocoding, search input, and MapLibre rendering. Existing `index.html` gains a search-bar component and `<script type="module">` imports.

**Tech Stack:**
- Rust 1.78+, `wasm-bindgen 0.2`, `serde 1`, `bincode 1.3`, `wasm-pack 0.13`
- Python 3.11+, `uv`, `osmium 3.7` (pyosmium)
- Bash, `osmium-tool` (CLI), `curl`, `sha256sum`, `split`
- Vanilla ES2022 modules, no bundler
- `node 20` for the WASM smoke test in CI
- GitHub Actions: `dtolnay/rust-toolchain@stable`, `jetli/wasm-pack-action@v0.4.0`, `astral-sh/setup-uv@v3`

---

## Task 1: Project scaffolding

**Files:**
- Create: `nycm-router/Cargo.toml`
- Create: `nycm-router/src/lib.rs` (placeholder)
- Create: `nycm-router/.gitignore`
- Create: `pipelines/pyproject.toml`
- Create: `pipelines/__init__.py` (empty)
- Create: `scripts/bbox.env`
- Modify: `scripts/extract-tiles.sh` (source bbox.env)
- Modify: `.gitignore`

- [ ] **Step 1: Create the Rust crate manifest**

Write `nycm-router/Cargo.toml`:

```toml
[package]
name = "nycm-router"
version = "0.1.0"
edition = "2021"
description = "Walking + transit router for the NYC metro map, compiled to WASM."

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
wasm-bindgen = "0.2"
serde = { version = "1", features = ["derive"] }
serde-wasm-bindgen = "0.6"
bincode = "1.3"
thiserror = "1"

[dev-dependencies]
# golden tests use the rlib build path; no extra deps needed yet

[profile.release]
opt-level = 3
lto = true
codegen-units = 1
panic = "abort"
```

- [ ] **Step 2: Create the placeholder lib**

Write `nycm-router/src/lib.rs`:

```rust
//! nycm-router: walking + transit routing for the NYC metro map.
//! Compiled to WASM via `wasm-pack build --target web`.

pub mod error;
pub mod types;
pub mod graph;
pub mod ser;
pub mod walk;

use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn _start() {
    // wasm-bindgen entry hook; nothing to initialize yet.
}
```

(The module references will fail to compile until later tasks; that's fine — Task 2 creates them.)

- [ ] **Step 3: Crate-local gitignore**

Write `nycm-router/.gitignore`:

```
/target
/pkg
Cargo.lock
```

- [ ] **Step 4: Python pipeline scaffolding**

Write `pipelines/pyproject.toml`:

```toml
[project]
name = "nycm-pipelines"
version = "0.1.0"
description = "Offline data pipelines for the nycm router (OSM walking graph, GTFS timetables)."
requires-python = ">=3.11"
dependencies = [
  "osmium>=3.7",
]

[project.optional-dependencies]
dev = [
  "pytest>=8",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["."]
```

Create empty `pipelines/__init__.py`.

- [ ] **Step 5: Shared bbox env**

Write `scripts/bbox.env`:

```bash
# Single source of truth for the basemap bounding box.
# Used by extract-tiles.sh, build-walk-graph.sh, and the WASM out-of-bounds
# check (re-emitted as a JSON constant during build).
# Format: minLon,minLat,maxLon,maxLat (WGS84)
BASEMAP_BBOX="-74.30,40.49,-71.85,41.20"
BASEMAP_MAXZOOM=14
```

- [ ] **Step 6: Update extract-tiles.sh to source the shared env**

In `scripts/extract-tiles.sh`, replace lines defining `BBOX` and `MAXZOOM` with a source statement. Specifically, change:

```bash
# NYC metro + all of Long Island (Nassau + Suffolk to Montauk Point) + inner NJ/Westchester ring
BBOX="-74.30,40.49,-71.85,41.20"
MAXZOOM=14
```

to:

```bash
# Source the shared basemap bbox (single source of truth).
# shellcheck disable=SC1091
source "$(dirname "$0")/bbox.env"
BBOX="$BASEMAP_BBOX"
MAXZOOM="$BASEMAP_MAXZOOM"
```

- [ ] **Step 7: Update root .gitignore**

Append to `.gitignore`:

```

# Rust + WASM
nycm-router/target/
pkg/
Cargo.lock

# Python pipeline artifacts
.venv/

# Built routing blobs (reassembled from tiles/walk-graph.part-* by CI / dev server)
tiles/walk_graph.bin

# Raw OSM extracts (downloaded by build-walk-graph.sh, not committed)
pipelines/cache/
```

- [ ] **Step 8: Defer crate compile**

`cargo check` will fail right now because `error`, `types`, `graph`, `ser`, `walk` modules don't exist yet — they're created in Tasks 2–5. Skip `cargo check` here; first green build comes at the end of Task 2 once `error.rs` and `types.rs` land.

- [ ] **Step 9: Commit**

```bash
git add nycm-router/ pipelines/ scripts/bbox.env scripts/extract-tiles.sh .gitignore
git commit -m "scaffold nycm-router crate, pipelines package, shared bbox env"
```

---

## Task 2: Core types and error model

**Files:**
- Create: `nycm-router/src/error.rs`
- Create: `nycm-router/src/types.rs`
- Test: in-file `#[cfg(test)] mod tests`

- [ ] **Step 1: Write the failing test (placed in types.rs)**

Write `nycm-router/src/types.rs`:

```rust
//! Cross-WASM-boundary types. All fields use serde for JSON-via-JsValue transport.

use serde::{Deserialize, Serialize};

#[derive(Copy, Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LonLat {
    pub lon: f64,
    pub lat: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RouteRequest {
    pub from: LonLat,
    pub to: LonLat,
    /// Unix seconds, NY-local epoch. Ignored in Plan A; reserved for Plan B.
    pub depart: i64,
    /// Max one-leg walking distance, meters. Default 1500.
    pub max_walk_m: f32,
    /// Max transit transfers. Ignored in Plan A; reserved for Plan B.
    pub max_transfers: u8,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum Leg {
    Walk {
        polyline: Vec<LonLat>,
        seconds: u32,
        meters: u32,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Itinerary {
    pub legs: Vec<Leg>,
    pub depart: i64,
    pub arrive: i64,
    pub transfers: u8,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lonlat_roundtrips_through_json() {
        let p = LonLat { lon: -73.9904, lat: 40.7359 };
        let j = serde_json::to_string(&p).unwrap();
        let back: LonLat = serde_json::from_str(&j).unwrap();
        assert_eq!(p, back);
    }

    #[test]
    fn leg_walk_serializes_with_tag() {
        let leg = Leg::Walk {
            polyline: vec![LonLat { lon: 0.0, lat: 0.0 }],
            seconds: 60,
            meters: 80,
        };
        let j = serde_json::to_string(&leg).unwrap();
        assert!(j.contains(r#""kind":"Walk""#), "got: {j}");
    }
}
```

The tests need `serde_json` as a dev-dependency. Add it.

- [ ] **Step 2: Add serde_json dev-dep**

In `nycm-router/Cargo.toml`, replace the `[dev-dependencies]` section with:

```toml
[dev-dependencies]
serde_json = "1"
```

- [ ] **Step 3: Write the error module**

Write `nycm-router/src/error.rs`:

```rust
//! Public error type. Crosses the WASM boundary via `Display`.

use thiserror::Error;
use wasm_bindgen::JsError;

#[derive(Debug, Error)]
pub enum RouteError {
    #[error("origin outside service area")]
    OriginOutOfBounds,
    #[error("destination outside service area")]
    DestOutOfBounds,
    #[error("no path found")]
    NoPath,
    #[error("departure time out of range")]
    DepartureOutOfRange,
    #[error("router data version mismatch (got {got}, expected {expected})")]
    DataVersionMismatch { got: u32, expected: u32 },
    #[error("malformed router data: {0}")]
    MalformedData(String),
}

impl From<RouteError> for JsError {
    fn from(e: RouteError) -> JsError {
        JsError::new(&e.to_string())
    }
}
```

- [ ] **Step 4: Run the tests**

```bash
cd nycm-router && cargo test --lib types
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add nycm-router/src/error.rs nycm-router/src/types.rs nycm-router/Cargo.toml
git commit -m "router: add RouteError, RouteRequest, Leg, Itinerary types"
```

---

## Task 3: Walk graph data structures (CSR + snap index)

**Files:**
- Create: `nycm-router/src/graph/mod.rs`
- Create: `nycm-router/src/graph/walk.rs`
- Test: `#[cfg(test)]` in `graph/walk.rs`

- [ ] **Step 1: Write the graph module**

Write `nycm-router/src/graph/mod.rs`:

```rust
pub mod walk;
```

- [ ] **Step 2: Write failing tests first**

Write `nycm-router/src/graph/walk.rs`:

```rust
//! Walking graph: CSR adjacency + flat-grid snap index.

use serde::{Deserialize, Serialize};

use crate::types::LonLat;

/// One outgoing edge.
#[derive(Copy, Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WalkEdge {
    pub to: u32,
    /// Travel time in seconds at the canonical walking speed (1.35 m/s).
    pub seconds: u32,
    /// Inclusive byte range into the polyline blob; empty range means "use straight line".
    pub poly_start: u32,
    pub poly_end: u32,
}

/// Compressed Sparse Row walk graph.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WalkGraph {
    /// One LonLat per node.
    pub nodes: Vec<LonLat>,
    /// CSR offsets: edges of node `i` are `edges[adj[i]..adj[i+1]]`.
    /// Length = nodes.len() + 1.
    pub adj: Vec<u32>,
    pub edges: Vec<WalkEdge>,
    /// Polyline coordinate blob (interior nodes of contracted chains).
    pub polylines: Vec<LonLat>,
    /// Flat-grid spatial index for snap-to-nearest-node.
    pub snap: SnapIndex,
}

/// Flat-grid index over a uniform lon/lat lattice. Cells store node indices.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SnapIndex {
    pub min_lon: f64,
    pub min_lat: f64,
    pub cell_deg: f64, // ~0.003 deg ≈ 250 m at NYC latitude
    pub cols: u32,
    pub rows: u32,
    /// CSR-style: `cell_offsets[c..c+1]` slices into `cell_nodes`.
    pub cell_offsets: Vec<u32>,
    pub cell_nodes: Vec<u32>,
}

impl WalkGraph {
    /// Number of nodes.
    pub fn n_nodes(&self) -> usize { self.nodes.len() }

    /// Outgoing edges of node `i`.
    pub fn edges_of(&self, i: u32) -> &[WalkEdge] {
        let lo = self.adj[i as usize] as usize;
        let hi = self.adj[i as usize + 1] as usize;
        &self.edges[lo..hi]
    }

    /// Snap a coordinate to the nearest graph node within a max radius (meters).
    /// Returns `None` if no node is in range — caller maps to `OriginOutOfBounds`.
    pub fn snap(&self, p: LonLat, max_meters: f64) -> Option<u32> {
        let s = &self.snap;
        // 1 deg lat ≈ 111_320 m everywhere; 1 deg lon ≈ 111_320 * cos(lat)
        let max_deg_lat = max_meters / 111_320.0;
        let cos_lat = p.lat.to_radians().cos().max(0.1);
        let max_deg_lon = max_meters / (111_320.0 * cos_lat);
        // Cells the search circle could intersect.
        let col0 = (((p.lon - max_deg_lon - s.min_lon) / s.cell_deg).floor() as i64).max(0) as u32;
        let col1 = (((p.lon + max_deg_lon - s.min_lon) / s.cell_deg).floor() as i64)
            .clamp(0, s.cols as i64 - 1) as u32;
        let row0 = (((p.lat - max_deg_lat - s.min_lat) / s.cell_deg).floor() as i64).max(0) as u32;
        let row1 = (((p.lat + max_deg_lat - s.min_lat) / s.cell_deg).floor() as i64)
            .clamp(0, s.rows as i64 - 1) as u32;
        let mut best: Option<(f64, u32)> = None;
        for r in row0..=row1 {
            for c in col0..=col1 {
                let idx = (r * s.cols + c) as usize;
                let lo = s.cell_offsets[idx] as usize;
                let hi = s.cell_offsets[idx + 1] as usize;
                for &n in &s.cell_nodes[lo..hi] {
                    let q = self.nodes[n as usize];
                    let d = haversine_m(p, q);
                    if d <= max_meters && best.map_or(true, |(bd, _)| d < bd) {
                        best = Some((d, n));
                    }
                }
            }
        }
        best.map(|(_, n)| n)
    }
}

/// Haversine distance in meters.
pub fn haversine_m(a: LonLat, b: LonLat) -> f64 {
    let r = 6_371_000.0_f64;
    let dlat = (b.lat - a.lat).to_radians();
    let dlon = (b.lon - a.lon).to_radians();
    let la1 = a.lat.to_radians();
    let la2 = b.lat.to_radians();
    let h = (dlat / 2.0).sin().powi(2) + la1.cos() * la2.cos() * (dlon / 2.0).sin().powi(2);
    2.0 * r * h.sqrt().asin()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Triangle: A — B — C, all 100 m apart at NYC latitude.
    fn triangle() -> WalkGraph {
        let a = LonLat { lon: -73.9900, lat: 40.7400 };
        let b = LonLat { lon: -73.9888, lat: 40.7400 }; // ~100 m east of A
        let c = LonLat { lon: -73.9888, lat: 40.7409 }; // ~100 m north of B
        let nodes = vec![a, b, c];
        // edges: A↔B, B↔C  (undirected, so each appears twice)
        let edges = vec![
            WalkEdge { to: 1, seconds: 74, poly_start: 0, poly_end: 0 },
            WalkEdge { to: 0, seconds: 74, poly_start: 0, poly_end: 0 },
            WalkEdge { to: 2, seconds: 74, poly_start: 0, poly_end: 0 },
            WalkEdge { to: 1, seconds: 74, poly_start: 0, poly_end: 0 },
        ];
        let adj = vec![0, 1, 3, 4]; // node 0: [0..1), node 1: [1..3), node 2: [3..4)
        let snap = SnapIndex {
            min_lon: -73.9905, min_lat: 40.7395,
            cell_deg: 0.003, cols: 2, rows: 2,
            cell_offsets: vec![0, 3, 3, 3, 3], // all in cell 0
            cell_nodes: vec![0, 1, 2],
        };
        WalkGraph { nodes, adj, edges, polylines: vec![], snap }
    }

    #[test]
    fn edges_of_returns_correct_slice() {
        let g = triangle();
        assert_eq!(g.edges_of(0).len(), 1);
        assert_eq!(g.edges_of(1).len(), 2);
        assert_eq!(g.edges_of(2).len(), 1);
    }

    #[test]
    fn snap_finds_nearest_node() {
        let g = triangle();
        let near_a = LonLat { lon: -73.9901, lat: 40.7401 };
        assert_eq!(g.snap(near_a, 500.0), Some(0));
        let near_c = LonLat { lon: -73.9889, lat: 40.7410 };
        assert_eq!(g.snap(near_c, 500.0), Some(2));
    }

    #[test]
    fn snap_returns_none_when_out_of_range() {
        let g = triangle();
        let far = LonLat { lon: -75.0, lat: 41.5 };
        assert_eq!(g.snap(far, 500.0), None);
    }

    #[test]
    fn haversine_is_symmetric_and_zero_on_self() {
        let a = LonLat { lon: -73.99, lat: 40.74 };
        let b = LonLat { lon: -73.98, lat: 40.75 };
        assert!((haversine_m(a, b) - haversine_m(b, a)).abs() < 1e-6);
        assert!(haversine_m(a, a) < 1e-6);
    }
}
```

- [ ] **Step 3: Run tests — expect 4 passing**

```bash
cd nycm-router && cargo test --lib graph
```

Expected: 4 passed.

- [ ] **Step 4: Commit**

```bash
git add nycm-router/src/graph/
git commit -m "router: walking graph (CSR + flat-grid snap index)"
```

---

## Task 4: Bincode loader with schema-version magic

**Files:**
- Create: `nycm-router/src/ser.rs`
- Test: in-file

- [ ] **Step 1: Write failing test + implementation**

Write `nycm-router/src/ser.rs`:

```rust
//! Bincode loaders. Each blob begins with a 4-byte magic + 4-byte schema version.

use crate::error::RouteError;
use crate::graph::walk::WalkGraph;

pub const WALK_MAGIC: &[u8; 4] = b"NWLK";
pub const WALK_VERSION: u32 = 1;

pub fn load_walk_graph(bytes: &[u8]) -> Result<WalkGraph, RouteError> {
    if bytes.len() < 8 {
        return Err(RouteError::MalformedData("walk blob shorter than header".into()));
    }
    if &bytes[..4] != WALK_MAGIC {
        return Err(RouteError::MalformedData(format!(
            "walk blob magic mismatch: got {:?}", &bytes[..4]
        )));
    }
    let version = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
    if version != WALK_VERSION {
        return Err(RouteError::DataVersionMismatch { got: version, expected: WALK_VERSION });
    }
    bincode::deserialize(&bytes[8..])
        .map_err(|e| RouteError::MalformedData(e.to_string()))
}

pub fn save_walk_graph(graph: &WalkGraph) -> Vec<u8> {
    let mut out = Vec::with_capacity(8);
    out.extend_from_slice(WALK_MAGIC);
    out.extend_from_slice(&WALK_VERSION.to_le_bytes());
    out.extend(bincode::serialize(graph).expect("WalkGraph serializes"));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::walk::{SnapIndex, WalkGraph};

    fn empty_graph() -> WalkGraph {
        WalkGraph {
            nodes: vec![], adj: vec![0], edges: vec![], polylines: vec![],
            snap: SnapIndex {
                min_lon: 0.0, min_lat: 0.0, cell_deg: 0.003,
                cols: 0, rows: 0, cell_offsets: vec![0], cell_nodes: vec![],
            },
        }
    }

    #[test]
    fn roundtrips_empty_graph() {
        let g = empty_graph();
        let bytes = save_walk_graph(&g);
        let back = load_walk_graph(&bytes).unwrap();
        assert_eq!(back.n_nodes(), 0);
    }

    #[test]
    fn rejects_wrong_magic() {
        let mut bytes = save_walk_graph(&empty_graph());
        bytes[0] = b'X';
        match load_walk_graph(&bytes) {
            Err(RouteError::MalformedData(_)) => {}
            other => panic!("expected MalformedData, got {other:?}"),
        }
    }

    #[test]
    fn rejects_wrong_version() {
        let mut bytes = save_walk_graph(&empty_graph());
        bytes[4..8].copy_from_slice(&999u32.to_le_bytes());
        match load_walk_graph(&bytes) {
            Err(RouteError::DataVersionMismatch { got: 999, expected: 1 }) => {}
            other => panic!("expected DataVersionMismatch, got {other:?}"),
        }
    }
}
```

- [ ] **Step 2: Run tests**

```bash
cd nycm-router && cargo test --lib ser
```

Expected: 3 passed.

- [ ] **Step 3: Commit**

```bash
git add nycm-router/src/ser.rs
git commit -m "router: bincode loader with magic + schema version"
```

---

## Task 5: A* walking router

**Files:**
- Create: `nycm-router/src/walk.rs`
- Test: in-file

- [ ] **Step 1: Implementation + tests**

Write `nycm-router/src/walk.rs`:

```rust
//! A* search over the walking graph. Heuristic: haversine / walking_speed.
//!
//! Bidirectional search is a future optimization; this is plain forward A*,
//! which is plenty fast for the basemap-sized graph at WASM speeds.

use std::cmp::Ordering;
use std::collections::BinaryHeap;

use crate::error::RouteError;
use crate::graph::walk::{haversine_m, WalkEdge, WalkGraph};
use crate::types::{Leg, LonLat};

/// Canonical walking speed, m/s.
const WALK_SPEED: f64 = 1.35;
/// Snap radius for endpoints: how far the user's click/search can be from a graph node.
const MAX_SNAP_M: f64 = 200.0;

/// Frontier entry. Cost-first comparison; `BinaryHeap` is a max-heap so we negate.
#[derive(Copy, Clone)]
struct Frontier {
    f: f64,
    g: f64,
    node: u32,
}
impl Eq for Frontier {}
impl PartialEq for Frontier {
    fn eq(&self, o: &Self) -> bool { self.f == o.f }
}
impl Ord for Frontier {
    fn cmp(&self, o: &Self) -> Ordering {
        // reverse so the heap pops the lowest f first
        o.f.partial_cmp(&self.f).unwrap_or(Ordering::Equal)
    }
}
impl PartialOrd for Frontier {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> { Some(self.cmp(o)) }
}

/// Run A* between two coordinates. On success, returns a `Leg::Walk`.
pub fn route_walk(graph: &WalkGraph, from: LonLat, to: LonLat) -> Result<Leg, RouteError> {
    let src = graph.snap(from, MAX_SNAP_M).ok_or(RouteError::OriginOutOfBounds)?;
    let dst = graph.snap(to, MAX_SNAP_M).ok_or(RouteError::DestOutOfBounds)?;

    if src == dst {
        return Ok(Leg::Walk { polyline: vec![graph.nodes[src as usize]], seconds: 0, meters: 0 });
    }

    let n = graph.n_nodes();
    let mut g_score = vec![f64::INFINITY; n];
    let mut came_from = vec![u32::MAX; n];
    let mut came_edge = vec![u32::MAX; n]; // index into graph.edges for the chosen edge
    let mut heap: BinaryHeap<Frontier> = BinaryHeap::new();

    g_score[src as usize] = 0.0;
    heap.push(Frontier { f: heuristic(graph, src, dst), g: 0.0, node: src });

    while let Some(Frontier { g, node, .. }) = heap.pop() {
        if node == dst {
            break;
        }
        if g > g_score[node as usize] {
            continue; // stale
        }
        let edge_offset = graph.adj[node as usize] as u32;
        for (i, e) in graph.edges_of(node).iter().enumerate() {
            let tentative = g + e.seconds as f64;
            if tentative < g_score[e.to as usize] {
                g_score[e.to as usize] = tentative;
                came_from[e.to as usize] = node;
                came_edge[e.to as usize] = edge_offset + i as u32;
                let f = tentative + heuristic(graph, e.to, dst);
                heap.push(Frontier { f, g: tentative, node: e.to });
            }
        }
    }

    if g_score[dst as usize].is_infinite() {
        return Err(RouteError::NoPath);
    }

    let polyline = reconstruct_polyline(graph, src, dst, &came_from, &came_edge);
    let meters = polyline_meters(&polyline) as u32;
    let seconds = g_score[dst as usize].round() as u32;
    Ok(Leg::Walk { polyline, seconds, meters })
}

fn heuristic(graph: &WalkGraph, from: u32, to: u32) -> f64 {
    haversine_m(graph.nodes[from as usize], graph.nodes[to as usize]) / WALK_SPEED
}

fn reconstruct_polyline(
    graph: &WalkGraph,
    src: u32,
    dst: u32,
    came_from: &[u32],
    came_edge: &[u32],
) -> Vec<LonLat> {
    // Walk backwards from dst to src, then reverse.
    let mut chain: Vec<u32> = vec![dst];
    let mut edges_used: Vec<u32> = Vec::new();
    let mut cur = dst;
    while cur != src {
        let edge_idx = came_edge[cur as usize];
        let prev = came_from[cur as usize];
        edges_used.push(edge_idx);
        chain.push(prev);
        cur = prev;
    }
    chain.reverse();
    edges_used.reverse();

    let mut out: Vec<LonLat> = Vec::with_capacity(chain.len());
    out.push(graph.nodes[chain[0] as usize]);
    for (i, &edge_idx) in edges_used.iter().enumerate() {
        let e: &WalkEdge = &graph.edges[edge_idx as usize];
        let s = e.poly_start as usize;
        let p = e.poly_end as usize;
        if p > s {
            out.extend_from_slice(&graph.polylines[s..p]);
        }
        out.push(graph.nodes[chain[i + 1] as usize]);
    }
    out
}

fn polyline_meters(poly: &[LonLat]) -> f64 {
    poly.windows(2).map(|w| haversine_m(w[0], w[1])).sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::walk::{SnapIndex, WalkEdge, WalkGraph};

    /// A-B-C straight line. AB = 100m, BC = 100m. Best path A→C is A→B→C, two edges.
    fn line_graph() -> WalkGraph {
        let a = LonLat { lon: -73.99, lat: 40.74 };
        let b = LonLat { lon: -73.9888, lat: 40.74 };
        let c = LonLat { lon: -73.9876, lat: 40.74 };
        let nodes = vec![a, b, c];
        let edges = vec![
            // A's edges
            WalkEdge { to: 1, seconds: 74, poly_start: 0, poly_end: 0 },
            // B's edges
            WalkEdge { to: 0, seconds: 74, poly_start: 0, poly_end: 0 },
            WalkEdge { to: 2, seconds: 74, poly_start: 0, poly_end: 0 },
            // C's edges
            WalkEdge { to: 1, seconds: 74, poly_start: 0, poly_end: 0 },
        ];
        let adj = vec![0, 1, 3, 4];
        let snap = SnapIndex {
            min_lon: -73.99, min_lat: 40.74,
            cell_deg: 0.003, cols: 2, rows: 2,
            cell_offsets: vec![0, 3, 3, 3, 3],
            cell_nodes: vec![0, 1, 2],
        };
        WalkGraph { nodes, adj, edges, polylines: vec![], snap }
    }

    #[test]
    fn routes_a_to_c_via_b() {
        let g = line_graph();
        let a = g.nodes[0];
        let c = g.nodes[2];
        let leg = route_walk(&g, a, c).unwrap();
        match leg {
            Leg::Walk { polyline, seconds, meters: _ } => {
                assert_eq!(polyline.len(), 3, "should pass through B");
                assert!(seconds >= 145 && seconds <= 150, "got {seconds}s");
            }
        }
    }

    #[test]
    fn same_origin_destination_returns_zero_leg() {
        let g = line_graph();
        let a = g.nodes[0];
        let leg = route_walk(&g, a, a).unwrap();
        match leg {
            Leg::Walk { seconds, meters, polyline } => {
                assert_eq!(seconds, 0);
                assert_eq!(meters, 0);
                assert_eq!(polyline.len(), 1);
            }
        }
    }

    #[test]
    fn out_of_bounds_origin_returns_error() {
        let g = line_graph();
        let far = LonLat { lon: -80.0, lat: 30.0 };
        let c = g.nodes[2];
        match route_walk(&g, far, c) {
            Err(RouteError::OriginOutOfBounds) => {}
            other => panic!("expected OriginOutOfBounds, got {other:?}"),
        }
    }

    #[test]
    fn disconnected_returns_no_path() {
        // Two disconnected components: line_graph + an isolated node.
        let mut g = line_graph();
        g.nodes.push(LonLat { lon: -73.9864, lat: 40.74 }); // node 3
        g.adj.push(g.adj[3]); // no new edges
        // Update snap to include the new node in the same cell.
        g.snap.cell_offsets = vec![0, 4, 4, 4, 4];
        g.snap.cell_nodes.push(3);
        let a = g.nodes[0];
        let d = g.nodes[3];
        match route_walk(&g, a, d) {
            Err(RouteError::NoPath) => {}
            other => panic!("expected NoPath, got {other:?}"),
        }
    }
}
```

- [ ] **Step 2: Run tests**

```bash
cd nycm-router && cargo test --lib walk
```

Expected: 4 passed.

- [ ] **Step 3: Commit**

```bash
git add nycm-router/src/walk.rs
git commit -m "router: A* walking router with deterministic ties + reconstruction"
```

---

## Task 6: Public WASM API + first wasm-pack build

**Files:**
- Modify: `nycm-router/src/lib.rs`
- Modify: `nycm-router/Cargo.toml` (add console_error_panic_hook)

- [ ] **Step 1: Add panic-hook dep for browser-friendly errors**

In `nycm-router/Cargo.toml`, add to `[dependencies]`:

```toml
console_error_panic_hook = "0.1"
```

- [ ] **Step 2: Write the public API**

Replace `nycm-router/src/lib.rs` with:

```rust
//! nycm-router: walking + transit routing for the NYC metro map.
//! Compiled to WASM via `wasm-pack build --target web`.

pub mod error;
pub mod types;
pub mod graph;
pub mod ser;
pub mod walk;

use wasm_bindgen::prelude::*;

use crate::graph::walk::WalkGraph;
use crate::ser::load_walk_graph;
use crate::types::{Itinerary, RouteRequest};

#[wasm_bindgen(start)]
pub fn _start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct Router {
    walk: WalkGraph,
}

#[wasm_bindgen]
impl Router {
    /// Construct a router from a serialized walk graph.
    /// Future signature (Plan B) will accept a second `timetable_bytes` arg.
    #[wasm_bindgen(constructor)]
    pub fn new(walk_bytes: &[u8]) -> Result<Router, JsError> {
        let walk = load_walk_graph(walk_bytes)?;
        Ok(Router { walk })
    }

    /// Route between two coordinates. In Plan A this is always a walking-only itinerary.
    pub fn route(&self, req: JsValue) -> Result<JsValue, JsError> {
        let req: RouteRequest = serde_wasm_bindgen::from_value(req)
            .map_err(|e| JsError::new(&format!("invalid RouteRequest: {e}")))?;
        let leg = crate::walk::route_walk(&self.walk, req.from, req.to)?;
        let seconds = match &leg {
            crate::types::Leg::Walk { seconds, .. } => *seconds as i64,
        };
        let itin = Itinerary {
            depart: req.depart,
            arrive: req.depart + seconds,
            transfers: 0,
            legs: vec![leg],
        };
        Ok(serde_wasm_bindgen::to_value(&itin)?)
    }
}
```

- [ ] **Step 3: Verify wasm-pack toolchain present**

```bash
wasm-pack --version
```

If missing, install:

```bash
curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
```

- [ ] **Step 4: First WASM build**

```bash
cd nycm-router && wasm-pack build --release --target web --out-dir ../pkg
```

Expected: completes successfully; produces `pkg/nycm_router.js`, `pkg/nycm_router_bg.wasm`, `pkg/nycm_router.d.ts`.

- [ ] **Step 5: Verify all unit tests still pass**

```bash
cd nycm-router && cargo test --lib
```

Expected: all tests pass (types, graph, ser, walk).

- [ ] **Step 6: Commit**

```bash
git add nycm-router/src/lib.rs nycm-router/Cargo.toml
git commit -m "router: public WASM Router::{new,route} surface"
```

---

## Task 7: Tiny fixture generator (Python)

**Files:**
- Create: `pipelines/build_tiny_fixture.py`
- Create: `pipelines/tests/test_build_tiny_fixture.py`
- Create: `pipelines/__init__.py` (already exists from Task 1; add nothing)

This script writes a small `tests/fixtures/tiny_walk.bin` that the Rust golden tests load. It produces the same bincode layout the Rust loader expects, so the schema is exercised end-to-end before the heavy OSM pipeline lands.

- [ ] **Step 1: Add Python deps for fixture writing**

We need a Python bincode-1.x serializer. Bincode-1's default config (varint length + native endian + little-endian) is **not** standard MessagePack — we need to either use the `bincode` Python port or write a thin emitter. Easier: emit using a minimal Python encoder that matches bincode 1's default config (fixed-length u64 for sequence lengths, LE, no varint).

Update `pipelines/pyproject.toml` dependencies:

```toml
dependencies = [
  "osmium>=3.7",
]

[project.optional-dependencies]
dev = [
  "pytest>=8",
]
```

(No extra runtime dep — we'll hand-roll a tiny bincode encoder. ~30 lines.)

- [ ] **Step 2: Write a tiny bincode-1 emitter shared module**

Create `pipelines/bincode_emit.py`:

```python
"""
Minimal emitter for bincode 1.x default-config payloads.
Default config: little-endian, fixint length encoding (u64), no variable-length ints.
We only emit what nycm-router's WalkGraph layout needs.
"""
from __future__ import annotations

import struct
from io import BytesIO


class W:
    def __init__(self) -> None:
        self.buf = BytesIO()

    def bytes(self) -> bytes:
        return self.buf.getvalue()

    def u32(self, v: int) -> None:
        self.buf.write(struct.pack("<I", v))

    def u64(self, v: int) -> None:
        self.buf.write(struct.pack("<Q", v))

    def f64(self, v: float) -> None:
        self.buf.write(struct.pack("<d", v))

    def vec_u32(self, xs: list[int]) -> None:
        self.u64(len(xs))
        for x in xs:
            self.u32(x)

    def vec_f64(self, xs: list[float]) -> None:
        self.u64(len(xs))
        for x in xs:
            self.f64(x)

    def vec_lonlat(self, pts: list[tuple[float, float]]) -> None:
        self.u64(len(pts))
        for lon, lat in pts:
            self.f64(lon)
            self.f64(lat)

    def vec_walk_edge(self, edges: list[tuple[int, int, int, int]]) -> None:
        # (to, seconds, poly_start, poly_end)
        self.u64(len(edges))
        for to, sec, ps, pe in edges:
            self.u32(to)
            self.u32(sec)
            self.u32(ps)
            self.u32(pe)


def emit_walk_graph(
    nodes: list[tuple[float, float]],
    adj: list[int],
    edges: list[tuple[int, int, int, int]],
    polylines: list[tuple[float, float]],
    snap_min_lon: float,
    snap_min_lat: float,
    snap_cell_deg: float,
    snap_cols: int,
    snap_rows: int,
    snap_cell_offsets: list[int],
    snap_cell_nodes: list[int],
) -> bytes:
    w = W()
    w.vec_lonlat(nodes)
    w.vec_u32(adj)
    w.vec_walk_edge(edges)
    w.vec_lonlat(polylines)
    # SnapIndex
    w.f64(snap_min_lon)
    w.f64(snap_min_lat)
    w.f64(snap_cell_deg)
    w.u32(snap_cols)
    w.u32(snap_rows)
    w.vec_u32(snap_cell_offsets)
    w.vec_u32(snap_cell_nodes)
    return w.bytes()


WALK_MAGIC = b"NWLK"
WALK_VERSION = 1


def write_walk_blob(path: str, payload: bytes) -> None:
    header = WALK_MAGIC + struct.pack("<I", WALK_VERSION)
    with open(path, "wb") as f:
        f.write(header + payload)
```

- [ ] **Step 3: Write the fixture builder**

Create `pipelines/build_tiny_fixture.py`:

```python
"""
Generate tests/fixtures/tiny_walk.bin: a 4-node walking graph around Union Sq
used by nycm-router's golden tests.

Layout:
    N0 ───── N1 ───── N2
                       │
                       │
                      N3

All edges ~100 m at NYC latitude. Walking speed 1.35 m/s → ~74 s/edge.
"""
from __future__ import annotations

import sys
from pathlib import Path

from bincode_emit import emit_walk_graph, write_walk_blob


def main(out_path: str) -> None:
    # Coordinates near Union Sq, NYC. ~100 m apart in cardinal directions.
    n0 = (-73.9904, 40.7359)
    n1 = (-73.9892, 40.7359)  # 100 m east of n0
    n2 = (-73.9880, 40.7359)  # 100 m east of n1
    n3 = (-73.9880, 40.7350)  # 100 m south of n2

    nodes = [n0, n1, n2, n3]

    # Edges, in adj order (one block per node).
    # Node 0: → 1
    # Node 1: → 0, → 2
    # Node 2: → 1, → 3
    # Node 3: → 2
    edges = [
        (1, 74, 0, 0),
        (0, 74, 0, 0),
        (2, 74, 0, 0),
        (1, 74, 0, 0),
        (3, 74, 0, 0),
        (2, 74, 0, 0),
    ]
    adj = [0, 1, 3, 5, 6]

    # Snap: one big cell covering everything.
    snap_min_lon = -73.9910
    snap_min_lat = 40.7345
    cell_deg = 0.01  # ~1.1 km, larger than the spread
    cols, rows = 1, 1
    cell_offsets = [0, 4]
    cell_nodes = [0, 1, 2, 3]

    payload = emit_walk_graph(
        nodes=nodes,
        adj=adj,
        edges=edges,
        polylines=[],
        snap_min_lon=snap_min_lon,
        snap_min_lat=snap_min_lat,
        snap_cell_deg=cell_deg,
        snap_cols=cols,
        snap_rows=rows,
        snap_cell_offsets=cell_offsets,
        snap_cell_nodes=cell_nodes,
    )
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    write_walk_blob(out_path, payload)
    print(f"wrote {out_path} ({len(payload) + 8} bytes)")


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "nycm-router/tests/fixtures/tiny_walk.bin"
    main(out)
```

- [ ] **Step 4: Test that bincode emitter actually matches Rust's expected layout**

Write `pipelines/tests/test_build_tiny_fixture.py`:

```python
"""
Round-trip check: emit the tiny fixture, then call out to `cargo run --example
load_tiny_fixture` (a dev binary defined next) to confirm Rust deserializes it.
"""
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def test_fixture_loads_in_rust(tmp_path):
    out = tmp_path / "tiny_walk.bin"
    subprocess.run(
        ["python", str(REPO / "pipelines" / "build_tiny_fixture.py"), str(out)],
        check=True,
    )
    res = subprocess.run(
        ["cargo", "run", "--quiet", "--example", "load_tiny_fixture", str(out)],
        cwd=REPO / "nycm-router",
        check=True,
        capture_output=True,
        text=True,
    )
    assert "nodes=4" in res.stdout, res.stdout
    assert "edges=6" in res.stdout, res.stdout
```

- [ ] **Step 5: Add the Rust example binary that the test invokes**

Create `nycm-router/examples/load_tiny_fixture.rs`:

```rust
//! Dev-only: load a tiny walk blob and print summary stats.
//! Run: cargo run --example load_tiny_fixture path/to/tiny_walk.bin

use std::env;
use std::fs;

fn main() {
    let path = env::args().nth(1).expect("usage: load_tiny_fixture <path>");
    let bytes = fs::read(&path).expect("read blob");
    let g = nycm_router::ser::load_walk_graph(&bytes).expect("load");
    let n_edges: usize = (0..g.n_nodes())
        .map(|i| g.edges_of(i as u32).len())
        .sum();
    println!("nodes={} edges={}", g.n_nodes(), n_edges);
}
```

- [ ] **Step 6: Bootstrap uv env and run the round-trip test**

```bash
cd pipelines && uv venv && uv pip install -e ".[dev]" && uv run pytest -v
```

Expected: 1 passed.

- [ ] **Step 7: Generate the real tiny fixture and check it in**

```bash
cd .. && uv run --directory pipelines python pipelines/build_tiny_fixture.py nycm-router/tests/fixtures/tiny_walk.bin
```

Expected: `wrote nycm-router/tests/fixtures/tiny_walk.bin (NNN bytes)`.

- [ ] **Step 8: Commit**

```bash
git add pipelines/bincode_emit.py pipelines/build_tiny_fixture.py pipelines/tests/ \
        nycm-router/examples/load_tiny_fixture.rs nycm-router/tests/fixtures/tiny_walk.bin
git commit -m "pipelines: tiny fixture generator + round-trip test"
```

---

## Task 8: Walking golden test (one route)

**Files:**
- Create: `nycm-router/tests/golden.rs`
- Create: `nycm-router/tests/fixtures/routes.toml`
- Modify: `nycm-router/Cargo.toml` (add toml dev-dep)

- [ ] **Step 1: Add toml dev-dep**

Replace `[dev-dependencies]` in `nycm-router/Cargo.toml` with:

```toml
[dev-dependencies]
serde_json = "1"
toml = "0.8"
```

- [ ] **Step 2: Write the goldens TOML**

Write `nycm-router/tests/fixtures/routes.toml`:

```toml
# Golden routes for walking-only (Plan A).
# Coordinates use the tiny_walk.bin fixture (4-node Union Sq grid).
# N0=(-73.9904, 40.7359)  N1=(-73.9892, 40.7359)
# N2=(-73.9880, 40.7359)  N3=(-73.9880, 40.7350)

[[case]]
name = "n0_to_n2_via_n1"
from = [-73.9904, 40.7359]
to   = [-73.9880, 40.7359]
expected_legs = ["Walk"]
expected_polyline_len = 3
expected_seconds_min = 140
expected_seconds_max = 160

[[case]]
name = "n0_to_n3_corner"
from = [-73.9904, 40.7359]
to   = [-73.9880, 40.7350]
expected_legs = ["Walk"]
expected_polyline_len = 4
expected_seconds_min = 210
expected_seconds_max = 240

[[case]]
name = "same_point"
from = [-73.9904, 40.7359]
to   = [-73.9904, 40.7359]
expected_legs = ["Walk"]
expected_polyline_len = 1
expected_seconds_min = 0
expected_seconds_max = 0
```

- [ ] **Step 3: Write the golden runner**

Write `nycm-router/tests/golden.rs`:

```rust
//! Integration test: load fixture blob + run goldens from routes.toml.

use std::fs;
use std::path::PathBuf;

use serde::Deserialize;

use nycm_router::ser::load_walk_graph;
use nycm_router::types::{Leg, LonLat};
use nycm_router::walk::route_walk;

#[derive(Deserialize)]
struct Cases {
    case: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    from: [f64; 2],
    to: [f64; 2],
    expected_legs: Vec<String>,
    expected_polyline_len: usize,
    expected_seconds_min: u32,
    expected_seconds_max: u32,
}

fn fixture_path(name: &str) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("tests/fixtures");
    p.push(name);
    p
}

#[test]
fn walking_goldens() {
    let bytes = fs::read(fixture_path("tiny_walk.bin")).expect("fixture present");
    let graph = load_walk_graph(&bytes).expect("loads");

    let toml_str = fs::read_to_string(fixture_path("routes.toml")).expect("toml present");
    let cases: Cases = toml::from_str(&toml_str).expect("parse toml");

    for c in cases.case {
        let from = LonLat { lon: c.from[0], lat: c.from[1] };
        let to = LonLat { lon: c.to[0], lat: c.to[1] };
        let leg = route_walk(&graph, from, to)
            .unwrap_or_else(|e| panic!("case {}: route failed: {e}", c.name));
        assert_eq!(c.expected_legs, vec!["Walk".to_string()],
                   "case {}: leg kind mismatch", c.name);
        match leg {
            Leg::Walk { polyline, seconds, meters: _ } => {
                assert_eq!(polyline.len(), c.expected_polyline_len,
                           "case {}: polyline len", c.name);
                assert!((c.expected_seconds_min..=c.expected_seconds_max).contains(&seconds),
                        "case {}: seconds {} outside [{}, {}]",
                        c.name, seconds, c.expected_seconds_min, c.expected_seconds_max);
            }
        }
    }
}
```

- [ ] **Step 4: Run the golden test**

```bash
cd nycm-router && cargo test --test golden
```

Expected: 1 passed (the test runs all 3 cases internally).

- [ ] **Step 5: Commit**

```bash
git add nycm-router/tests/golden.rs nycm-router/tests/fixtures/routes.toml nycm-router/Cargo.toml
git commit -m "router: walking-only goldens against tiny fixture"
```

---

## Task 9: Python OSM walking-graph pipeline

**Files:**
- Create: `pipelines/walk_graph.py`
- Create: `pipelines/tests/test_walk_graph.py`
- Create: `pipelines/tests/fixtures/mini.osm.pbf` (generated, see below)
- Modify: `pipelines/pyproject.toml` (no new deps; osmium already there)

This is the real OSM → walk_graph.bin pipeline. Uses pyosmium to parse a PBF, filters to walking-eligible highways, builds a node→edge graph, runs degree-2 contraction, builds the snap index, and emits the bincode blob.

- [ ] **Step 1: Write the pipeline**

Create `pipelines/walk_graph.py`:

```python
"""
Build a walking graph from an OSM PBF.

    uv run python pipelines/walk_graph.py <input.osm.pbf> <output.bin>

Walking-eligible: highway tag in {footway, path, sidewalk, pedestrian,
residential, living_street, service, unclassified, tertiary, secondary,
primary, trunk, cycleway, steps, track}. Excludes: motorway, motorway_link,
trunk_link (handled by deny-list), and any way with access=private/no.

Steps:
  1. Pass 1: collect node IDs touched by eligible ways.
  2. Pass 2: collect coordinates for those nodes.
  3. Build directed (undirected-as-two-directed) adjacency.
  4. Contract degree-2 chains (collapse interior nodes into polyline segments).
  5. Build flat-grid snap index (~250 m cells).
  6. Emit bincode blob.
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from pathlib import Path

import osmium

from bincode_emit import emit_walk_graph, write_walk_blob

WALK_SPEED = 1.35  # m/s

ALLOWED = {
    "footway", "path", "sidewalk", "pedestrian", "residential", "living_street",
    "service", "unclassified", "tertiary", "secondary", "primary", "trunk",
    "cycleway", "steps", "track",
}


def is_walkable(way) -> bool:
    hw = way.tags.get("highway")
    if hw is None or hw not in ALLOWED:
        return False
    if way.tags.get("access") in {"private", "no"}:
        return False
    return True


class WayCollector(osmium.SimpleHandler):
    """Pass 1: gather way → list of node refs for walkable ways."""

    def __init__(self) -> None:
        super().__init__()
        self.ways: list[list[int]] = []
        self.touched: set[int] = set()

    def way(self, w) -> None:
        if not is_walkable(w):
            return
        ns = [n.ref for n in w.nodes]
        if len(ns) < 2:
            return
        self.ways.append(ns)
        self.touched.update(ns)


class NodeCollector(osmium.SimpleHandler):
    """Pass 2: gather (lon, lat) for the touched node set."""

    def __init__(self, wanted: set[int]) -> None:
        super().__init__()
        self.wanted = wanted
        self.coords: dict[int, tuple[float, float]] = {}

    def node(self, n) -> None:
        if n.id in self.wanted:
            self.coords[n.id] = (n.location.lon, n.location.lat)


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    r = 6_371_000.0
    lon1, lat1 = a
    lon2, lat2 = b
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    la1 = math.radians(lat1)
    la2 = math.radians(lat2)
    h = math.sin(dlat / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def build_adj(
    ways: list[list[int]],
    coords: dict[int, tuple[float, float]],
) -> dict[int, list[tuple[int, float, list[tuple[float, float]]]]]:
    """
    Returns: osm_id → list of (neighbor_osm_id, distance_m, polyline_excluding_endpoints).
    Polyline is empty initially (no contraction yet).
    """
    adj: dict[int, list[tuple[int, float, list[tuple[float, float]]]]] = defaultdict(list)
    for ns in ways:
        for u, v in zip(ns, ns[1:]):
            if u not in coords or v not in coords:
                continue
            d = haversine_m(coords[u], coords[v])
            adj[u].append((v, d, []))
            adj[v].append((u, d, []))
    return adj


def contract_degree_2(
    adj: dict[int, list[tuple[int, float, list[tuple[float, float]]]]],
    coords: dict[int, tuple[float, float]],
) -> dict[int, list[tuple[int, float, list[tuple[float, float]]]]]:
    """Collapse chains: A — m1 — m2 — … — B where each interior is degree-2."""
    # Identify nodes to keep: degree != 2.
    keep = {n for n, es in adj.items() if len(es) != 2}
    new_adj: dict[int, list[tuple[int, float, list[tuple[float, float]]]]] = defaultdict(list)
    visited_edges: set[tuple[int, int]] = set()

    for start in keep:
        for nb, d, _poly in adj[start]:
            if (start, nb) in visited_edges:
                continue
            # Walk chain from start through nb until we hit another keep node.
            prev = start
            cur = nb
            total_d = d
            interior: list[tuple[float, float]] = []
            while cur not in keep:
                interior.append(coords[cur])
                # cur has exactly two neighbors; find the one that isn't prev.
                nxt = None
                for nb2, d2, _ in adj[cur]:
                    if nb2 != prev:
                        nxt = nb2
                        next_d = d2
                        break
                if nxt is None:
                    break  # degenerate dead-end
                prev = cur
                cur = nxt
                total_d += next_d
            new_adj[start].append((cur, total_d, interior))
            visited_edges.add((start, cur))
            # Reverse direction handled by the symmetric pass from `cur`.

    return new_adj


def build_snap(
    nodes: list[tuple[float, float]],
    cell_deg: float,
) -> tuple[float, float, int, int, list[int], list[int]]:
    if not nodes:
        return 0.0, 0.0, 0, 0, [0], []
    lons = [p[0] for p in nodes]
    lats = [p[1] for p in nodes]
    min_lon = min(lons) - cell_deg
    min_lat = min(lats) - cell_deg
    max_lon = max(lons) + cell_deg
    max_lat = max(lats) + cell_deg
    cols = int(math.ceil((max_lon - min_lon) / cell_deg))
    rows = int(math.ceil((max_lat - min_lat) / cell_deg))
    bins: dict[int, list[int]] = defaultdict(list)
    for idx, (lon, lat) in enumerate(nodes):
        c = int((lon - min_lon) / cell_deg)
        r = int((lat - min_lat) / cell_deg)
        c = max(0, min(cols - 1, c))
        r = max(0, min(rows - 1, r))
        bins[r * cols + c].append(idx)
    cell_offsets = [0]
    cell_nodes: list[int] = []
    for k in range(cols * rows):
        cell_nodes.extend(bins.get(k, []))
        cell_offsets.append(len(cell_nodes))
    return min_lon, min_lat, cols, rows, cell_offsets, cell_nodes


def main(in_pbf: str, out_bin: str) -> None:
    way_h = WayCollector()
    print(f"pass 1: scanning ways in {in_pbf}", file=sys.stderr)
    way_h.apply_file(in_pbf)
    print(f"  {len(way_h.ways)} walkable ways, {len(way_h.touched)} unique nodes", file=sys.stderr)

    node_h = NodeCollector(way_h.touched)
    print("pass 2: collecting node coordinates", file=sys.stderr)
    node_h.apply_file(in_pbf, locations=False)
    print(f"  {len(node_h.coords)} coordinates", file=sys.stderr)

    raw_adj = build_adj(way_h.ways, node_h.coords)
    print(f"raw graph: {len(raw_adj)} nodes", file=sys.stderr)

    contracted = contract_degree_2(raw_adj, node_h.coords)
    print(f"contracted: {len(contracted)} nodes", file=sys.stderr)

    # Densify osm_id → dense_idx.
    keep_ids = sorted(contracted.keys())
    id_to_idx = {osm_id: i for i, osm_id in enumerate(keep_ids)}
    nodes = [node_h.coords[osm_id] for osm_id in keep_ids]

    # Build CSR + polyline blob.
    adj_offsets: list[int] = [0]
    edges: list[tuple[int, int, int, int]] = []
    polylines: list[tuple[float, float]] = []
    for osm_id in keep_ids:
        for nb_id, dist_m, interior in contracted[osm_id]:
            if nb_id not in id_to_idx:
                continue
            poly_start = len(polylines)
            polylines.extend(interior)
            poly_end = len(polylines)
            seconds = max(1, int(round(dist_m / WALK_SPEED)))
            edges.append((id_to_idx[nb_id], seconds, poly_start, poly_end))
        adj_offsets.append(len(edges))

    print(f"emitting {len(nodes)} nodes, {len(edges)} edges, {len(polylines)} polyline pts",
          file=sys.stderr)

    cell_deg = 0.003  # ~250 m at NYC latitude
    min_lon, min_lat, cols, rows, cell_offsets, cell_nodes = build_snap(nodes, cell_deg)

    payload = emit_walk_graph(
        nodes=nodes,
        adj=adj_offsets,
        edges=edges,
        polylines=polylines,
        snap_min_lon=min_lon,
        snap_min_lat=min_lat,
        snap_cell_deg=cell_deg,
        snap_cols=cols,
        snap_rows=rows,
        snap_cell_offsets=cell_offsets,
        snap_cell_nodes=cell_nodes,
    )
    Path(out_bin).parent.mkdir(parents=True, exist_ok=True)
    write_walk_blob(out_bin, payload)
    print(f"wrote {out_bin} ({(len(payload) + 8) / 1e6:.1f} MB)", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: walk_graph.py <input.osm.pbf> <output.bin>", file=sys.stderr)
        sys.exit(2)
    main(sys.argv[1], sys.argv[2])
```

- [ ] **Step 2: Generate a mini PBF fixture for the pipeline test**

We need a small OSM PBF input for the test. Generate it with osmium from an inline OSM XML.

Create `pipelines/tests/build_mini_pbf.py`:

```python
"""Generate a tiny OSM PBF for testing walk_graph.py."""
from __future__ import annotations

import subprocess
from pathlib import Path
from textwrap import dedent

OSM_XML = dedent("""\
    <?xml version="1.0" encoding="UTF-8"?>
    <osm version="0.6">
      <node id="1" lat="40.7359" lon="-73.9904" version="1"/>
      <node id="2" lat="40.7359" lon="-73.9892" version="1"/>
      <node id="3" lat="40.7359" lon="-73.9880" version="1"/>
      <node id="4" lat="40.7350" lon="-73.9880" version="1"/>
      <node id="5" lat="40.7341" lon="-73.9880" version="1"/>
      <way id="100" version="1">
        <nd ref="1"/><nd ref="2"/><nd ref="3"/>
        <tag k="highway" v="footway"/>
      </way>
      <way id="101" version="1">
        <nd ref="3"/><nd ref="4"/><nd ref="5"/>
        <tag k="highway" v="footway"/>
      </way>
    </osm>
""")


def main(out: Path) -> None:
    xml_path = out.with_suffix(".osm")
    xml_path.write_text(OSM_XML)
    subprocess.run(["osmium", "cat", "-o", str(out), "-O", str(xml_path)], check=True)
    print(f"wrote {out}")


if __name__ == "__main__":
    import sys
    main(Path(sys.argv[1]))
```

- [ ] **Step 3: Write the pipeline test**

Create `pipelines/tests/test_walk_graph.py`:

```python
"""End-to-end test for walk_graph.py against a tiny PBF."""
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def test_pipeline_produces_loadable_blob(tmp_path):
    pbf = tmp_path / "mini.osm.pbf"
    subprocess.run(
        ["python", str(REPO / "pipelines" / "tests" / "build_mini_pbf.py"), str(pbf)],
        check=True,
    )
    out_bin = tmp_path / "mini_walk.bin"
    subprocess.run(
        ["python", str(REPO / "pipelines" / "walk_graph.py"), str(pbf), str(out_bin)],
        check=True,
    )
    assert out_bin.exists() and out_bin.stat().st_size > 8

    # Confirm Rust loader accepts it.
    res = subprocess.run(
        ["cargo", "run", "--quiet", "--example", "load_tiny_fixture", str(out_bin)],
        cwd=REPO / "nycm-router",
        check=True,
        capture_output=True,
        text=True,
    )
    # After contraction: node #3 has degree 2 (one neighbor in each way, {2, 4}),
    # so it's collapsed. Nodes #2 and #4 are also degree-2 interior, so also collapsed.
    # Survivors: #1 and #5 (each degree 1), one undirected edge between them with
    # interior polyline = [n2, n3, n4]. Output: 2 nodes, 2 directed edges.
    assert "nodes=2" in res.stdout, res.stdout
    assert "edges=2" in res.stdout, res.stdout
```

- [ ] **Step 4: Install osmium-tool**

```bash
# Linux
sudo apt-get update && sudo apt-get install -y osmium-tool
# or macOS
brew install osmium-tool
```

Verify: `osmium --version`.

- [ ] **Step 5: Run the test**

```bash
cd pipelines && uv run pytest -v
```

Expected: both tests pass (tiny fixture + walk-graph pipeline).

- [ ] **Step 6: Commit**

```bash
git add pipelines/walk_graph.py pipelines/tests/test_walk_graph.py pipelines/tests/build_mini_pbf.py
git commit -m "pipelines: OSM PBF → walk_graph.bin (filter, contract, snap)"
```

---

## Task 10: build-walk-graph.sh wrapper

**Files:**
- Create: `scripts/build-walk-graph.sh`
- Modify: `.gitignore` (already gitignores `tiles/walk_graph.bin` from Task 1)

- [ ] **Step 1: Write the script**

Create `scripts/build-walk-graph.sh`:

```bash
#!/usr/bin/env bash
# Build tiles/walk_graph.bin from OSM PBF extracts for the basemap bbox.
#
# Pulls NY + CT + NJ from Geofabrik (cached locally), merges them, clips to
# $BASEMAP_BBOX, runs the Python pipeline, and splits the output into
# tiles/walk-graph.part-* chunks (committed; the assembled .bin is gitignored).
#
# Requires: osmium-tool, curl, sha256sum, uv

set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck disable=SC1091
source scripts/bbox.env

CACHE=pipelines/cache
mkdir -p "$CACHE" tiles

STATES=("new-york" "connecticut" "new-jersey")
PBF_PATHS=()

for state in "${STATES[@]}"; do
  url="https://download.geofabrik.de/north-america/us/${state}-latest.osm.pbf"
  local_pbf="$CACHE/${state}-latest.osm.pbf"
  local_md5="$CACHE/${state}-latest.osm.pbf.md5"

  # Refresh checksums + file weekly (or on missing).
  if [[ ! -f "$local_pbf" || ! -f "$local_md5" ]]; then
    echo "downloading $state..."
    curl -fSL --retry 3 -o "$local_pbf" "$url"
    curl -fSL --retry 3 -o "$local_md5" "${url}.md5"
    (cd "$CACHE" && md5sum -c "$(basename "$local_md5")")
  else
    echo "using cached $local_pbf"
  fi
  PBF_PATHS+=("$local_pbf")
done

MERGED="$CACHE/merged.osm.pbf"
echo "merging ${#PBF_PATHS[@]} state PBFs..."
osmium merge -O -o "$MERGED" "${PBF_PATHS[@]}"

EXTRACT="$CACHE/ny-metro.osm.pbf"
echo "clipping to bbox $BASEMAP_BBOX..."
osmium extract --bbox "$BASEMAP_BBOX" -O -o "$EXTRACT" "$MERGED"

OUT=tiles/walk_graph.bin
echo "running Python pipeline → $OUT"
uv run --directory pipelines python walk_graph.py "$EXTRACT" "$(pwd)/$OUT"

# Sanity: node count should be in the expected range. If grossly off, fail.
SIZE=$(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT")
echo "walk_graph.bin size: $SIZE bytes"
if (( SIZE < 5_000_000 )); then
  echo "ERROR: walk_graph.bin suspiciously small ($SIZE bytes)" >&2
  exit 1
fi

# Chunk for GitHub's 100 MB per-file cap. Match the tiles/ chunking style.
echo "chunking..."
rm -f tiles/walk-graph.part-*
split -b 50M -a 2 "$OUT" tiles/walk-graph.part-
ls -lh tiles/walk-graph.part-*
```

- [ ] **Step 2: Mark executable + smoke run (skip if osmium missing)**

```bash
chmod +x scripts/build-walk-graph.sh
scripts/build-walk-graph.sh
```

This is the first time touching real Geofabrik data — it'll download ~400 MB (cached). Expect a 2–4 minute run. End state: `tiles/walk_graph.bin` exists and `tiles/walk-graph.part-*` chunks are produced.

If the dev environment doesn't have outbound HTTP or osmium-tool, this step is skippable — CI will run it on every deploy.

- [ ] **Step 3: Sanity-check the produced blob loads in Rust**

```bash
cd nycm-router && cargo run --example load_tiny_fixture ../tiles/walk_graph.bin
```

Expected: `nodes=NNNNN edges=NNNNNN` with both numbers in the 6-figure range (basemap-sized).

- [ ] **Step 4: Add the assemble step that mirrors assemble-tiles.sh**

Create `scripts/assemble-walk-graph.sh`:

```bash
#!/usr/bin/env bash
# Reassemble tiles/walk_graph.bin from its committed chunks.
# Idempotent: only assembles when the full file is missing or older than any part.
# Mirrors scripts/assemble-tiles.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=tiles/walk_graph.bin
PARTS=(tiles/walk-graph.part-*)

if [[ ${#PARTS[@]} -eq 0 || ! -e "${PARTS[0]}" ]]; then
  echo "no chunks found at tiles/walk-graph.part-* — run scripts/build-walk-graph.sh first" >&2
  exit 1
fi

needs_rebuild=0
if [[ ! -f "$OUT" ]]; then
  needs_rebuild=1
else
  for p in "${PARTS[@]}"; do
    if [[ "$p" -nt "$OUT" ]]; then needs_rebuild=1; break; fi
  done
fi

if [[ "$needs_rebuild" -eq 1 ]]; then
  echo "assembling $OUT from ${#PARTS[@]} chunks"
  cat "${PARTS[@]}" > "$OUT"
  ls -lh "$OUT"
else
  echo "$OUT is up to date"
fi
```

```bash
chmod +x scripts/assemble-walk-graph.sh
```

- [ ] **Step 5: Commit (chunks + scripts)**

```bash
git add scripts/build-walk-graph.sh scripts/assemble-walk-graph.sh tiles/walk-graph.part-*
git commit -m "scripts: build & assemble walk_graph.bin from chunked OSM extracts"
```

---

## Task 11: Photon geocoder module

**Files:**
- Create: `js/geocode.js`

Pure JS module. Takes a query string, returns up to 5 ranked results from Komoot's hosted Photon at `photon.komoot.io`. Debouncing is the caller's responsibility — this module just does one fetch per call.

- [ ] **Step 1: Write the module**

Create `js/geocode.js`:

```javascript
// Photon geocoder client. Returns up to 5 results biased toward the basemap area.
// Caller is responsible for debouncing.

const PHOTON_URL = "https://photon.komoot.io/api/";

// Lower-right + upper-left corners of the basemap (matches scripts/bbox.env).
// Used to bias Photon's ranking; not a hard filter.
const BIAS_LON = -73.5;
const BIAS_LAT = 40.7;

/** @typedef {{ lon: number, lat: number, label: string }} GeocodeResult */

/**
 * @param {string} query
 * @param {AbortSignal} [signal]
 * @returns {Promise<GeocodeResult[]>}
 */
export async function geocode(query, signal) {
  const q = query.trim();
  if (!q) return [];
  const url = new URL(PHOTON_URL);
  url.searchParams.set("q", q);
  url.searchParams.set("limit", "5");
  url.searchParams.set("lon", String(BIAS_LON));
  url.searchParams.set("lat", String(BIAS_LAT));
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`photon ${res.status}`);
  const json = await res.json();
  return json.features.map(featureToResult).filter(Boolean);
}

function featureToResult(f) {
  const [lon, lat] = f.geometry?.coordinates || [];
  if (typeof lon !== "number" || typeof lat !== "number") return null;
  const p = f.properties || {};
  const label = [p.name, p.street, p.city, p.state]
    .filter(Boolean).join(", ");
  return { lon, lat, label: label || `${lat.toFixed(4)}, ${lon.toFixed(4)}` };
}
```

- [ ] **Step 2: Sanity test in the dev server**

Add a tiny inline check via `python3 scripts/serve.py` and a console one-liner:

```bash
python3 scripts/serve.py &
sleep 1
# In Chrome DevTools console at http://127.0.0.1:8000:
#   import('./js/geocode.js').then(m => m.geocode('Times Square').then(console.log))
# Expected: array of 1-5 results, top hit near (lon=-73.99, lat=40.76)
```

(Skip if dev server can't reach external internet.)

- [ ] **Step 3: Commit**

```bash
git add js/geocode.js
git commit -m "ui: Photon geocoder client (no key, biased to basemap area)"
```

---

## Task 12: Search bar UI

**Files:**
- Create: `js/search.js`
- Modify: `index.html` (add search-bar markup + style)

- [ ] **Step 1: Add the search-bar HTML**

In `index.html`, immediately after the existing `<div class="brand">…</div>` element (find it near the top of `<body>`), insert:

```html
<div class="search" id="search">
  <div class="search-row">
    <input class="search-input" id="from-input" type="text" placeholder="From" autocomplete="off"/>
    <button class="swap-btn" id="swap-btn" title="Swap from/to">⇅</button>
  </div>
  <div class="search-row">
    <input class="search-input" id="to-input" type="text" placeholder="To" autocomplete="off"/>
    <button class="go-btn" id="go-btn" disabled>Go</button>
  </div>
  <div class="search-dropdown" id="search-dropdown" hidden></div>
  <div class="search-status" id="search-status"></div>
</div>
```

- [ ] **Step 2: Add the matching CSS**

Find the `<style>` block in `index.html` and append (still inside `:root`/`<style>`):

```css
.search {
  position: absolute;
  top: 16px; right: 16px;
  z-index: 1;
  width: 320px;
  padding: 10px;
  background: var(--chip-bg);
  border: 1px solid var(--chip-border);
  border-radius: 12px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 24px rgba(15, 23, 42, 0.06);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  color: var(--ink);
  font-family: inherit;
}
.search-row { display: flex; gap: 6px; margin-bottom: 6px; }
.search-row:last-of-type { margin-bottom: 0; }
.search-input {
  flex: 1;
  padding: 6px 10px;
  font: inherit; font-size: 13px;
  border: 1px solid var(--chip-border);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.5);
  color: var(--ink);
  outline: none;
  transition: border-color 160ms ease;
}
.search-input:focus { border-color: var(--ink); }
.swap-btn, .go-btn {
  font: inherit; font-size: 13px; font-weight: 600;
  border: 1px solid var(--chip-border);
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  padding: 0 10px;
  transition: all 160ms ease;
}
.go-btn:not([disabled]) { background: var(--ink); color: var(--earth); border-color: var(--ink); }
.go-btn[disabled] { cursor: not-allowed; opacity: 0.5; }
.search-dropdown {
  margin-top: 6px;
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--chip-border);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.92);
}
.search-result {
  padding: 6px 10px;
  cursor: pointer;
  font-size: 12.5px;
  border-bottom: 1px solid var(--chip-border);
}
.search-result:last-child { border-bottom: none; }
.search-result:hover, .search-result.active { background: rgba(38, 70, 83, 0.08); }
.search-status { margin-top: 6px; font-size: 11px; color: var(--muted); min-height: 14px; }
.search-status.error { color: #b94a4a; }
```

- [ ] **Step 3: Write the search controller**

Create `js/search.js`:

```javascript
// Search bar controller: debounced typeahead per input, fires onRoute when both pins are set.
//
// Public API:
//   const ctl = createSearch({ onRoute(from, to) });
//   ctl.setError(msg) / ctl.setStatus(msg) / ctl.reset()
//   ctl.previewPoint('from'|'to', {lon,lat,label}) — set externally (e.g., map click)

import { geocode } from "./geocode.js";

const DEBOUNCE_MS = 250;

export function createSearch({ onRoute }) {
  const fromEl = document.getElementById("from-input");
  const toEl = document.getElementById("to-input");
  const goBtn = document.getElementById("go-btn");
  const swapBtn = document.getElementById("swap-btn");
  const dropdown = document.getElementById("search-dropdown");
  const statusEl = document.getElementById("search-status");

  /** @type {{from: ?{lon:number,lat:number,label:string}, to: ?…}} */
  const pins = { from: null, to: null };
  let activeInput = null; // 'from' | 'to'
  let debounceTimer = null;
  let pendingAbort = null;

  function refreshGo() {
    goBtn.disabled = !(pins.from && pins.to);
  }
  function setStatus(msg) { statusEl.textContent = msg; statusEl.classList.remove("error"); }
  function setError(msg) { statusEl.textContent = msg; statusEl.classList.add("error"); }

  function hideDropdown() { dropdown.hidden = true; dropdown.innerHTML = ""; }
  function showResults(results) {
    if (!results.length) {
      dropdown.innerHTML = `<div class="search-result" style="color:var(--muted)">No matches</div>`;
      dropdown.hidden = false;
      return;
    }
    dropdown.innerHTML = results.map((r, i) =>
      `<div class="search-result" data-i="${i}">${escapeHtml(r.label)}</div>`
    ).join("");
    dropdown.hidden = false;
    dropdown.querySelectorAll(".search-result").forEach((el) => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const r = results[Number(el.dataset.i)];
        selectResult(r);
      });
    });
  }
  function selectResult(r) {
    if (!activeInput) return;
    pins[activeInput] = r;
    const el = activeInput === "from" ? fromEl : toEl;
    el.value = r.label;
    hideDropdown();
    refreshGo();
    setStatus("");
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);
  }

  async function queryFor(which, text) {
    activeInput = which;
    pins[which] = null;
    refreshGo();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (!text.trim()) { hideDropdown(); return; }
    debounceTimer = setTimeout(async () => {
      if (pendingAbort) pendingAbort.abort();
      const ctrl = new AbortController();
      pendingAbort = ctrl;
      try {
        const results = await geocode(text, ctrl.signal);
        if (ctrl.signal.aborted) return;
        showResults(results);
      } catch (e) {
        if (e.name === "AbortError") return;
        setError("Couldn't search right now — try again");
      }
    }, DEBOUNCE_MS);
  }

  fromEl.addEventListener("input", () => queryFor("from", fromEl.value));
  toEl.addEventListener("input", () => queryFor("to", toEl.value));
  fromEl.addEventListener("focus", () => { activeInput = "from"; });
  toEl.addEventListener("focus", () => { activeInput = "to"; });
  fromEl.addEventListener("blur", () => setTimeout(hideDropdown, 100));
  toEl.addEventListener("blur", () => setTimeout(hideDropdown, 100));

  swapBtn.addEventListener("click", () => {
    [pins.from, pins.to] = [pins.to, pins.from];
    [fromEl.value, toEl.value] = [toEl.value, fromEl.value];
    refreshGo();
  });
  goBtn.addEventListener("click", () => {
    if (pins.from && pins.to) onRoute(pins.from, pins.to);
  });
  [fromEl, toEl].forEach((el) =>
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && pins.from && pins.to) onRoute(pins.from, pins.to);
    })
  );

  return {
    setStatus, setError,
    reset() { pins.from = pins.to = null; fromEl.value = ""; toEl.value = ""; hideDropdown(); refreshGo(); setStatus(""); },
    previewPoint(which, r) {
      pins[which] = r;
      (which === "from" ? fromEl : toEl).value = r.label;
      refreshGo();
    },
  };
}
```

- [ ] **Step 4: Wire createSearch into index.html (temporary stub onRoute)**

In `index.html`, at the bottom of the existing `<script type="module">` (or add one if it isn't module-typed yet), add:

```javascript
import { createSearch } from "./js/search.js";

const search = createSearch({
  onRoute(from, to) {
    console.log("route from", from, "to", to);
    search.setStatus(`Routing ${from.label} → ${to.label}…`);
  },
});
```

If the existing `<script>` tag is **not** module-typed, change `<script>` to `<script type="module">` at the file's main script block. The existing code uses top-level `await` and `const`, both module-safe.

- [ ] **Step 5: Open in browser, smoke-test typeahead**

```bash
python3 scripts/serve.py
```

Open http://127.0.0.1:8000. Type "Times Square" into From. Expect dropdown with hits. Click a result. Repeat for To. "Go" enables.

If geocoder fails (no network in dev env), still verify: typing shows the dropdown error message "Couldn't search right now — try again".

- [ ] **Step 6: Commit**

```bash
git add js/search.js index.html
git commit -m "ui: search bar with Photon-backed typeahead, Go button"
```

---

## Task 13: Router glue (WASM lifecycle)

**Files:**
- Create: `js/router.js`

This module owns the WASM module + walk graph blob. Lazy-loads on first call. Provides `route({from, to})` that returns an `Itinerary` plain object.

- [ ] **Step 1: Write the module**

Create `js/router.js`:

```javascript
// WASM router lifecycle: lazy-load the engine + blob, expose a single route().
//
// First call to ensureReady() (typically deferred until the user hits Go)
// runs in parallel:
//   - dynamic import of ./pkg/nycm_router.js (built by wasm-pack)
//   - fetch of ./tiles/walk_graph.bin (or assembly from tiles/walk-graph.part-*)
// Resolves a Router instance retained on the module singleton.

let readyPromise = null;
let router = null; // wasm Router instance

async function loadWalkBlob() {
  // Try the assembled file first (local dev convenience).
  const assembled = await fetch("./tiles/walk_graph.bin");
  if (assembled.ok) return new Uint8Array(await assembled.arrayBuffer());

  // Fall back to assembling from chunks fetched in order. Browser cannot list
  // a directory, so we probe sequential .part-aa, .part-ab, … until 404.
  const chunks = [];
  for (let i = 0; ; i++) {
    const suffix = String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26));
    const res = await fetch(`./tiles/walk-graph.part-${suffix}`);
    if (!res.ok) break;
    chunks.push(new Uint8Array(await res.arrayBuffer()));
  }
  if (chunks.length === 0) throw new Error("walk_graph blob not found");
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

async function init() {
  const [wasm, blob] = await Promise.all([
    import("../pkg/nycm_router.js").then(async (m) => { await m.default(); return m; }),
    loadWalkBlob(),
  ]);
  router = new wasm.Router(blob);
}

export function ensureReady() {
  if (!readyPromise) readyPromise = init();
  return readyPromise;
}

export async function route({ from, to }) {
  await ensureReady();
  const req = {
    from: { lon: from.lon, lat: from.lat },
    to:   { lon: to.lon,   lat: to.lat   },
    depart: Math.floor(Date.now() / 1000),
    max_walk_m: 1500,
    max_transfers: 0,
  };
  return router.route(req);
}

/**
 * Inspect what kind of error came back from the WASM boundary.
 * Returns one of: "OriginOutOfBounds", "DestOutOfBounds", "NoPath",
 * "DepartureOutOfRange", "DataVersionMismatch", "MalformedData", or null.
 */
export function classifyError(err) {
  const msg = String(err?.message ?? err ?? "");
  for (const code of [
    "origin outside service area",
    "destination outside service area",
    "no path found",
    "departure time out of range",
    "router data version mismatch",
    "malformed router data",
  ]) {
    if (msg.includes(code)) return code;
  }
  return null;
}
```

- [ ] **Step 2: Commit**

```bash
git add js/router.js
git commit -m "ui: router.js — WASM lifecycle, chunk-fallback blob fetch, classifyError"
```

---

## Task 14: Render walking polyline + leg-summary card

**Files:**
- Create: `js/render.js`
- Modify: `index.html` (small CSS + a placeholder element for the summary card)

- [ ] **Step 1: Write the render module**

Create `js/render.js`:

```javascript
// Render a walking itinerary on the MapLibre map + show a summary card.

const SRC_ID = "route-walk-src";
const LAYER_ID = "route-walk-layer";

/**
 * @param {maplibregl.Map} map
 * @param {{legs: Array, depart: number, arrive: number, transfers: number}} itin
 */
export function renderItinerary(map, itin) {
  const features = itin.legs.flatMap(legToFeature);
  const fc = { type: "FeatureCollection", features };

  if (map.getSource(SRC_ID)) {
    map.getSource(SRC_ID).setData(fc);
  } else {
    map.addSource(SRC_ID, { type: "geojson", data: fc });
    map.addLayer({
      id: LAYER_ID,
      type: "line",
      source: SRC_ID,
      paint: {
        "line-color": "#264653",
        "line-width": 4,
        "line-dasharray": [2, 2],
        "line-opacity": 0.95,
      },
    });
  }

  // Fit bounds to the route, padded.
  const coords = features.flatMap((f) => f.geometry.coordinates);
  if (coords.length >= 2) {
    const lons = coords.map((c) => c[0]);
    const lats = coords.map((c) => c[1]);
    map.fitBounds(
      [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
      { padding: 60, duration: 600 }
    );
  }

  showSummary(itin);
}

export function clearItinerary(map) {
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
  if (map.getSource(SRC_ID)) map.removeSource(SRC_ID);
  hideSummary();
}

function legToFeature(leg) {
  if (leg.kind === "Walk") {
    return [{
      type: "Feature",
      properties: { kind: "Walk", seconds: leg.seconds, meters: leg.meters },
      geometry: {
        type: "LineString",
        coordinates: leg.polyline.map((p) => [p.lon, p.lat]),
      },
    }];
  }
  return [];
}

function summaryEl() {
  let el = document.getElementById("route-summary");
  if (!el) {
    el = document.createElement("div");
    el.id = "route-summary";
    el.className = "route-summary";
    document.body.appendChild(el);
  }
  return el;
}
function showSummary(itin) {
  const min = Math.round((itin.arrive - itin.depart) / 60);
  const meters = itin.legs.reduce((a, l) => a + (l.kind === "Walk" ? l.meters : 0), 0);
  const km = (meters / 1000).toFixed(1);
  const el = summaryEl();
  el.innerHTML = `
    <div class="summary-line">Walk ${min} min · ${km} km</div>
    <button class="summary-close" id="summary-close" title="Clear route">×</button>
  `;
  el.hidden = false;
  document.getElementById("summary-close").addEventListener("click", () => {
    el.dispatchEvent(new CustomEvent("dismiss", { bubbles: true }));
  });
}
function hideSummary() {
  const el = document.getElementById("route-summary");
  if (el) el.hidden = true;
}
```

- [ ] **Step 2: Add summary-card CSS**

In `index.html`'s `<style>`, append:

```css
.route-summary {
  position: absolute;
  bottom: 16px; left: 50%; transform: translateX(-50%);
  z-index: 1;
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px;
  background: var(--chip-bg);
  border: 1px solid var(--chip-border);
  border-radius: 12px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 24px rgba(15, 23, 42, 0.06);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  color: var(--ink);
  font-size: 13px; font-weight: 600;
}
.route-summary[hidden] { display: none; }
.summary-close {
  font: inherit; font-size: 14px; line-height: 1;
  width: 22px; height: 22px;
  border: 1px solid var(--chip-border);
  border-radius: 50%;
  background: transparent; color: var(--muted);
  cursor: pointer; padding: 0;
}
```

- [ ] **Step 3: Commit**

```bash
git add js/render.js index.html
git commit -m "ui: render walking polyline + summary card with min/km"
```

---

## Task 15: End-to-end wire-up

**Files:**
- Modify: `index.html` (replace the Task 12 stub onRoute with real router+render)

- [ ] **Step 1: Wire search → router → render**

Find the Task 12 stub at the bottom of `index.html`'s main module script:

```javascript
import { createSearch } from "./js/search.js";

const search = createSearch({
  onRoute(from, to) {
    console.log("route from", from, "to", to);
    search.setStatus(`Routing ${from.label} → ${to.label}…`);
  },
});
```

Replace it with:

```javascript
import { createSearch } from "./js/search.js";
import { route, classifyError, ensureReady } from "./js/router.js";
import { renderItinerary, clearItinerary } from "./js/render.js";

// `map` is the existing MapLibre Map instance — confirm its variable name matches.

const search = createSearch({
  async onRoute(from, to) {
    search.setStatus("Routing…");
    try {
      const itin = await route({ from, to });
      renderItinerary(map, itin);
      search.setStatus("");
    } catch (e) {
      const code = classifyError(e);
      if (code === "origin outside service area")
        search.setError("Origin is outside the service area (NYC + Long Island).");
      else if (code === "destination outside service area")
        search.setError("Destination is outside the service area.");
      else if (code === "no path found")
        search.setError("No walking route found between those points.");
      else
        search.setError("Routing failed. See console.");
      console.error(e);
    }
  },
});

// Pre-warm the WASM + blob fetch in the background after first user interaction
// (avoids a cold start when they hit Go).
let warmed = false;
function warmRouter() {
  if (warmed) return;
  warmed = true;
  ensureReady().catch((e) => console.warn("router pre-warm failed:", e));
}
document.getElementById("from-input").addEventListener("focus", warmRouter, { once: true });
document.getElementById("to-input").addEventListener("focus", warmRouter, { once: true });

document.addEventListener("dismiss", () => {
  clearItinerary(map);
  search.reset();
});
```

**Confirm the existing MapLibre variable is named `map`.** If it's named differently, rename the references in the snippet to match. Use Read on `index.html` to find the line that does `new maplibregl.Map(...)`.

- [ ] **Step 2: Manual smoke test in browser**

Pre-req: `tiles/walk_graph.bin` (or its `.part-*` chunks) and `pkg/` have been built locally. If you haven't yet built the WASM:

```bash
cd nycm-router && wasm-pack build --release --target web --out-dir ../pkg && cd ..
```

Then:

```bash
python3 scripts/serve.py
```

Open http://127.0.0.1:8000. Search "Union Square" → "Times Square". Hit Go. Expect:
- Brief "Routing…" status
- Dashed polyline on the map between the two points
- Summary card "Walk N min · X.Y km"
- × dismisses the route

Test out-of-bounds: search "Boston, MA" as one endpoint. Expect the "Outside service area" error.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "ui: wire search → WASM router → render, warm on input focus"
```

---

## Task 16: CI workflow extension

**Files:**
- Modify: `.github/workflows/pages.yml`

- [ ] **Step 1: Extend the workflow**

Replace the contents of `.github/workflows/pages.yml` with:

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Assemble PMTiles from chunks
        run: bash scripts/assemble-tiles.sh

      - name: Assemble walk_graph.bin from chunks
        run: bash scripts/assemble-walk-graph.sh

      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: wasm32-unknown-unknown

      - uses: jetli/wasm-pack-action@v0.4.0

      - name: Build WASM
        run: |
          cd nycm-router
          wasm-pack build --release --target web --out-dir ../pkg

      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: .

      - id: deployment
        uses: actions/deploy-pages@v4
```

Note: this **does not** rebuild `walk_graph.bin` from OSM on every deploy. It only assembles from committed chunks. Rebuilding from OSM happens via the weekly refresh workflow (deferred to Plan B's CI work, or a follow-up task). For now, the chunks are produced by `scripts/build-walk-graph.sh` run locally and committed.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/pages.yml
git commit -m "ci: assemble walk-graph chunks + build WASM in pages workflow"
```

---

## Task 17: WASM smoke test in CI

**Files:**
- Create: `tests/wasm/smoke.mjs`
- Create: `tests/wasm/package.json`
- Modify: `.github/workflows/pages.yml` (add test step before deploy)

- [ ] **Step 1: Write the smoke test**

Create `tests/wasm/package.json`:

```json
{
  "name": "nycm-router-smoke",
  "version": "0.0.0",
  "private": true,
  "type": "module"
}
```

Create `tests/wasm/smoke.mjs`:

```javascript
// Smoke test: load real basemap-sized walk graph + run pinned walking routes.
// Run: node tests/wasm/smoke.mjs
//
// Asserts only invariants — never exact times. Goal: catch the class of bug
// where unit tests pass but real data exposes a plumbing error.

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

const cases = [
  { name: "Union Sq → Times Sq",
    from: { lon: -73.9904, lat: 40.7359 }, to: { lon: -73.9857, lat: 40.7580 } },
  { name: "Battery Park → City Hall",
    from: { lon: -74.0150, lat: 40.7033 }, to: { lon: -74.0061, lat: 40.7128 } },
  { name: "Greenpoint → Williamsburg",
    from: { lon: -73.9498, lat: 40.7305 }, to: { lon: -73.9571, lat: 40.7081 } },
];

let failed = 0;
for (const c of cases) {
  try {
    const itin = router.route({
      from: c.from, to: c.to,
      depart: 0, max_walk_m: 5000, max_transfers: 0,
    });
    const ok =
      itin.legs.length === 1 &&
      itin.legs[0].kind === "Walk" &&
      itin.legs[0].seconds > 0 &&
      itin.arrive > itin.depart &&
      itin.transfers === 0;
    if (!ok) {
      console.error(`FAIL: ${c.name}`, itin);
      failed++;
    } else {
      console.log(`OK:   ${c.name} (${Math.round(itin.legs[0].seconds / 60)} min)`);
    }
  } catch (e) {
    console.error(`FAIL: ${c.name} threw`, e);
    failed++;
  }
}
process.exit(failed > 0 ? 1 : 0);
```

- [ ] **Step 2: Run locally**

```bash
node tests/wasm/smoke.mjs
```

Expected: 3 OK lines, exit 0.

- [ ] **Step 3: Add the CI step**

In `.github/workflows/pages.yml`, insert this step between "Build WASM" and "actions/configure-pages@v5":

```yaml
      - name: WASM smoke test
        run: node tests/wasm/smoke.mjs
```

- [ ] **Step 4: Commit**

```bash
git add tests/wasm/ .github/workflows/pages.yml
git commit -m "ci: WASM smoke test against real walk graph"
```

---

## Task 18: Open the PR

**Files:** none — git operation only.

- [ ] **Step 1: Create the implementation branch off the spec branch and push**

The spec is on `feat/routing-search-spec`. Branch the implementation off it so the PR shows both the spec doc and the implementation in one diff (Plan A is the first thing implementing the spec):

```bash
# If still on feat/routing-search-spec and all Plan A commits are stacked on top, just push:
git push -u origin feat/routing-search-spec
```

Verify with `git log --oneline main..HEAD` — should show the spec commit at the base and the Plan A task commits on top. If the user prefers a separate branch for implementation, cut it now from the current HEAD:

```bash
git checkout -b feat/walking-router && git push -u origin feat/walking-router
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "Walking router + search bar (Plan A)" --body "$(cat <<'EOF'
## Summary
- Adds an in-browser Rust→WASM walking router (`nycm-router/`)
- Search bar with Photon geocoding (`js/search.js`, `js/geocode.js`)
- OSM PBF → `walk_graph.bin` pipeline (`pipelines/walk_graph.py`)
- Map rendering + summary card for walking routes
- CI builds WASM, assembles chunks, runs smoke test

## Test plan
- [ ] `cd nycm-router && cargo test` — all units + goldens pass
- [ ] `cd pipelines && uv run pytest` — pipeline round-trips pass
- [ ] `python3 scripts/serve.py` then open the site — search Union Sq → Times Sq, route renders
- [ ] Out-of-bounds origin shows "Outside service area"
- [ ] CI green on this PR

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Spec coverage check

| Spec requirement | Task(s) |
|---|---|
| WASM crate `nycm-router` | 1, 6 |
| `RouteRequest` / `Itinerary` / `Leg` types | 2 |
| Schema-version magic on blobs | 4 |
| Walking graph (CSR + snap index) | 3 |
| A* walking router | 5 |
| Public `Router::new` / `route()` API | 6 |
| Walk-only goldens (Layer 2 testing) | 8 |
| WASM smoke test (Layer 3) | 17 |
| OSM PBF → walk_graph.bin pipeline | 9 |
| `build-walk-graph.sh` (NY+CT+NJ merge + bbox clip) | 10 |
| Chunked walk graph (`.part-*`) | 10 |
| Photon geocoder client | 11 |
| Search bar UI | 12 |
| Router JS lifecycle | 13 |
| Render polyline + leg-summary | 14 |
| End-to-end wiring | 15 |
| CI: WASM build + chunk assembly | 16 |
| Error UI (out-of-bounds, no-path) | 15 |
| Walking speed 1.35 m/s | 5 (in `walk.rs`), 9 (in `walk_graph.py`) |
| BASEMAP_BBOX as single source of truth | 1 (`scripts/bbox.env`) |

**Deferred from spec to Plan B:**
- All transit (GTFS pipelines, RAPTOR, transfer table)
- Multimodal stitching
- Local stops index (`data/search-stops.json`)
- Weekly `refresh-data.yml` workflow
- Douglas-Peucker simplification on walk legs (only matters when walking legs are long — punt to when measured payloads warrant it)
