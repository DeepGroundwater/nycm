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
