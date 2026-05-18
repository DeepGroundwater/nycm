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
