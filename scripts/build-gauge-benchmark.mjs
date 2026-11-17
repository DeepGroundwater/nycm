#!/usr/bin/env node
// Build the benchmark file for the flood view from a real tide gauge.
//
//   node scripts/build-gauge-benchmark.mjs HOGN6 data/hog-island-gauge.json \
//        --tide=data/long-beach-tide.json --years=3 --event=2026-09-24,2026-09-30 --event-label="Sep 2026"
//   node scripts/build-gauge-benchmark.mjs KPTN6 data/kings-point-gauge.json \
//        --coops=8516945 --tide=data/kings-point-tide.json --years=3 --event=auto
//
// Sources
//   NOAA NWPS  api.water.noaa.gov          gauge identity, datum offsets, official flood stages
//   USGS NWIS  (nwis.)waterservices.usgs.gov  observed water level, ft NAVD88 (parameter 62620)
//   NOAA CO-OPS api.tidesandcurrents.noaa.gov  the same, for gauges NOAA runs itself (--coops=<station>)
//
// Output
//   - flood stages and the NAVD88 <-> MLLW offset, so the map can speak the gauge's own datum
//   - how often each level has actually been reached (daily highs over --years)
//   - the tide calibration: mean of (observed - predicted) against the harmonic
//     table given by --tide. That is today's mean water level in NAVD88 relative
//     to the table's 1983-2001 mean sea level: datum tie and sea-level rise in one number.
//   - the observed series for one event, for replay
import { readFileSync, writeFileSync } from "node:fs";
import { tideMsl } from "../js/tide.js";

const args = process.argv.slice(2);
const [lid, out] = args.filter(a => !a.startsWith("--"));
const opt = Object.fromEntries(args.filter(a => a.startsWith("--")).map(a => { const i = a.indexOf("="); return [a.slice(2, i < 0 ? undefined : i), i < 0 ? "" : a.slice(i + 1)]; }));
if (!lid || !out) { console.error("usage: build-gauge-benchmark.mjs <NWPS id> <out.json> [--coops=<station>] [--tide=<table.json>] [--years=3] [--calibrate-table] [--event=<from>,<to>|auto] [--event-label=<text>]"); process.exit(1); }
const FT = 0.3048, DAY = 864e5, YEARS = Number(opt.years ?? 3);

const gauge = await (await fetch(`https://api.water.noaa.gov/nwps/v1/gauges/${lid}`)).json();
// NWPS lists each datum as the offset to ADD to a height above that datum's zero
// to express it in the gauge datum, sign-flipped: NAVD88 = -2.794 means NAVD88's
// zero sits 2.794 ft above the gauge's MLLW zero.
const datum = Object.fromEntries(gauge.datums.vertical.value.map(d => [d.abbrev.replace("*", ""), -d.value]));
if (datum.NAVD88 == null) throw new Error(`${lid}: NWPS gives no NAVD88 offset`);
const stages = Object.fromEntries(Object.entries(gauge.flood.categories).filter(([, v]) => v.stage > -999).map(([k, v]) => [k, v.stage]));

// ---- observed record, ft NAVD88 -------------------------------------------------
async function usgs(from, to) {
  // The archive host serves anything older than ~120 days; it also takes recent dates.
  const url = `https://nwis.waterservices.usgs.gov/nwis/iv/?format=rdb&parameterCd=62620&sites=${gauge.usgsId}&startDT=${from}T00:00Z&endDT=${to}T00:00Z`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(url);
    const text = await r.text();
    if (r.ok && text.includes("\nUSGS\t")) return text;
    if (r.ok && !text.includes("<html")) return "";
    await new Promise(res => setTimeout(res, 3000));
  }
  return null;
}
const iso = ms => new Date(ms).toISOString().slice(0, 10);
const obs = new Map();
const end = Date.now(), start = end - YEARS * 365.25 * DAY;
let failedDays = 0;
// The archive occasionally errors on a span (around clock changes, for one).
// Halve a failing span until it loads or is down to a couple of days.
async function load(a, b) {
  const text = await usgs(iso(a), iso(b));
  if (text == null) {
    if (b - a <= 2 * DAY) { failedDays += (b - a) / DAY; console.warn(`  no data for ${iso(a)} to ${iso(b)}`); return; }
    const mid = a + Math.round((b - a) / 2 / DAY) * DAY;
    await load(a, mid); await load(mid, b);
    return;
  }
  for (const line of text.split("\n")) {
    if (!line.startsWith("USGS")) continue;
    const p = line.split("\t"), v = Number(p[4]);
    if (!p[4] || Number.isNaN(v)) continue;
    obs.set(Date.parse(p[2].replace(" ", "T") + ":00Z") + (p[3] === "EDT" ? 4 : 5) * 36e5, v);
  }
}
// NOAA's own gauges: six-minute water level, at most 31 days a request.
async function loadCoops(a, b) {
  const ymd = ms => iso(ms).replaceAll("-", "");
  const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=water_level&datum=NAVD&units=english&time_zone=gmt&format=json&station=${opt.coops}&begin_date=${ymd(a)}&end_date=${ymd(b)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const d = await (await fetch(url)).json();
      for (const r of d.data ?? []) { const v = Number(r.v); if (r.v !== "" && !Number.isNaN(v)) obs.set(Date.parse(r.t.replace(" ", "T") + ":00Z"), v); }
      if (d.data || d.error) return;
    } catch { /* retry */ }
    await new Promise(res => setTimeout(res, 3000));
  }
  failedDays += (b - a) / DAY; console.warn(`  no data for ${iso(a)} to ${iso(b)}`);
}
if (opt.coops) for (let a = start; a < end; a += 30 * DAY) await loadCoops(a, Math.min(end, a + 30 * DAY - DAY));
else for (let a = start; a < end; a += 32 * DAY) await load(a, Math.min(end + DAY, a + 32 * DAY));
const rows = [...obs.entries()].sort((a, b) => a[0] - b[0]);
if (rows.length < 1000) throw new Error("too little observed data");
const toMllw = navdFt => navdFt + datum.NAVD88;

// ---- how often is each level reached? ------------------------------------------
const daily = new Map();                                        // local standard-time days
for (const [ms, v] of rows) { const d = iso(ms - 5 * 36e5); if (!(daily.get(d) >= v)) daily.set(d, v); }
const highs = [...daily.entries()].map(([d, v]) => [d, toMllw(v)]);
const sorted = highs.map(h => h[1]).sort((a, b) => a - b);
const pct = p => Number(sorted[Math.floor(p * (sorted.length - 1))].toFixed(2));
const daysAtOrAbove = Object.fromEntries(Object.entries(stages).map(([k, s]) => [k, highs.filter(h => h[1] >= s).length]));
// Days whose high reached each quarter-foot: lets the map say how rare a level is.
const reachedOnDays = [];
for (let ft = Math.floor(sorted[0]); ft <= Math.ceil(sorted.at(-1)) + 0.25; ft += 0.25) reachedOnDays.push([ft, highs.filter(h => h[1] >= ft).length]);
const top = [...highs].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([date, ft]) => ({ date, ft: Number(ft.toFixed(2)) }));

// ---- tide calibration ----------------------------------------------------------
let calibration = null;
if (opt.tide) {
  const table = JSON.parse(readFileSync(opt.tide, "utf8"));
  let n = 0, sum = 0, sq = 0;
  for (let i = 0; i < rows.length; i += 5) { const e = rows[i][1] * FT - tideMsl(table, rows[i][0]); n++; sum += e; sq += e * e; }
  const mean = sum / n;
  if (opt["calibrate-table"] != null) {
    // Write the calibration back into the tide table, so the two files agree.
    table.msl_navd88_m = Number(mean.toFixed(3));
    table.msl_navd88_source = `calibrated: mean of observed minus predicted over ${YEARS} years at NOAA ${lid}` +
      `${opt.coops ? ` (station ${opt.coops})` : gauge.usgsId ? ` / USGS ${gauge.usgsId}` : ""}. Includes sea-level rise since the 1983-2001 epoch.`;
    writeFileSync(opt.tide, JSON.stringify(table));
  }
  calibration = {
    table_station: table.station,
    msl_navd88_m: Number(mean.toFixed(3)),
    residual_sd_m: Number(Math.sqrt(sq / n - mean * mean).toFixed(3)),
    note: "Mean of observed minus predicted. Add to the table's prediction (above its 1983-2001 MSL) to get NAVD88 today.",
  };
}

// ---- one event, for replay -----------------------------------------------------
let event = null;
if (opt.event) {
  // "auto": the days around the highest water on record.
  const auto = opt.event === "auto" ? Date.parse(top[0].date + "T05:00:00Z") : null;
  const [from, to] = auto ? [auto - 2 * DAY, auto + 3 * DAY] : opt.event.split(",").map(d => Date.parse(d + "T05:00:00Z"));       // local midnights (EST)
  if (auto && !opt["event-label"]) opt["event-label"] = new Date(auto).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  const STEP = 12 * 6e4, values = [];
  let j = 0;
  for (let t = from; t <= to; t += STEP) {
    while (j < rows.length - 1 && rows[j + 1][0] <= t) j++;
    const near = Math.abs(rows[j][0] - t) <= 30 * 6e4 ? rows[j][1] : null;
    values.push(near == null ? null : Number(toMllw(near).toFixed(2)));
  }
  // Gauge outages: join the readings either side with a straight line, and say so.
  let interpolated = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] != null) continue;
    let a = i - 1, b = i;
    while (b < values.length && values[b] == null) b++;
    if (a < 0 || b >= values.length) continue;
    for (let k = i; k < b; k++) { values[k] = Number((values[a] + (values[b] - values[a]) * (k - a) / (b - a)).toFixed(2)); interpolated++; }
    i = b;
  }
  const peak = rows.filter(r => r[0] >= from && r[0] <= to).reduce((a, b) => (b[1] > a[1] ? b : a));
  event = { label: opt["event-label"] ?? opt.event, start: new Date(from).toISOString(), step_minutes: 12, ft_mllw: values,
            interpolated_values: interpolated,
            peak: { time: new Date(peak[0]).toISOString(), ft_mllw: Number(toMllw(peak[1]).toFixed(2)) } };
}

const doc = {
  id: lid, usgs: gauge.usgsId || null, coops: opt.coops ?? null, name: gauge.name.replace(/\s*\(IN MLLW\)/i, ""), lat: gauge.latitude, lng: gauge.longitude,
  datum: "MLLW", units: "ft",
  navd88_above_mllw_ft: Number(datum.NAVD88.toFixed(3)),
  datums_ft_mllw: Object.fromEntries(Object.entries(datum).map(([k, v]) => [k, Number(v.toFixed(3))])),
  flood_stages_ft_mllw: stages,
  record: {
    from: iso(rows[0][0]), to: iso(rows.at(-1)[0]), days: highs.length, days_unavailable: failedDays,
    daily_high_ft_mllw: { median: pct(0.5), p90: pct(0.9), p99: pct(0.99), max: pct(1) },
    days_at_or_above_stage: daysAtOrAbove,
    days_reaching_ft: reachedOnDays,
    highest_days: top,
  },
  calibration, event,
  source: opt.coops
    ? `NOAA NWPS (flood stages, datums); NOAA CO-OPS station ${opt.coops} (observed water level)`
    : "NOAA NWPS (flood stages, datums); USGS NWIS parameter 62620 (observed water level)",
};
writeFileSync(out, JSON.stringify(doc));
console.log(`${doc.name}: ${rows.length} observations over ${highs.length} days${failedDays ? `, ${failedDays} days unavailable` : ""} -> ${out}`);
console.log("stages (ft MLLW):", stages, "| days at or above:", daysAtOrAbove);
console.log("daily high (ft MLLW):", doc.record.daily_high_ft_mllw, "| NAVD88 is", doc.navd88_above_mllw_ft, "ft above MLLW");
if (calibration) console.log("tide calibration:", calibration.msl_navd88_m, "m, residual sd", calibration.residual_sd_m, "m");
if (event) console.log("event", event.label, "peak", event.peak);
