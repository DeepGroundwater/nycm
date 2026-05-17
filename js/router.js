// WASM router lifecycle: lazy-load the engine + blob, expose a single route().
//
// First call to ensureReady() (typically deferred until the user hits Go)
// runs in parallel:
//   - dynamic import of ./pkg/nycm_router.js (built by wasm-pack)
//   - fetch of ./tiles/walk_graph.bin (or assembly from tiles/walk-graph.part-*)
// Resolves a Router instance retained on the module singleton.

let readyPromise = null;
let router = null; // wasm Router instance

async function loadWalkBlob() {
  // Try the assembled file first (local dev convenience).
  const assembled = await fetch("./tiles/walk_graph.bin");
  if (assembled.ok) return new Uint8Array(await assembled.arrayBuffer());

  // Fall back to assembling from chunks fetched in order. Browser cannot list
  // a directory, so we probe sequential .part-aa, .part-ab, … until 404.
  const chunks = [];
  for (let i = 0; ; i++) {
    const suffix = String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26));
    const res = await fetch(`./tiles/walk-graph.part-${suffix}`);
    if (!res.ok) break;
    chunks.push(new Uint8Array(await res.arrayBuffer()));
  }
  if (chunks.length === 0) throw new Error("walk_graph blob not found");
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

async function init() {
  const [wasm, blob] = await Promise.all([
    import("../pkg/nycm_router.js").then(async (m) => { await m.default(); return m; }),
    loadWalkBlob(),
  ]);
  router = new wasm.Router(blob);
}

export function ensureReady() {
  if (!readyPromise) readyPromise = init();
  return readyPromise;
}

export async function route({ from, to }) {
  await ensureReady();
  const req = {
    from: { lon: from.lon, lat: from.lat },
    to:   { lon: to.lon,   lat: to.lat   },
    depart: Math.floor(Date.now() / 1000),
    max_walk_m: 1500,
    max_transfers: 0,
  };
  return router.route(req);
}

/**
 * Inspect what kind of error came back from the WASM boundary.
 * Returns one of: "OriginOutOfBounds", "DestOutOfBounds", "NoPath",
 * "DepartureOutOfRange", "DataVersionMismatch", "MalformedData", or null.
 */
export function classifyError(err) {
  const msg = String(err?.message ?? err ?? "");
  for (const code of [
    "origin outside service area",
    "destination outside service area",
    "no path found",
    "departure time out of range",
    "router data version mismatch",
    "malformed router data",
  ]) {
    if (msg.includes(code)) return code;
  }
  return null;
}
