// POI binary decoder + in-memory token/category indexes for the search bar.
// Lazy-load on first search keystroke. Mirrors js/router.js's chunk-fallback
// pattern for tiles/pois.part-*.

import { normalize } from "./tokenize.js";

const MAGIC = "POI1";
const HEADER_SIZE = 24;
const RECORD_SIZE = 20;

/**
 * @typedef {{ lon:number, lat:number, walkNode:number, category:number, name:string, flags:number }} Poi
 */

/**
 * Decode the binary into a queryable view. Throws on bad magic. Does NOT
 * build the search index — that's done lazily by the module-level ensureReady.
 * @param {Uint8Array} bytes
 */
export function decodePoiBlob(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder("utf-8");

  const magic = dec.decode(bytes.subarray(0, 4));
  if (magic !== MAGIC) throw new Error(`bad magic: ${magic}`);
  const version = dv.getUint32(4, true);
  const walkGraphVersion = dv.getUint32(8, true);
  const nPois = dv.getUint32(12, true);
  const namesOff = dv.getUint32(16, true);

  function byId(i) {
    if (i < 0 || i >= nPois) throw new RangeError(`poi_id ${i} out of range`);
    const o = HEADER_SIZE + i * RECORD_SIZE;
    const lon = dv.getInt32(o, true) / 1e7;
    const lat = dv.getInt32(o + 4, true) / 1e7;
    const walkNode = dv.getUint32(o + 8, true);
    const nameOff = dv.getUint32(o + 12, true);
    const nameLen = dv.getUint16(o + 16, true);
    const category = dv.getUint8(o + 18);
    const flags = dv.getUint8(o + 19);
    const name = nameLen
      ? dec.decode(bytes.subarray(namesOff + nameOff, namesOff + nameOff + nameLen))
      : "";
    return { lon, lat, walkNode, category, name, flags };
  }

  return { version, walkGraphVersion, nPois, byId };
}

// ---- runtime singleton ---------------------------------------------------

let readyPromise = null;
let indexState = null;

async function loadBlob() {
  const direct = await fetch("./tiles/pois.bin");
  if (direct.ok) return new Uint8Array(await direct.arrayBuffer());
  const chunks = [];
  for (let i = 0; ; i++) {
    const suffix = String.fromCharCode(97 + Math.floor(i / 26)) +
                   String.fromCharCode(97 + (i % 26));
    const res = await fetch(`./tiles/pois.part-${suffix}`);
    if (!res.ok) break;
    chunks.push(new Uint8Array(await res.arrayBuffer()));
  }
  if (chunks.length === 0) throw new Error("pois.bin not found");
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

async function buildIndex() {
  const blob = await loadBlob();
  const decoded = decodePoiBlob(blob);

  // Token posting lists: token → number[] (built first, then frozen to Uint32Array).
  const postingsBuilder = new Map();
  // Category index: category → number[].
  const categoryBuilder = new Map();

  for (let i = 0; i < decoded.nPois; i++) {
    const p = decoded.byId(i);
    if (!categoryBuilder.has(p.category)) categoryBuilder.set(p.category, []);
    categoryBuilder.get(p.category).push(i);
    const toks = normalize(p.name);
    for (const t of toks) {
      let arr = postingsBuilder.get(t);
      if (!arr) { arr = []; postingsBuilder.set(t, arr); }
      arr.push(i);
    }
  }

  // Freeze postings into Uint32Array for faster iteration.
  // Vocabulary sorted for prefix expansion via binary search.
  const postings = new Map();
  for (const [tok, arr] of postingsBuilder) {
    postings.set(tok, new Uint32Array(arr));
  }
  const sortedTokens = [...postings.keys()].sort();
  const byCategoryArr = new Map();
  for (const [cat, arr] of categoryBuilder) {
    byCategoryArr.set(cat, new Uint32Array(arr));
  }
  return { decoded, postings, sortedTokens, byCategoryArr };
}

export function ensureReady() {
  if (!readyPromise) {
    readyPromise = buildIndex().then((s) => { indexState = s; return s; });
  }
  return readyPromise;
}

/** Test-only: drop singleton state so a fresh fake fetch works. */
export function __resetForTests() {
  readyPromise = null;
  indexState = null;
}

// ---- search --------------------------------------------------------------

/**
 * @param {string} q
 * @param {number} [k]
 * @returns {Promise<Array<{
 *   lon:number, lat:number, label:string, score:number,
 *   source:"local", poiId:number, category:number, walkNode:number
 * }>>}
 */
export async function search(q, k = 8) {
  const tokens = normalize(q);
  if (tokens.length === 0) return [];
  await ensureReady();

  const last = tokens[tokens.length - 1];
  const rest = tokens.slice(0, -1);

  // Exact-match posting lists for non-last tokens. Empty Uint32Array if missing.
  const EMPTY = new Uint32Array();
  const exactLists = rest.map((t) => indexState.postings.get(t) || EMPTY);

  // Prefix expansion for the last token: range in sortedTokens [last, last+"￿").
  const lo = lowerBound(indexState.sortedTokens, last);
  const hi = lowerBound(indexState.sortedTokens, last + "￾");
  const prefixIds = new Set();
  for (let i = lo; i < hi; i++) {
    const arr = indexState.postings.get(indexState.sortedTokens[i]);
    if (arr) for (const id of arr) prefixIds.add(id);
  }

  // Intersect: start from the smallest list, then filter.
  let candidates;
  if (exactLists.length === 0) {
    candidates = prefixIds;
  } else {
    let smallest = exactLists[0];
    for (const l of exactLists) if (l.length < smallest.length) smallest = l;
    candidates = new Set();
    for (const id of smallest) {
      if (prefixIds.has(id)) candidates.add(id);
    }
    for (const list of exactLists) {
      if (list === smallest) continue;
      const s = new Set(list);
      const next = new Set();
      for (const id of candidates) if (s.has(id)) next.add(id);
      candidates = next;
    }
  }

  const out = [];
  for (const id of candidates) {
    const p = indexState.decoded.byId(id);
    const score = scoreLocal(tokens, p);
    out.push({
      lon: p.lon, lat: p.lat, label: p.name,
      score, source: "local",
      poiId: id, category: p.category, walkNode: p.walkNode,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, k);
}

export async function byId(id) {
  await ensureReady();
  return indexState.decoded.byId(id);
}

/** Returns a `Uint32Array` of POI ids in the given category code (1..10). */
export async function byCategory(cat) {
  await ensureReady();
  return indexState.byCategoryArr.get(cat) || new Uint32Array();
}

// ---- scoring + helpers ---------------------------------------------------

const CATEGORY_BOOST = new Map([[2, 15], [3, 8], [5, 5]]); // transit/park/attraction

function scoreLocal(queryTokens, poi) {
  const nameTokens = normalize(poi.name);
  let nameMatch;
  if (nameTokens.length === queryTokens.length &&
      nameTokens.every((t, i) => t === queryTokens[i])) {
    nameMatch = 100;
  } else if (queryTokens.every((t) => nameTokens.includes(t))) {
    nameMatch = 80;
  } else {
    nameMatch = 60;
  }
  const categoryBoost = CATEGORY_BOOST.get(poi.category) || 0;
  const lengthPenalty = Math.log2(Math.max(1, nameTokens.length));
  return nameMatch + categoryBoost - lengthPenalty;
}

function lowerBound(arr, target) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}
