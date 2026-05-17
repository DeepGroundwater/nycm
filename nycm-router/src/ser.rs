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
    let graph: WalkGraph = bincode::deserialize(&bytes[8..])
        .map_err(|e| RouteError::MalformedData(e.to_string()))?;

    // CSR invariant 1: adj must have exactly nodes.len() + 1 entries.
    if graph.adj.len() != graph.nodes.len() + 1 {
        return Err(RouteError::MalformedData(format!(
            "adj.len() ({}) != nodes.len() + 1 ({})",
            graph.adj.len(),
            graph.nodes.len() + 1,
        )));
    }
    // CSR invariant 2: cell_offsets must have exactly cols * rows + 1 entries.
    let expected_offsets = (graph.snap.cols * graph.snap.rows + 1) as usize;
    if graph.snap.cell_offsets.len() != expected_offsets {
        return Err(RouteError::MalformedData(format!(
            "cell_offsets.len() ({}) != cols*rows+1 ({})",
            graph.snap.cell_offsets.len(),
            expected_offsets,
        )));
    }

    Ok(graph)
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

    /// A graph with adj = vec![] — violates adj.len() == nodes.len() + 1.
    fn bad_graph() -> WalkGraph {
        WalkGraph {
            nodes: vec![], adj: vec![], edges: vec![], polylines: vec![],
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

    #[test]
    fn rejects_malformed_csr() {
        // bad_graph() has adj = vec![] which violates adj.len() == nodes.len() + 1
        // (0 != 0 + 1). save_walk_graph writes it verbatim; load_walk_graph must
        // catch it after deserialization.
        let bytes = save_walk_graph(&bad_graph());
        match load_walk_graph(&bytes) {
            Err(RouteError::MalformedData(_)) => {}
            other => panic!("expected MalformedData, got {other:?}"),
        }
    }
}
