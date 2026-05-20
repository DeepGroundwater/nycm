// Orchestrates search lanes. PR 1 wires Photon + Census; PR 3 adds the local
// POI lane; PR 5 adds the discovery lane.

import { geocode as defaultPhoton } from "./geocode.js";
import { geocodeAddress as defaultCensus, isAddressLike } from "./census.js";
import { search as defaultLocal } from "./poi-index.js";

/**
 * Snap a (lon, lat) to a ~50 m grid bucket key. At 40°N:
 *   - 0.0005 deg lat ≈ 55.6 m
 *   - 0.0005 deg lon ≈ 42.5 m
 */
function gridKey(lon, lat) {
  const lo = Math.floor(lon / 0.0005);
  const la = Math.floor(lat / 0.0005);
  return `${lo}:${la}`;
}

/**
 * Keep the highest baseScore per 50 m bucket.
 * @template {{lon:number, lat:number, baseScore:number}} T
 * @param {T[]} items
 * @returns {T[]}
 */
export function dedupBy50mGrid(items) {
  const best = new Map();
  for (const it of items) {
    const k = gridKey(it.lon, it.lat);
    const prev = best.get(k);
    if (!prev || it.baseScore > prev.baseScore) best.set(k, it);
  }
  return [...best.values()];
}

function proximityMeters(a, biasLL) {
  if (!biasLL) return 0;
  const dx = (a.lon - biasLL.lon) * 85_000;
  const dy = (a.lat - biasLL.lat) * 111_000;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Sort by baseScore desc, ties broken by inverse great-circle distance.
 */
export function mergeRank(items, biasLL) {
  const deduped = dedupBy50mGrid(items);
  deduped.sort((a, b) =>
    (b.baseScore - a.baseScore) ||
    (proximityMeters(a, biasLL) - proximityMeters(b, biasLL))
  );
  return deduped;
}

/**
 * Main entry. Three lanes: local POI, Photon, US Census.
 * @param {string} query
 * @param {AbortSignal} signal
 * @param {{lon:number,lat:number}|null} _pinnedDest  reserved for PR 5 (discovery)
 * @param {{lon:number,lat:number}} biasLL
 * @param {number} [k]
 * @param {{
 *   local?: (q:string, k:number) => Promise<any[]>,
 *   photon?: (q:string, signal:AbortSignal) => Promise<any[]>,
 *   census?: (q:string, signal:AbortSignal) => Promise<any[]>,
 * }} [overrides]   for tests
 */
export async function searchMerge(query, signal, _pinnedDest, biasLL, k = 8, overrides = {}) {
  const localFn    = overrides.local   || defaultLocal;
  const photonFn   = overrides.photon  || defaultPhoton;
  const censusFn   = overrides.census  || defaultCensus;

  const localP  = localFn(query, k).catch(() => []);
  const photonP = photonFn(query, signal).catch(() => []);
  const censusP = isAddressLike(query) ? censusFn(query, signal).catch(() => []) : Promise.resolve([]);
  const [localHits, photonHits, censusHits] = await Promise.all([localP, photonP, censusP]);

  const all = [
    ...localHits.map((r) => ({ ...r, baseScore: r.score })),
    ...censusHits.map((r) => ({ ...r, baseScore: 78 })),
    ...photonHits.map((r, i) => ({ ...r, baseScore: Math.max(30, 62 - i * 4), source: r.source ?? "photon" })),
  ];
  return mergeRank(all, biasLL).slice(0, k);
}
