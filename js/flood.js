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

// Dry buildings: tinted by ground elevation, warm = low. Wet: blue by depth.
export const ELEV_RAMP = [[1.0, "#cf6a3d"], [2.0, "#e9a561"], [3.0, "#f3d9a8"], [4.5, "#ebe4d6"]];
export const DEPTH_RAMP = [[0, "#8ec1ee"], [1.0, "#3f7fcf"], [2.5, "#1b3f8f"]];
const WATER_SHALLOW = [122, 182, 236], WATER_DEEP = [28, 84, 170];

const SRC_WATER = "flood-water", SRC_BLDG = "flood-buildings";

// ---- Pure maths (unit-tested in tests/unit/flood) ----------------------------

/**
 * Unpack the terrain PNG's RGBA bytes (see pipelines/flood_elevation.py).
 * @returns {{elev: Float32Array, reach: Float32Array}}
 *   elev  — ground, m NAVD88; NaN for sea
 *   reach — the lowest water level at which the sea gets to this cell (>= elev)
 */
export function decodeGrid(px, { offset_m, scale, sill_step_m }) {
  const n = px.length / 4;
  const elev = new Float32Array(n), reach = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const q = (px[p] << 8) | px[p + 1];
    if (q === 0) { elev[i] = NaN; reach[i] = NaN; continue; }
    elev[i] = q / scale - offset_m;
    reach[i] = elev[i] + px[p + 2] * sill_step_m;
  }
  return { elev, reach };
}

/** A cell is wet when the water is above the level at which the sea reaches it. */
export const isWet = (reach, level) => reach < level;   // false for NaN (sea)

/**
 * Paint every wet cell into RGBA bytes, shaded by depth. Returns the wet cell count.
 */
export function paintFlood(elev, reach, level, rgba) {
  let wet = 0;
  for (let i = 0, p = 0; i < elev.length; i++, p += 4) {
    if (!isWet(reach[i], level)) { rgba[p + 3] = 0; continue; }
    const t = Math.min(1, (level - elev[i]) / 2.5);
    rgba[p] = WATER_SHALLOW[0] + (WATER_DEEP[0] - WATER_SHALLOW[0]) * t;
    rgba[p + 1] = WATER_SHALLOW[1] + (WATER_DEEP[1] - WATER_SHALLOW[1]) * t;
    rgba[p + 2] = WATER_SHALLOW[2] + (WATER_DEEP[2] - WATER_SHALLOW[2]) * t;
    rgba[p + 3] = 150 + 70 * t;
    wet++;
  }
  return wet;
}

/** Buildings the sea has reached: strictly above each one's threshold `w`. */
export function countReached(thresholds, level) {
  let n = 0;
  for (let i = 0; i < thresholds.length; i++) if (level > thresholds[i]) n++;
  return n;
}

export function createFlood(map, maplibregl, { metaUrl = "data/long-beach-flood.json", onChange = () => {} } = {}) {
  let meta = null, elev = null, reach = null, canvas = null, ctx = null, image = null;
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
      ({ elev, reach } = decodeGrid(px, meta.dem));
      canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      ctx = canvas.getContext("2d");
      image = ctx.createImageData(w, h);
      buildings = fc;
      bReach = Float32Array.from(fc.features, f => f.properties.w);
    })();
    return loading;
  }

  // One pass over the grid: paint every cell the sea reaches at this level.
  function paintWater() {
    const wet = paintFlood(elev, reach, level, image.data);
    ctx.putImageData(image, 0, 0);
    const src = map.getSource(SRC_WATER);
    if (src) {
      // A paused canvas source only re-uploads its texture while "playing".
      src.play();
      map.once("render", () => src.pause());
      map.triggerRepaint();
    }
    return wet * meta.dem.cell_m ** 2;
  }

  function buildingColor() {
    const ramp = (input, stops) => ["interpolate", ["linear"], input, ...stops.flat()];
    return ["case", [">", level, ["get", "w"]],
      ramp(["-", level, ["get", "lo"]], DEPTH_RAMP),
      ramp(["get", "lo"], ELEV_RAMP)];
  }

  function stats(areaM2) {
    const wet = countReached(bReach, level);
    return { level, wet, total: bReach.length, floodedKm2: areaM2 / 1e6, meta };
  }

  // Layers live in the style, so every setStyle() wipes them: re-add on demand.
  function ensureLayers() {
    if (!on || !elev) return;
    // isStyleLoaded() is also false while tiles are still arriving, and no
    // further "styledata" follows that — so retry once the map settles.
    if (!map.isStyleLoaded()) { map.once("idle", ensureLayers); return; }
    const [w, s, e, n] = meta.bbox;
    if (!map.getSource(SRC_WATER)) {
      map.addSource(SRC_WATER, { type: "canvas", canvas, animate: false, coordinates: [[w, n], [e, n], [e, s], [w, s]] });
      map.addLayer({
        id: SRC_WATER, type: "raster", source: SRC_WATER,
        paint: { "raster-fade-duration": 0, "raster-resampling": "linear" },
      }, map.getLayer("city-building-shadow") ? "city-building-shadow" : undefined);
      paintWater();
    }
    if (!map.getSource(SRC_BLDG)) {
      map.addSource(SRC_BLDG, { type: "geojson", data: buildings });
      map.addLayer({
        id: SRC_BLDG, type: "fill-extrusion", source: SRC_BLDG, minzoom: 12,
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
    if (!on || !elev) return;
    const area = map.getSource(SRC_WATER) ? paintWater() : 0;
    // Recolouring 5,000 extrusions is the costly part. At ordinary tide levels
    // no building is reached before or after the change, so skip it.
    const st = stats(area);
    if (map.getLayer(SRC_BLDG) && (st.wet > 0 || lastWet !== 0)) {
      map.setPaintProperty(SRC_BLDG, "fill-extrusion-color", buildingColor());
    }
    lastWet = st.wet;
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
          : `Dry — ${fmt(p.w - level)} of margin`}</div>
        ${sheltered ? `<div style="color:#888">Sheltered: sea reaches it at ${fmt(p.w)}</div>` : ""}
      </div>`).addTo(map);
  });
  map.on("mouseenter", SRC_BLDG, () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", SRC_BLDG, () => { map.getCanvas().style.cursor = ""; });
  map.on("styledata", ensureLayers);

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
    /** Camera that shows the dataset, for a "take me there" on enable. */
    view() {
      const [w, s, e, n] = meta.bbox;
      return { center: [(w + e) / 2 + 0.012, (s + n) / 2 - 0.004], zoom: 14.6, pitch: 55, bearing: -10 };
    },
    contains(lngLat) {
      if (!meta) return false;
      const [w, s, e, n] = meta.bbox;
      return lngLat.lng > w && lngLat.lng < e && lngLat.lat > s && lngLat.lat < n;
    },
  };
}
