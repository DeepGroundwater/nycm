#!/usr/bin/env node
// Build a self-contained tide-prediction table for one NOAA harmonic station.
//
//   npm install --no-save @neaps/tide-predictor
//   node scripts/build-tide-table.mjs 8516663 data/long-beach-tide.json --msl-navd88=-0.073 \
//        --msl-navd88-source="Sandy Hook 8531680, this station's control station"
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
import { writeFileSync } from "node:fs";
import { constituents, astro } from "@neaps/tide-predictor";

const args = process.argv.slice(2);
const [station, out] = args.filter(a => !a.startsWith("--"));
const opt = Object.fromEntries(args.filter(a => a.startsWith("--")).map(a => a.slice(2).split("=")));
if (!station || !out) {
  console.error("usage: build-tide-table.mjs <station-id> <out.json> [--msl-navd88=<m>] [--msl-navd88-source=<text>] [--from=2020] [--to=2045]");
  process.exit(1);
}
const FROM = Number(opt.from ?? 2020), TO = Number(opt.to ?? 2045);
const API = `https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/${station}`;
const get = async path => {
  const r = await fetch(`${API}${path}`);
  if (!r.ok) throw new Error(`${r.status} ${API}${path}`);
  return r.json();
};

const [meta, harcon, datums] = await Promise.all([
  get(".json"), get("/harcon.json?units=metric"), get("/datums.json?units=metric"),
]);
const st = meta.stations[0];
const used = harcon.HarmonicConstituents.filter(c => c.amplitude > 0);
const unknown = used.filter(c => !constituents[c.name]).map(c => c.name);
if (unknown.length) throw new Error(`constituents without astronomy: ${unknown.join(", ")}`);

const norm = deg => ((deg % 360) + 360) % 360;
const years = {};
for (let y = FROM; y <= TO; y++) {
  const start = astro(new Date(Date.UTC(y, 0, 1)));
  const mid = astro(new Date(Date.UTC(y, 6, 2, 12)));          // NOAA uses mid-year node factors
  const f = [], vu = [];
  for (const c of used) {
    const k = constituents[c.name];
    const corr = k.correction(mid);
    f.push(Number(corr.f.toFixed(5)));
    vu.push(Number(norm(k.value(start) + corr.u).toFixed(3)));
  }
  years[y] = { f, vu };
}

const level = Object.fromEntries(datums.datums.map(d => [d.name, d.value]));
const aboveMsl = v => (v == null || level.MSL == null ? null : Number((v - level.MSL).toFixed(3)));
let mslNavd = opt["msl-navd88"] != null ? Number(opt["msl-navd88"]) : null;
let mslNavdSource = opt["msl-navd88-source"] ?? "passed on the command line";
if (mslNavd == null) {
  if (level.NAVD88 == null) throw new Error("NOAA has no NAVD88 tie for this station: pass --msl-navd88=<metres>");
  mslNavd = Number((level.MSL - level.NAVD88).toFixed(3));
  mslNavdSource = "NOAA datums for this station";
}

const table = {
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
writeFileSync(out, JSON.stringify(table));
console.log(`${st.name} (${station}): ${used.length} constituents, ${FROM}-${TO} -> ${out}`);
console.log("datums above MSL (m):", table.datums, "| MSL - NAVD88:", mslNavd, `(${mslNavdSource})`);
