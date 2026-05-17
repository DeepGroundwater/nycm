//! Public error type. Crosses the WASM boundary via `Display`.

use thiserror::Error;

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

// `wasm_bindgen` provides `impl<E: StdError> From<E> for JsError` as a blanket,
// so an explicit impl here would conflict (E0119). The blanket covers RouteError
// since `thiserror` derives `std::error::Error` for it.
