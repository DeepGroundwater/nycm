//! Walking graph: CSR adjacency + flat-grid snap index.

use serde::{Deserialize, Serialize};

use crate::types::LonLat;

/// One outgoing edge.
#[derive(Copy, Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WalkEdge {
    pub to: u32,
    /// Travel time in seconds at the canonical walking speed (1.35 m/s).
    pub seconds: u32,
    /// Half-open index range `[poly_start, poly_end)` into `WalkGraph::polylines`.
    /// When `poly_start == poly_end` the edge has no interior points (straight line).
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
