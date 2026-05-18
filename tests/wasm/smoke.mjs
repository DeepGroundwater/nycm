// Smoke test: load real basemap-sized walk graph + run pinned walking routes.
// Run: node tests/wasm/smoke.mjs
//
// Asserts only invariants — never exact times. Goal: catch the class of bug
// where unit tests pass but real data exposes a plumbing error.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../..");

const wasmMod = await import(path.join(REPO, "pkg/nycm_router.js"));
const wasmBytes = await fs.readFile(path.join(REPO, "pkg/nycm_router_bg.wasm"));
await wasmMod.default(wasmBytes);

const walkBytes = await fs.readFile(path.join(REPO, "tiles/walk_graph.bin"));
const router = new wasmMod.Router(walkBytes);

// Coordinates pinned to street-adjacent points, NOT the centers of parks/plazas
// (OSM tags some park-internal paths as separate components from the street network).
const cases = [
  { name: "14th & Park → Times Sq (Broadway)",
    from: { lon: -73.9879, lat: 40.7363 }, to: { lon: -73.9871, lat: 40.7589 } },
  { name: "Battery Park → City Hall",
    from: { lon: -74.0150, lat: 40.7033 }, to: { lon: -74.0061, lat: 40.7128 } },
  { name: "Greenpoint → Williamsburg",
    from: { lon: -73.9498, lat: 40.7305 }, to: { lon: -73.9571, lat: 40.7081 } },
];

let failed = 0;
for (const c of cases) {
  try {
    const itin = router.route({
      from: c.from, to: c.to,
      depart: 0, max_walk_m: 5000, max_transfers: 0,
    });
    const ok =
      itin.legs.length === 1 &&
      itin.legs[0].kind === "Walk" &&
      itin.legs[0].seconds > 0 &&
      itin.arrive > itin.depart &&
      itin.transfers === 0;
    if (!ok) {
      console.error(`FAIL: ${c.name}`, itin);
      failed++;
    } else {
      console.log(`OK:   ${c.name} (${Math.round(itin.legs[0].seconds / 60)} min)`);
    }
  } catch (e) {
    console.error(`FAIL: ${c.name} threw`, e);
    failed++;
  }
}
process.exit(failed > 0 ? 1 : 0);
