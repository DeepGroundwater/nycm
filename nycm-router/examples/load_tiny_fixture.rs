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
