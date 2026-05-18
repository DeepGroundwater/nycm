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
