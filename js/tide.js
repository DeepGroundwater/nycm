// Astronomical tide prediction from NOAA harmonic constituents.
//
// The table (scripts/build-tide-table.mjs) carries, for one station, each
// constituent's amplitude / phase / speed and — per calendar year — its node
// factor f and equilibrium argument V0+u. The predicted height is then just
//
//   h(t) = sum_i  f_i * A_i * cos( speed_i * hours_since_Jan_1_UTC + (V0+u)_i - phase_i )
//
// which is how NOAA computes its own tide tables. Checked against NOAA's
// published predictions in tests/unit/tide (agreement within about 1 cm).
//
// This is the ASTRONOMICAL tide only. Real water levels also carry weather:
// wind, pressure and storm surge are not in here.

const RAD = Math.PI / 180;
const HOUR = 3.6e6;

/** Predicted height in metres above the station's mean sea level. */
export function tideMsl(table, ms) {
  const year = new Date(ms).getUTCFullYear();
  const y = table.years[year];
  if (!y) throw new RangeError(`tide table has no data for ${year}`);
  const hours = (ms - Date.UTC(year, 0, 1)) / HOUR;
  const c = table.constituents;
  let h = 0;
  for (let i = 0; i < c.length; i++) {
    h += y.f[i] * c[i].amp * Math.cos((c[i].speed * hours + y.vu[i] - c[i].phase) * RAD);
  }
  return h;
}

/** Predicted height in metres NAVD88 (MSL shifted by the table's datum tie). */
export const tideNavd = (table, ms) => tideMsl(table, ms) + table.msl_navd88_m;

/** A tidal datum (e.g. "MHHW") in metres NAVD88, or null if the station lacks it. */
export function datumNavd(table, name) {
  const v = table.datums?.[name];
  return v == null ? null : v + table.msl_navd88_m;
}

/** True when the table covers this instant. */
export const covers = (table, ms) => Boolean(table.years[new Date(ms).getUTCFullYear()]);

/**
 * High and low waters in [startMs, endMs].
 * Scans at `stepMs` for a change of slope, then narrows each turning point by
 * golden-section search to about a second.
 * @returns {{time: number, level: number, type: "H"|"L"}[]} levels in m above MSL
 */
export function extremes(table, startMs, endMs, stepMs = 10 * 60e3) {
  const out = [];
  let a = startMs, ha = tideMsl(table, a);
  let b = a + stepMs, hb = tideMsl(table, b);
  for (let c = b + stepMs; c <= endMs + stepMs; c += stepMs) {
    const hc = tideMsl(table, c);
    const high = hb > ha && hb >= hc, low = hb < ha && hb <= hc;
    if (high || low) {
      const t = turningPoint(table, a, c, high ? 1 : -1);
      if (t >= startMs && t <= endMs) out.push({ time: t, level: tideMsl(table, t), type: high ? "H" : "L" });
    }
    a = b; ha = hb; b = c; hb = hc;
  }
  return out;
}

function turningPoint(table, lo, hi, sign) {
  const g = (Math.sqrt(5) - 1) / 2;
  const f = t => sign * tideMsl(table, t);
  let x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo), f1 = f(x1), f2 = f(x2);
  while (hi - lo > 1000) {
    if (f1 < f2) { lo = x1; x1 = x2; f1 = f2; x2 = lo + g * (hi - lo); f2 = f(x2); }
    else { hi = x2; x2 = x1; f2 = f1; x1 = hi - g * (hi - lo); f1 = f(x1); }
  }
  return (lo + hi) / 2;
}

/** Evenly spaced samples, for drawing a curve: [{time, level}] in m above MSL. */
export function series(table, startMs, endMs, n = 200) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const time = startMs + (endMs - startMs) * i / (n - 1);
    out.push({ time, level: tideMsl(table, time) });
  }
  return out;
}

// ---- Many stations (data/tide-stations.json) ----------------------------------
// Tide tables quote heights above MLLW ("chart datum"), which every station
// has, so the multi-station API works in metres above MLLW.

/** Predicted height in metres above the table's mean lower low water. */
export const tideMllw = (table, ms) => tideMsl(table, ms) - (table.datums.MLLW ?? 0);

/**
 * High and low waters at a SUBORDINATE station, in metres above MLLW.
 * NOAA has no harmonics for these: it takes the reference station's highs and
 * lows, shifts each in time, and scales (or offsets) its height above MLLW.
 */
export function subordinateExtremes(station, refTable, startMs, endMs) {
  const FT = 0.3048, pad = 6 * 3.6e6;
  const adjust = (level, o) => station.height === "ratio" ? level * o.height : level + o.height * FT;
  return extremes(refTable, startMs - pad, endMs + pad)
    .map(e => {
      const o = e.type === "H" ? station.high : station.low;
      return { time: e.time + o.minutes * 60e3, level: adjust(e.level - (refTable.datums.MLLW ?? 0), o), type: e.type };
    })
    .filter(e => e.time >= startMs && e.time <= endMs);
}

/**
 * Height at `ms` from a list of highs and lows, joined by half-cosines — the
 * standard way to read between the entries of a tide table. Null outside the list.
 */
export function levelBetween(ext, ms) {
  for (let i = 1; i < ext.length; i++) {
    const a = ext[i - 1], b = ext[i];
    if (ms < a.time || ms > b.time) continue;
    const phase = (ms - a.time) / (b.time - a.time);
    return a.level + (b.level - a.level) * (1 - Math.cos(Math.PI * phase)) / 2;
  }
  return null;
}

/**
 * A predictor for one station of a multi-station document.
 * @returns {{ level(ms): number, extremes(startMs, endMs): object[], table: object|null, harmonic: boolean }}
 *   levels in metres above MLLW
 */
export function stationPredictor(doc, station) {
  if (station.kind === "harmonic") {
    const table = doc.tables[station.id];
    return {
      harmonic: true, table,
      level: ms => tideMllw(table, ms),
      extremes: (a, b) => extremes(table, a, b).map(e => ({ ...e, level: e.level - (table.datums.MLLW ?? 0) })),
    };
  }
  const ref = doc.tables[station.ref];
  // Cache a window of highs and lows; rebuilt when a request falls outside it.
  let from = 0, to = 0, ext = [];
  const ensure = (a, b) => {
    if (a >= from && b <= to) return;
    from = a - 12 * 3.6e6; to = b + 60 * 3.6e6;
    ext = subordinateExtremes(station, ref, from - 14 * 3.6e6, to + 14 * 3.6e6);
  };
  return {
    harmonic: false, table: null,
    level: ms => { ensure(ms, ms); return levelBetween(ext, ms); },
    extremes: (a, b) => { ensure(a, b); return ext.filter(e => e.time >= a && e.time <= b); },
  };
}
