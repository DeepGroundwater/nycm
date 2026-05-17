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
