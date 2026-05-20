// US Census Bureau geocoder. Free, keyless, no rate limit on the
// `Public_AR_Current` benchmark. One-shot address resolution — no typeahead
// endpoint exists; debounce upstream in search-merge.

const CENSUS_URL =
  "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
const KEEP_STATES = new Set(["NY", "NJ", "CT"]);

// If the user's query lacks a state hint, Census can't disambiguate (e.g.
// "485 W Valley Stream Blvd" alone returns 0 matches; with ", NY" it resolves).
// We retry the basemap states in priority order until one matches.
const STATE_RETRY = ["NY", "NJ", "CT"];
const STATE_HINT_RE = /\b(NY|NJ|CT|New\s*York|New\s*Jersey|Connecticut)\b/i;

/**
 * Returns true when the query starts with digits followed by whitespace and
 * at least one more word — the only shape Census can resolve.
 * @param {string} q
 */
export function isAddressLike(q) {
  return /^\d+\s+\S/.test(q || "");
}

/** @typedef {{ lon: number, lat: number, label: string, source: "census" }} GeocodeResult */

async function fetchCensus(addressQuery, signal) {
  const url = new URL(CENSUS_URL);
  url.searchParams.set("address", addressQuery);
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

/**
 * @param {string} query
 * @param {AbortSignal} [signal]
 * @returns {Promise<GeocodeResult[]>}
 */
export async function geocodeAddress(query, signal) {
  const q = (query || "").trim();
  if (!q) return [];

  // First try the literal query.
  const direct = await fetchCensus(q, signal);
  if (direct.length > 0) return direct;

  // If the user already supplied a state, give up — adding another would
  // conflict.
  if (STATE_HINT_RE.test(q)) return [];

  // Retry with each basemap state appended. Stop at first hit so we don't
  // burn extra requests when NY resolves.
  for (const st of STATE_RETRY) {
    const hits = await fetchCensus(`${q}, ${st}`, signal);
    if (hits.length > 0) return hits;
  }
  return [];
}
