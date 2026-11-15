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
