// Photon geocoder client. Returns up to 5 results biased toward the basemap area.
// Caller is responsible for debouncing.

const PHOTON_URL = "https://photon.komoot.io/api/";

// Lower-right + upper-left corners of the basemap (matches scripts/bbox.env).
// Used to bias Photon's ranking; not a hard filter.
const BIAS_LON = -73.5;
const BIAS_LAT = 40.7;

/** @typedef {{ lon: number, lat: number, label: string }} GeocodeResult */

/**
 * @param {string} query
 * @param {AbortSignal} [signal]
 * @returns {Promise<GeocodeResult[]>}
 */
export async function geocode(query, signal) {
  const q = query.trim();
  if (!q) return [];
  const url = new URL(PHOTON_URL);
  url.searchParams.set("q", q);
  url.searchParams.set("limit", "5");
  url.searchParams.set("lon", String(BIAS_LON));
  url.searchParams.set("lat", String(BIAS_LAT));
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`photon ${res.status}`);
  const json = await res.json();
  return json.features.map(featureToResult).filter(Boolean);
}

function featureToResult(f) {
  const [lon, lat] = f.geometry?.coordinates || [];
  if (typeof lon !== "number" || typeof lat !== "number") return null;
  const p = f.properties || {};
  const label = [p.name, p.street, p.city, p.state]
    .filter(Boolean).join(", ");
  return { lon, lat, label: label || `${lat.toFixed(4)}, ${lon.toFixed(4)}` };
}
