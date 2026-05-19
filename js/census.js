// US Census Bureau geocoder. Free, keyless, no rate limit on the
// `Public_AR_Current` benchmark. One-shot address resolution — no typeahead
// endpoint exists; debounce upstream in search-merge.

const CENSUS_URL =
  "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
const KEEP_STATES = new Set(["NY", "NJ", "CT"]);

/**
 * Returns true when the query starts with digits followed by whitespace and
 * at least one more word — the only shape Census can resolve.
 * @param {string} q
 */
export function isAddressLike(q) {
  return /^\d+\s+\S/.test(q || "");
}

/** @typedef {{ lon: number, lat: number, label: string, source: "census" }} GeocodeResult */

/**
 * @param {string} query
 * @param {AbortSignal} [signal]
 * @returns {Promise<GeocodeResult[]>}
 */
export async function geocodeAddress(query, signal) {
  const q = (query || "").trim();
  if (!q) return [];
  const url = new URL(CENSUS_URL);
  url.searchParams.set("address", q);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("format", "json");

  let res;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    return [];
  }
  if (!res.ok) return [];

  let json;
  try { json = await res.json(); } catch { return []; }
  const matches = json?.result?.addressMatches;
  if (!Array.isArray(matches)) return [];

  const out = [];
  for (const m of matches) {
    const state = m?.addressComponents?.state;
    if (!KEEP_STATES.has(state)) continue;
    const x = m?.coordinates?.x;
    const y = m?.coordinates?.y;
    if (typeof x !== "number" || typeof y !== "number") continue;
    out.push({
      lon: x,
      lat: y,
      label: m.matchedAddress || `${y.toFixed(4)}, ${x.toFixed(4)}`,
      source: "census",
    });
  }
  return out;
}
