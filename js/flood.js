// Still-water flood view: USGS 3DEP lidar ground elevation joined to building
// footprints, plus the terrain grid itself, so a chosen water level can be
// drawn against the 3D city. Data comes from pipelines/flood_elevation.py.
//
// What it is: a connected "bathtub". A cell floods when the water level is
// above its ground AND a path to the sea exists at that level (the pipeline
// precomputes that threshold per cell, so each slider move is one linear pass).
// What it is not: a hydrodynamic model — no waves, flow, drainage or timing.

const M_PER_FT = 0.3048;
export const ftToM = ft => ft * M_PER_FT;
export const mToFt = m => m / M_PER_FT;

// Wet: blue by depth. Nearly under: amber, strongest closest to the water.
export const NEAR_COLORS = ["#e26e1c", "#eea034", "#f4c868"];
const DRY_COLOR = "#e9e3d7";
export const DEPTH_RAMP = [[0, "#8ec1ee"], [1.0, "#3f7fcf"], [2.5, "#1b3f8f"]];
const WATER_SHALLOW = [122, 182, 236], WATER_DEEP = [28, 84, 170];

const SRC_WATER = "flood-water", SRC_BLDG = "flood-buildings";

// ---- Pure maths (unit-tested in tests/unit/flood) ----------------------------
// The grid is held as integer centimetres (Int16): half the memory of floats,
// which matters once the area grows, and exact comparisons.

/** Marker for cells that are permanent water (sea, bay, channel). */
export const SEA = -32768;

/**
 * Unpack the terrain PNG's RGBA bytes (see pipelines/flood_elevation.py).
 * @returns {{elev: Int16Array, reach: Int16Array}} centimetres NAVD88
 *   elev  — ground; SEA for permanent water
 *   reach — the lowest water level at which the sea gets to this cell (>= elev)
 */
export function decodeGrid(px, { offset_m, scale, sill_step_m }) {
  const n = px.length / 4, toCm = 100 / scale, offsetCm = Math.round(offset_m * 100), sillCm = Math.round(sill_step_m * 100);
  const elev = new Int16Array(n), reach = new Int16Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const q = (px[p] << 8) | px[p + 1];
    if (q === 0) { elev[i] = SEA; reach[i] = SEA; continue; }
    elev[i] = Math.round(q * toCm) - offsetCm;
    reach[i] = elev[i] + px[p + 2] * sillCm;
  }
  return { elev, reach };
}

export const toCm = m => Math.round(m * 100);

/** A land cell is wet when the water is above the level at which the sea reaches it. */
export const isWet = (reachCm, levelCm) => reachCm !== SEA && reachCm < levelCm;

/**
 * Land within this many feet above the water is flagged as "nearly under".
 * Kept tight on purpose: at the benchmark gauge an ordinary high tide and a
 * major flood are only about 2.5 ft apart, so wider bands would cry wolf daily.
 */
export const NEAR_FT = [0.5, 1, 1.5];
const NEAR_CM = NEAR_FT.map(ft => Math.round(ft * 30.48));

export const DRY = 0, NEAR_1 = 1, NEAR_2 = 2, NEAR_3 = 3, WET = 4, WATER = 5;
/**
 * What a cell is at a given water level:
 *   WATER  permanent water          WET     land the sea has reached
 *   NEAR_n dry, but the sea would reach it with n more feet of water
 *   DRY    everything else
 * "Near" uses the reach level, not bare ground height, so a low yard behind a
 * bulkhead is not flagged until the bulkhead itself is close to being topped.
 */
export function classify(reachCm, levelCm) {
  if (reachCm === SEA) return WATER;
  const margin = reachCm - levelCm;
  if (margin < 0) return WET;
  if (margin < NEAR_CM[0]) return NEAR_1;
  if (margin < NEAR_CM[1]) return NEAR_2;
  if (margin < NEAR_CM[2]) return NEAR_3;
  return DRY;
}

// Amber for "nearly under": the closer to the water, the stronger.
const NEAR_RGBA = [null, [226, 110, 28, 170], [238, 160, 52, 120], [244, 200, 104, 80]];

/**
 * The part of the grid a map view needs, at a resolution the screen can use.
 * The grid is Web-Mercator aligned between meta.bbox. Returns null when the
 * view misses the grid entirely.
 * @param bounds  {west, south, east, north} of the view, degrees
 * @param maxSide cap on output pixels per side; beyond it cells are skipped (stride > 1)
 */
export function gridWindow(meta, bounds, maxSide = 2048) {
  const [w, s, e, n] = meta.bbox, { width, height } = meta.dem;
  const Y = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
  const lat = y => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;
  const yn = Y(n), ys = Y(s);
  const col = lon => (lon - w) / (e - w) * width;
  const row = la => (yn - Y(Math.max(-85, Math.min(85, la)))) / (yn - ys) * height;
  const c0 = Math.max(0, Math.floor(col(bounds.west))), c1 = Math.min(width, Math.ceil(col(bounds.east)));
  const r0 = Math.max(0, Math.floor(row(bounds.north))), r1 = Math.min(height, Math.ceil(row(bounds.south)));
  if (c1 <= c0 || r1 <= r0) return null;
  const stride = Math.max(1, Math.ceil(Math.max(c1 - c0, r1 - r0) / maxSide));
  const ow = Math.ceil((c1 - c0) / stride), oh = Math.ceil((r1 - r0) / stride);
  const lon = c => w + c / width * (e - w), la = r => lat(yn - r / height * (yn - ys));
  const west = lon(c0), east = lon(c0 + ow * stride), north = la(r0), south = la(r0 + oh * stride);
  return { c0, r0, ow, oh, stride, width, height, corners: [[west, north], [east, north], [east, south], [west, south]] };
}

/**
 * Paint one window of the grid into RGBA bytes (ow x oh):
 *   wet land      blue, deeper = darker
 *   nearly under  amber bands
 *   water         an optional tint that strengthens as the tide rises (seaAlpha 0-255)
 * Returns the number of wet cells painted.
 */
export function paintWindow({ elev, reach }, levelCm, win, rgba, seaAlpha = 0) {
  const { c0, r0, ow, oh, stride, width, height } = win;
  let wet = 0, p = 0;
  for (let oy = 0; oy < oh; oy++) {
    const base = Math.min(height - 1, r0 + oy * stride) * width;
    for (let ox = 0; ox < ow; ox++, p += 4) {
      const i = base + Math.min(width - 1, c0 + ox * stride);
      const kind = classify(reach[i], levelCm);
      if (kind === DRY) { rgba[p + 3] = 0; continue; }
      if (kind === WATER) {
        rgba[p] = 30; rgba[p + 1] = 92; rgba[p + 2] = 168; rgba[p + 3] = seaAlpha;
      } else if (kind === WET) {
        const t = Math.min(1, (levelCm - elev[i]) / 250);
        rgba[p] = WATER_SHALLOW[0] + (WATER_DEEP[0] - WATER_SHALLOW[0]) * t;
        rgba[p + 1] = WATER_SHALLOW[1] + (WATER_DEEP[1] - WATER_SHALLOW[1]) * t;
        rgba[p + 2] = WATER_SHALLOW[2] + (WATER_DEEP[2] - WATER_SHALLOW[2]) * t;
        rgba[p + 3] = 150 + 70 * t;
        wet++;
      } else {
        const c = NEAR_RGBA[kind];
        rgba[p] = c[0]; rgba[p + 1] = c[1]; rgba[p + 2] = c[2]; rgba[p + 3] = c[3];
      }
    }
  }
  return wet;
}

/** How strongly to tint open water: faint at the lowest tide, strong at the highest and beyond. */
export function seaTint(levelM, lowM, highM) {
  const f = Math.max(0, Math.min(1.6, (levelM - lowM) / (highM - lowM)));
  return Math.round(8 + 62 * f);
}

/** Buildings the sea has reached: strictly above each one's threshold `w`. */
export function countReached(thresholds, level) {
  let n = 0;
  for (let i = 0; i < thresholds.length; i++) if (level > thresholds[i]) n++;
  return n;
}

export function createFlood(map, maplibregl, { metaUrl = "data/long-beach-flood.json", onChange = () => {} } = {}) {
  let meta = null, grid = null, canvas = null, ctx = null, image = null, win = null;
  let tideLow = -1.14, tideHigh = 1.02;      // m NAVD88; refined by setTideRange()
  let buildings = null, bReach = null;
  let level = 2.0, on = false, loading = null, popup = null, lastWet = -1;

  async function load() {
    if (loading) return loading;
    loading = (async () => {
      const base = new URL(metaUrl, location.href);
      meta = await fetch(base).then(r => r.json());
      const [bmp, fc] = await Promise.all([
        fetch(new URL(meta.dem.url, base)).then(r => r.blob())
          .then(b => createImageBitmap(b, { colorSpaceConversion: "none", premultiplyAlpha: "none" })),
        fetch(new URL(meta.buildings.url, base)).then(r => r.json()),
      ]);
      const { width: w, height: h } = meta.dem;
      const tmp = new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true });
      tmp.drawImage(bmp, 0, 0);
      const px = tmp.getImageData(0, 0, w, h).data;
      grid = decodeGrid(px, meta.dem);
      canvas = document.createElement("canvas");
      canvas.width = canvas.height = 2;
      ctx = canvas.getContext("2d");
      buildings = fc;
      bReach = Float32Array.from(fc.features, f => f.properties.w);
    })();
    return loading;
  }

  // Paint only what the current view needs: the cost follows the screen, not
  // the size of the dataset. Called when the level changes and when the map moves.
  function paintWater() {
    const b = map.getBounds();
    const next = gridWindow(meta, { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() });
    if (!next) return;
    const moved = !win || next.c0 !== win.c0 || next.r0 !== win.r0 || next.ow !== win.ow || next.oh !== win.oh || next.stride !== win.stride;
    win = next;
    if (canvas.width !== win.ow || canvas.height !== win.oh) {
      canvas.width = win.ow; canvas.height = win.oh;
      image = ctx.createImageData(win.ow, win.oh);
    }
    paintWindow(grid, toCm(level), win, image.data, seaTint(level, tideLow, tideHigh));
    ctx.putImageData(image, 0, 0);
    const src = map.getSource(SRC_WATER);
    if (src) {
      if (moved) src.setCoordinates(win.corners);
      // A paused canvas source only re-uploads its texture while "playing".
      src.play();
      map.once("render", () => src.pause());
      map.triggerRepaint();
    }
  }
  let moveTimer = 0;
  function onMove() {
    if (!on || !grid || moveTimer) return;
    moveTimer = setTimeout(() => { moveTimer = 0; if (on && map.getSource(SRC_WATER)) paintWater(); }, 120);
  }

  // Buildings speak the same language as the ground: blue once the sea has
  // reached them, amber when it is within 1, 2 or 3 ft of doing so, plain otherwise.
  function buildingColor() {
    const margin = ["-", ["get", "w"], level];
    return ["case",
      ["<", margin, 0], ["interpolate", ["linear"], ["-", level, ["get", "lo"]], ...DEPTH_RAMP.flat()],
      ["<", margin, NEAR_FT[0] * M_PER_FT], NEAR_COLORS[0],
      ["<", margin, NEAR_FT[1] * M_PER_FT], NEAR_COLORS[1],
      ["<", margin, NEAR_FT[2] * M_PER_FT], NEAR_COLORS[2],
      DRY_COLOR];
  }

  function stats() {
    return { level, wet: countReached(bReach, level), total: meta.buildings.count_total ?? bReach.length, meta };
  }

  // Layers live in the style, so every setStyle() wipes them: re-add on demand.
  function ensureLayers() {
    if (!on || !grid) return;
    // isStyleLoaded() is also false while tiles are still arriving, and no
    // further "styledata" follows that — so retry once the map settles.
    if (!map.isStyleLoaded()) { map.once("idle", ensureLayers); return; }
    if (!map.getSource(SRC_WATER)) {
      const [w, s, e, n] = meta.bbox;
      map.addSource(SRC_WATER, { type: "canvas", canvas, animate: false, coordinates: win?.corners ?? [[w, n], [e, n], [e, s], [w, s]] });
      map.addLayer({
        id: SRC_WATER, type: "raster", source: SRC_WATER,
        paint: { "raster-fade-duration": 0, "raster-resampling": "linear" },
      }, map.getLayer("city-building-shadow") ? "city-building-shadow" : undefined);
      win = null;                // force the new source to take the window's corners
      paintWater();
    }
    if (!map.getSource(SRC_BLDG)) {
      map.addSource(SRC_BLDG, { type: "geojson", data: buildings });
      map.addLayer({
        id: SRC_BLDG, type: "fill-extrusion", source: SRC_BLDG, minzoom: 13,
        paint: {
          // Slightly taller and wider than the basemap's own copy, so this one wins.
          "fill-extrusion-height": ["+", ["coalesce", ["get", "h"], 9], 0.4],
          "fill-extrusion-color": buildingColor(),
          "fill-extrusion-vertical-gradient": false,
        },
      }, map.getLayer("city-trees") ? "city-trees" : undefined);
    }
  }

  function removeLayers() {
    for (const id of [SRC_BLDG, SRC_WATER]) {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    }
    if (popup) popup.remove();
  }

  function refresh() {
    if (!on || !grid) return;
    if (map.getSource(SRC_WATER)) paintWater();
    // Recolouring thousands of extrusions is the costly part. At ordinary tide
    // levels no building is reached before or after the change, so skip it.
    const st = stats();
    // "Active" = reached or within the widest nearly-under band.
    st.active = countReached(bReach, level + NEAR_FT[2] * M_PER_FT);
    if (map.getLayer(SRC_BLDG) && (st.active > 0 || lastWet !== 0)) {
      map.setPaintProperty(SRC_BLDG, "fill-extrusion-color", buildingColor());
    }
    lastWet = st.active;
    onChange(st);
  }

  const fmt = m => `${mToFt(m).toFixed(1)} ft (${m.toFixed(2)} m)`;
  map.on("click", SRC_BLDG, e => {
    const p = e.features[0]?.properties; if (!p) return;
    const wet = level > p.w, depth = level - p.lo;
    const sheltered = p.w > p.lo + 0.1;
    popup = popup || new maplibregl.Popup({ closeButton: false, maxWidth: "240px" });
    popup.setLngLat(e.lngLat).setHTML(`
      <div style="font:12px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#222">
        <div style="font-weight:600;margin-bottom:2px">Ground ${fmt(p.lo)} NAVD88</div>
        <div style="color:${wet ? "#1b4f9c" : "#666"}">${wet
          ? `Water ${fmt(depth)} above ground`
          : `Dry — the water needs to rise ${fmt(p.w - level)} to reach it`}</div>
        ${sheltered ? `<div style="color:#888">Sheltered: sea reaches it at ${fmt(p.w)}</div>` : ""}
      </div>`).addTo(map);
  });
  map.on("mouseenter", SRC_BLDG, () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", SRC_BLDG, () => { map.getCanvas().style.cursor = ""; });
  map.on("styledata", ensureLayers);
  map.on("move", onMove);
  map.on("moveend", onMove);

  return {
    get on() { return on; },
    get level() { return level; },
    get meta() { return meta; },
    async enable() {
      on = true;
      await load();
      if (!on) return;
      ensureLayers();
      refresh();
    },
    disable() { on = false; lastWet = -1; removeLayers(); },
    setLevel(m) { level = m; refresh(); },
    /** Lowest and highest astronomical tide (m NAVD88), to scale the open-water tint. */
    setTideRange(lowM, highM) { tideLow = lowM; tideHigh = highM; },
    /** Camera that shows the dataset, for a "take me there" on enable. */
    view() {
      return meta.view ?? { center: [(meta.bbox[0] + meta.bbox[2]) / 2, (meta.bbox[1] + meta.bbox[3]) / 2], zoom: 13.5 };
    },
    contains(lngLat) {
      if (!meta) return false;
      const [w, s, e, n] = meta.bbox;
      return lngLat.lng > w && lngLat.lng < e && lngLat.lat > s && lngLat.lat < n;
    },
  };
}
