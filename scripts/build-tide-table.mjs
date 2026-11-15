#!/usr/bin/env node
// Build a self-contained tide-prediction table for one NOAA harmonic station,
// or (with --bbox) for every NOAA tide station in an area.
//
//   npm install --no-save @neaps/tide-predictor
//   node scripts/build-tide-table.mjs 8516663 data/long-beach-tide.json --msl-navd88=-0.073 \
//        --msl-navd88-source="Sandy Hook 8531680, this station's control station"
//   node scripts/build-tide-table.mjs --bbox=-73.78,40.53,-73.41,40.93 data/nassau-tides.json \
//        --name="Nassau County, NY"
//
// NOAA predicts tides as a sum of cosines, one per harmonic constituent:
//
//   h(t) = sum_i  f_i(year) * A_i * cos( speed_i * hours_since_Jan_1 + (V0+u)_i(year) - phase_i )
//
// A_i, phase_i and speed_i are fixed for the station and come from NOAA's API.
// f (node factor) and V0+u (equilibrium argument) drift slowly with the moon's
// 18.6-year cycle; NOAA evaluates them once per year. This script tabulates
// them for a span of years so the browser needs no astronomy at all — see
// js/tide.js. @neaps/tide-predictor (MIT) supplies the astronomy.
//
// The output is heights above the station's MEAN SEA LEVEL (1983-2001 epoch).
// `msl_navd88_m` converts to NAVD88; pass it explicitly when NOAA publishes no
// NAVD88 tie for the station.
//
// Area mode also lists SUBORDINATE stations. NOAA has no harmonics for those;
// it predicts them from a reference station's high and low waters, shifted in
// time and scaled in height. The offsets are copied through, and the reference
// stations' tables are included even when they lie outside the area.
import { writeFileSync } from "node:fs";
import { constituents, astro } from "@neaps/tide-predictor";

const ROOT = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi";
const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith("--"));
const opt = Object.fromEntries(args.filter(a => a.startsWith("--")).map(a => { const i = a.indexOf("="); return [a.slice(2, i < 0 ? undefined : i), i < 0 ? "" : a.slice(i + 1)]; }));
const FROM = Number(opt.from ?? 2020), TO = Number(opt.to ?? 2045);

async function get(path) {
  const r = await fetch(`${ROOT}${path}`);
  if (!r.ok) throw new Error(`${r.status} ${ROOT}${path}`);
  return r.json();
}
const norm = deg => ((deg % 360) + 360) % 360;
const RAD = Math.PI / 180;

// NOAA's convention differs from the library's for two small constituents.
// Found by comparing against NOAA's own predictions at Kings Point, Bridgeport
// and Sandy Hook over 2024-2036: with these two definitions the disagreement
// falls from about 13 mm RMS to about 1 mm.
//   M3: NOAA's argument is 3(T - s + h); the library's carries an extra 180 deg.
//   M1: NOAA follows Schureman: V = T - s + h - 90 deg, u = xi - nu + Q,
//       f = f(O1) * sqrt(0.25 + 1.5 cos I cos 2P / cos^2(I/2) + 2.25 cos^2 I / cos^4(I/2)),
//       with P = p - xi and tan Q = (5 cos I - 1) / (7 cos I + 1) * tan P.
const NOAA_CONVENTION = {
  M3(k, start, mid) {
    const c = k.correction(mid);
    return { f: c.f, vu: k.value(start) + c.u + 180 };
  },
  M1(_k, start, mid) {
    const I = mid.I.value * RAD, P = (mid.p.value - mid.xi.value) * RAD;
    const fO1 = Math.sin(I) * Math.cos(I / 2) ** 2 / 0.38;
    const f = fO1 * Math.sqrt(0.25 + 1.5 * Math.cos(I) * Math.cos(2 * P) / Math.cos(I / 2) ** 2 + 2.25 * Math.cos(I) ** 2 / Math.cos(I / 2) ** 4);
    const Q = Math.atan2((5 * Math.cos(I) - 1) * Math.sin(P), (7 * Math.cos(I) + 1) * Math.cos(P)) / RAD;
    return { f, vu: start["T+h-s"].value - 90 + mid.xi.value - mid.nu.value + Q };
  },
};

/** Harmonic table for one station: constituents, yearly f and V0+u, datums above MSL. */
async function buildTable(station, { mslNavd = null, mslNavdSource = null, requireNavd = false } = {}) {
  const [meta, harcon, datums] = await Promise.all([
    get(`/stations/${station}.json`), get(`/stations/${station}/harcon.json?units=metric`), get(`/stations/${station}/datums.json?units=metric`),
  ]);
  const st = meta.stations[0];
  const used = (harcon.HarmonicConstituents ?? []).filter(c => c.amplitude > 0);
  if (!used.length) throw new Error(`station ${station} has no harmonic constituents`);
  const unknown = used.filter(c => !constituents[c.name]).map(c => c.name);
  if (unknown.length) throw new Error(`${station}: constituents without astronomy: ${unknown.join(", ")}`);

  const years = {};
  for (let y = FROM; y <= TO; y++) {
    const start = astro(new Date(Date.UTC(y, 0, 1)));
    const mid = astro(new Date(Date.UTC(y, 6, 2, 12)));          // NOAA uses mid-year node factors
    const f = [], vu = [];
    for (const c of used) {
      const k = constituents[c.name];
      let row = NOAA_CONVENTION[c.name]?.(k, start, mid);
      if (!row) { const corr = k.correction(mid); row = { f: corr.f, vu: k.value(start) + corr.u }; }
      f.push(Number(row.f.toFixed(5)));
      vu.push(Number(norm(row.vu).toFixed(3)));
    }
    years[y] = { f, vu };
  }

  const level = Object.fromEntries((datums.datums ?? []).map(d => [d.name, d.value]));
  const aboveMsl = v => (v == null || level.MSL == null ? null : Number((v - level.MSL).toFixed(3)));
  if (mslNavd == null && level.NAVD88 != null && level.MSL != null) {
    mslNavd = Number((level.MSL - level.NAVD88).toFixed(3));
    mslNavdSource = "NOAA datums for this station";
  }
  if (mslNavd == null && requireNavd) throw new Error("NOAA has no NAVD88 tie for this station: pass --msl-navd88=<metres>");

  return {
    station, name: st.name, lat: st.lat, lng: st.lng,
    source: `NOAA CO-OPS harmonic constituents, station ${station}`,
    note: used[0]?.comments ?? "",
    units: "m", reference: "station MSL, 1983-2001 epoch",
    msl_navd88_m: mslNavd, msl_navd88_source: mslNavdSource,
    // Tidal datums in metres above MSL.
    datums: {
      MHHW: aboveMsl(level.MHHW), MHW: aboveMsl(level.MHW), MLW: aboveMsl(level.MLW), MLLW: aboveMsl(level.MLLW),
      HAT: aboveMsl(datums.HAT), LAT: aboveMsl(datums.LAT),
    },
    constituents: used.map(c => ({ name: c.name, amp: c.amplitude, phase: c.phase_GMT, speed: c.speed })),
    years,
  };
}

if (opt.bbox != null) {
  // ---- Area mode ------------------------------------------------------------
  const [out] = positional;
  if (!out) usage();
  const [w, s, e, n] = opt.bbox.split(",").map(Number);
  const all = (await get("/stations.json?type=tidepredictions&units=metric")).stations;
  const inside = all.filter(st => st.lng >= w && st.lng <= e && st.lat >= s && st.lat <= n)
    .sort((a, b) => b.lat - a.lat || a.lng - b.lng);
  const stations = [], tables = {};
  const need = new Set();
  for (const st of inside) {
    const base = { id: st.id, name: st.name, lat: Number(st.lat.toFixed(5)), lng: Number(st.lng.toFixed(5)) };
    if (st.type === "R") { stations.push({ ...base, kind: "harmonic" }); need.add(st.id); continue; }
    const o = await get(`/stations/${st.id}/tidepredoffsets.json`);
    // heightAdjustedType: "R" = multiply the reference height (above MLLW) by the
    // offset; "F" = add it (NOAA gives fixed offsets in feet).
    stations.push({
      ...base, kind: "subordinate", ref: o.refStationId, height: o.heightAdjustedType === "R" ? "ratio" : "fixed_ft",
      high: { minutes: o.timeOffsetHighTide, height: o.heightOffsetHighTide },
      low: { minutes: o.timeOffsetLowTide, height: o.heightOffsetLowTide },
    });
    need.add(o.refStationId);
  }
  for (const id of need) {
    const t = await buildTable(id);
    delete t.note;
    tables[id] = t;
    console.log(`  table ${id} ${t.name}: ${t.constituents.length} constituents`);
  }
  const doc = {
    name: opt.name ?? "", bbox: [w, s, e, n], years: [FROM, TO],
    source: "NOAA CO-OPS tide prediction stations, harmonic constituents and subordinate-station offsets",
    datum: "Heights are predicted above each table's MSL; tide tables conventionally quote them above MLLW (level - datums.MLLW).",
    stations, tables,
  };
  writeFileSync(out, JSON.stringify(doc));
  console.log(`${stations.length} stations (${stations.filter(x => x.kind === "harmonic").length} harmonic, ${stations.filter(x => x.kind === "subordinate").length} subordinate), ${Object.keys(tables).length} tables -> ${out}`);
} else {
  // ---- Single-station mode --------------------------------------------------
  const [station, out] = positional;
  if (!station || !out) usage();
  const table = await buildTable(station, {
    mslNavd: opt["msl-navd88"] != null ? Number(opt["msl-navd88"]) : null,
    mslNavdSource: opt["msl-navd88-source"] ?? (opt["msl-navd88"] != null ? "passed on the command line" : null),
    requireNavd: true,
  });
  writeFileSync(out, JSON.stringify(table));
  console.log(`${table.name} (${station}): ${table.constituents.length} constituents, ${FROM}-${TO} -> ${out}`);
  console.log("datums above MSL (m):", table.datums, "| MSL - NAVD88:", table.msl_navd88_m, `(${table.msl_navd88_source})`);
}

function usage() {
  console.error("usage: build-tide-table.mjs <station-id> <out.json> [--msl-navd88=<m>] [--msl-navd88-source=<text>] [--from=2020] [--to=2045]\n" +
                "       build-tide-table.mjs --bbox=<w,s,e,n> <out.json> [--name=<text>] [--from=2020] [--to=2045]");
  process.exit(1);
}
