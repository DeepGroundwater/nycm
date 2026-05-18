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
        debug_assert!(self.f.is_finite() && o.f.is_finite(), "Frontier::f must be finite");
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
        debug_assert_ne!(came_from[cur as usize], u32::MAX,
            "reconstruct_polyline: came_from chain broken at node {cur}");
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
