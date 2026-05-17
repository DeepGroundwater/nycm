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
