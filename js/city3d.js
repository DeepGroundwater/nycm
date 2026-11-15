// "Detailed city" rendering — an experiment in getting the Apple Maps 3D look
// out of the same Protomaps tiles the flat basemap uses.
//
// Everything here is style + procedural geometry; no extra data is fetched:
//   - buildings   → fill-extrusion from the tiles' `height` / `min_height`
//   - roads       → widths in real metres, asphalt + sidewalk casing at high zoom
//   - markings    → dashed centre lines, zebra crossings, one-way arrows
//   - trees       → low-poly "lollipop" extrusions (see TREES below — procedural!)
//   - POIs        → coloured category badges with matching label colour
//   - atmosphere  → sky / horizon fog, soft directional light, contact shadows
//
// The module only transforms a layer list; it never touches the map's own state
// except through installTrees() / installBadges().

// ---- Metric widths -----------------------------------------------------------
// MapLibre uses 512px tiles, so at latitude φ one pixel at zoom z covers
// 78271.5 · cos φ / 2^z metres. NYC sits at φ ≈ 40.7°.
const PX_PER_M_Z20 = 1 / (78271.517 * Math.cos(40.7 * Math.PI / 180) / 2 ** 20);

// Line width that tracks a ground distance: exact from z14 up (base-2
// exponential == constant metres), with hand-tuned stops below so roads stay
// legible when zoomed out.
function metres(m, low = []) {
  return ["interpolate", ["exponential", 2], ["zoom"],
    ...low.flat(), 14, (m * PX_PER_M_Z20) / 64, 20, m * PX_PER_M_Z20];
}

// Carriageway width (m), sidewalk width per side (m), low-zoom stops.
const ROAD = {
  highway: { w: 16, side: 1.5, low: [[3, 0], [6, 1.1], [12, 1.6]] },
  major:   { w: 13, side: 3.2, low: [[6, 0], [12, 1.6]] },
  link:    { w: 7,  side: 1.2, low: [[12, 0], [13, 0.8]] },
  minor:   { w: 8,  side: 3.0, low: [[11, 0], [12.5, 0.5]] },
  service: { w: 4,  side: 0,   low: [[13, 0]] },
  path:    { w: 2.2, side: 0,  low: [] },
};

function roadClass(id) {
  if (!id.startsWith("roads_")) return null;
  if (/label|rail|runway|taxiway|pier/.test(id)) return null;
  if (id.includes("highway")) return "highway";
  if (id.includes("major")) return "major";
  if (id.includes("link")) return "link";
  if (id.includes("minor_service")) return "service";
  if (id.includes("minor")) return "minor";
  if (id.includes("other")) return "path";
  return null;
}

// ---- Colour helpers ----------------------------------------------------------
function rgb(hex) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function mix(a, b, t) {
  const A = rgb(a), B = rgb(b);
  const c = A.map((v, i) => Math.round(v + (B[i] - v) * t));
  return "#" + c.map(v => v.toString(16).padStart(2, "0")).join("");
}

// Fill in whatever a theme didn't specify from its base palette, so the five
// time-of-day themes get the 3D treatment without each needing a full spec.
export function detailPalette(theme, dark, overrides = {}) {
  const earth = theme.earth, wood = theme.wood_a, ink = dark ? "#ffffff" : "#000000";
  const up = dark ? "#ffffff" : "#ffffff";
  const base = {
    asphalt: null, asphaltMajor: null, asphaltHighway: null,   // null → keep theme road colours
    sidewalk: null, pedestrian: null,
    marking: mix(theme.minor_a, up, 0.6),
    roadText: null,
    wall: dark ? mix(theme.buildings, "#ffffff", 0.07) : mix(theme.buildings, "#000000", 0.03),
    wallTall: dark ? mix(theme.buildings, "#ffffff", 0.16) : mix(theme.buildings, "#ffffff", 0.35),
    shadow: dark ? "rgba(0,0,0,0.35)" : "rgba(40,30,20,0.16)",
    trunk: mix(wood, ink, dark ? 0.1 : 0.35),
    // canopy[tone][slice] — slices run bottom → top, lighter toward the crown.
    canopy: [0, 1, 2].map(tone => {
      const body = mix(wood, dark ? "#1f6b4a" : "#5fae58", 0.35 + tone * 0.12);
      return [0.22, 0.08, -0.06, -0.2].map(s => s >= 0 ? mix(body, "#000000", s) : mix(body, up, -s * (dark ? 0.6 : 1)));
    }),
    sky: mix(theme.water, earth, dark ? 0.15 : 0.55),
    horizon: mix(earth, up, dark ? 0.05 : 0.5),
    fog: mix(earth, up, dark ? 0.03 : 0.35),
  };
  return { ...base, ...overrides };
}

// ---- POI categories ----------------------------------------------------------
// Apple colours a POI's badge and its label the same hue, so category reads
// before the name does. `glyph` selects a pictogram in drawBadge().
export const POI_CATS = {
  food:    { color: "#f08c2e", kinds: ["restaurant", "cafe", "fast_food", "bar", "pub", "biergarten", "food_court", "ice_cream", "bakery"] },
  shop:    { color: "#f2b01e", kinds: ["supermarket", "mall", "department_store", "convenience", "clothes", "books", "electronics", "beauty", "marketplace"] },
  park:    { color: "#49b25c", kinds: ["park", "garden", "forest", "zoo", "beach", "nature_reserve", "national_park", "marina", "dog_park", "playground", "golf_course"] },
  culture: { color: "#e2559f", kinds: ["museum", "theatre", "attraction", "artwork", "arts_centre", "cinema", "library", "stadium", "gallery"] },
  transit: { color: "#2f80ed", kinds: ["station", "bus_station", "ferry_terminal", "aerodrome", "bus_stop", "airport"] },
  lodging: { color: "#8f6bdc", kinds: ["hotel", "hostel", "motel", "guest_house"] },
  school:  { color: "#a5764f", kinds: ["school", "university", "college", "kindergarten"] },
  health:  { color: "#e5484d", kinds: ["hospital", "doctors", "pharmacy", "clinic", "dentist"] },
  civic:   { color: "#7c8794", kinds: ["post_office", "police", "fire_station", "townhall", "courthouse", "place_of_worship", "embassy"] },
};
const ALL_POI_KINDS = Object.values(POI_CATS).flatMap(c => c.kinds);
const catExpr = (pick, fallback) => {
  const e = ["match", ["get", "kind"]];
  for (const [name, c] of Object.entries(POI_CATS)) e.push(c.kinds, pick(name, c));
  e.push(fallback);
  return e;
};

// ---- Layer transform ---------------------------------------------------------
/**
 * Turn the stock Protomaps layer list into the detailed-city variant.
 * @param {object[]} layers  output of layersWithPartialCustomTheme()
 * @param {object} d         detailPalette()
 * @param {object} theme     the flat theme (for label colours)
 * @param {string} source    vector source id
 * @param {boolean} dark
 */
export function cityLayers(layers, d, theme, source, dark) {
  const out = [];
  const firstSymbol = layers.findIndex(l => l.type === "symbol");
  const labelFont = ["Noto Sans Medium"];

  layers.forEach((layer, idx) => {
    // Ground markings go under every label. Volumes go after the street
    // names but before POI / place labels: MapLibre draws in layer order, so
    // buildings then hide the street names behind them, as they should.
    if (idx === firstSymbol) out.push(...markingLayers(d, source));
    const l = structuredClone(layer);
    const cls = roadClass(l.id);

    if (cls) {
      const r = ROAD[cls];
      const casing = l.id.includes("casing");
      l.paint = { ...l.paint };
      if (casing) {
        // The casing becomes the sidewalk: a band of real width either side.
        l.paint["line-gap-width"] = metres(r.w, r.low);
        if (r.side > 0) {
          l.paint["line-width"] = ["interpolate", ["exponential", 2], ["zoom"],
            12, 0, 13, 1, 15, 1, 20, r.side * PX_PER_M_Z20];
        }
        if (d.sidewalk && cls !== "highway") {
          l.paint["line-color"] = ["interpolate", ["linear"], ["zoom"], 14.5, l.paint["line-color"], 15.5, d.sidewalk];
        }
      } else {
        l.paint["line-width"] = metres(r.w, r.low);
        const asphalt = cls === "highway" ? d.asphaltHighway : cls === "major" || cls === "link" ? d.asphaltMajor : d.asphalt;
        if (cls === "path") {
          // Footpaths as solid paved ribbons rather than dashes — mapped
          // sidewalks then merge into the sidewalk band instead of fighting it.
          delete l.paint["line-dasharray"];
          if (d.path || d.sidewalk) l.paint["line-color"] = d.path || d.sidewalk;
        } else if (asphalt) {
          // Flat white roads zoomed out, asphalt once lanes would be visible.
          const from = l.id.includes("tunnels") ? mix(asphalt, theme.earth, 0.75) : l.paint["line-color"];
          const to = l.id.includes("tunnels") ? mix(asphalt, theme.earth, 0.6) : asphalt;
          l.paint["line-color"] = ["interpolate", ["linear"], ["zoom"], 14.5, flat(from), 15.5, to];
        }
      }
      if (!l.paint["line-dasharray"]) l.layout = { ...l.layout, "line-join": "round", "line-cap": casing ? "butt" : "round" };
    }

    // Plazas are often mapped on top of the park they sit in; keep them
    // translucent so the green underneath still reads.
    if (l.id === "landuse_pedestrian" && d.pedestrian) l.paint = { ...l.paint, "fill-color": d.pedestrian, "fill-opacity": 0.6 };

    if (l.id === "buildings") {
      // Flat footprints while zoomed out; they hand over to the extrusion.
      l.paint = { ...l.paint, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13.6, 0.55, 14.4, 0] };
      l.maxzoom = 14.5;
    }

    if (l.id === "roads_labels_minor" || l.id === "roads_labels_major") {
      const major = l.id.endsWith("major");
      l.layout = {
        ...l.layout,
        "text-font": labelFont,
        "text-size": ["interpolate", ["linear"], ["zoom"], 12, 10.5, 15, 11.5, 16, major ? 13 : 12, 19, major ? 17 : 15],
        "text-transform": ["step", ["zoom"], "none", 15.5, "uppercase"],
        "text-letter-spacing": ["interpolate", ["linear"], ["zoom"], 15, 0.02, 16, 0.1],
        "text-pitch-alignment": "map",
        "text-rotation-alignment": "map",
        "symbol-spacing": 320,
      };
      if (d.roadText) {
        // Painted-on-the-road look: light text, no contrasting halo.
        const asphalt = major ? d.asphaltMajor : d.asphalt;
        l.paint = {
          ...l.paint,
          "text-color": ["interpolate", ["linear"], ["zoom"], 15, l.paint["text-color"], 15.6, d.roadText],
          "text-halo-color": ["interpolate", ["linear"], ["zoom"], 15, l.paint["text-halo-color"], 15.6, asphalt],
          "text-halo-width": ["interpolate", ["linear"], ["zoom"], 15, 1, 15.6, 0.6],
        };
      }
    }

    if (l.id === "pois") {
      out.push(...volumeLayers(d, source), poiLayer(l, theme, source, dark));
      return;
    }
    out.push(l);
  });
  return out;
}

// A colour stop must be a literal or expression; the stock theme sometimes
// supplies a zoom-interpolated colour, which can't nest inside another
// zoom interpolation. Collapse those to their final stop.
function flat(c) {
  return Array.isArray(c) && c[0] === "interpolate" ? c[c.length - 1] : c;
}

function markingLayers(d, source) {
  const plain = ["all", ["!", ["has", "is_tunnel"]], ["!", ["has", "is_bridge"]]];
  return [
    {
      id: "city-centerline", type: "line", source, "source-layer": "roads", minzoom: 16,
      filter: [...plain, ["==", ["get", "kind"], "major_road"], ["!", ["has", "is_link"]]],
      layout: { "line-cap": "butt" },
      paint: {
        "line-color": d.marking,
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 16, 0, 16.6, 0.85],
        "line-width": ["interpolate", ["exponential", 2], ["zoom"], 16, 0.6, 20, 0.3 * PX_PER_M_Z20],
        "line-dasharray": [10, 10],   // 3 m dash, 3 m gap
      },
    },
    {
      // Zebra: OSM crossings run across the road, so dashing along them gives
      // stripes that lie parallel to traffic — the right way round.
      id: "city-crosswalk", type: "line", source, "source-layer": "roads", minzoom: 16.5,
      filter: ["all", ["==", ["get", "kind"], "path"], ["==", ["get", "kind_detail"], "crossing"]],
      layout: { "line-cap": "butt" },
      paint: {
        "line-color": d.marking,
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 16.5, 0, 17, 0.9],
        "line-width": metres(3),
        "line-dasharray": [0.17, 0.17],
      },
    },
    {
      id: "city-oneway", type: "symbol", source, "source-layer": "roads", minzoom: 16.5,
      filter: [...plain, ["==", ["get", "oneway"], "yes"], ["in", ["get", "kind"], ["literal", ["minor_road", "major_road"]]]],
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": ["interpolate", ["linear"], ["zoom"], 16.5, 140, 19, 320],
        "text-field": "\u2192",
        "text-font": ["Noto Sans Medium"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 16.5, 13, 19, 30],
        "text-keep-upright": false,          // must follow the direction of travel
        "text-rotation-alignment": "map",
        "text-pitch-alignment": "map",
        "text-padding": 6,
      },
      paint: { "text-color": d.marking, "text-opacity": ["interpolate", ["linear"], ["zoom"], 16.5, 0, 17, 0.8] },
    },
  ];
}

function volumeLayers(d, source) {
  const bfilter = ["in", ["get", "kind"], ["literal", ["building", "building_part"]]];
  // Shadows fall away from the light (see cityLight: sun in the south-west).
  const cast = m => ["interpolate", ["exponential", 2], ["zoom"],
    14, ["literal", [0.5 * m * PX_PER_M_Z20 / 64, -0.87 * m * PX_PER_M_Z20 / 64]],
    20, ["literal", [0.5 * m * PX_PER_M_Z20, -0.87 * m * PX_PER_M_Z20]]];
  const fade = ["interpolate", ["linear"], ["zoom"], 14, 0, 14.6, 1];
  return [
    {
      // Footprints only: building parts overlap them and would stack the alpha.
      id: "city-building-shadow", type: "fill", source, "source-layer": "buildings", minzoom: 14,
      filter: ["==", ["get", "kind"], "building"],
      paint: { "fill-color": d.shadow, "fill-opacity": fade, "fill-translate": cast(3.5), "fill-translate-anchor": "map" },
    },
    {
      id: "city-tree-shadow", type: "fill", source: "city-trees", minzoom: 15,
      filter: ["==", ["get", "part"], -1],
      paint: { "fill-color": d.shadow, "fill-translate": cast(1.2), "fill-translate-anchor": "map" },
    },
    {
      id: "city-buildings", type: "fill-extrusion", source, "source-layer": "buildings", minzoom: 14,
      filter: bfilter,
      paint: {
        "fill-extrusion-height": ["coalesce", ["get", "height"], 9],
        "fill-extrusion-base": ["coalesce", ["get", "min_height"], 0],
        // Taller = paler, so towers separate from the podium blocks around them.
        "fill-extrusion-color": ["interpolate", ["linear"], ["coalesce", ["get", "height"], 9], 0, d.wall, 120, d.wallTall],
        "fill-extrusion-opacity": fade,
        "fill-extrusion-vertical-gradient": false,   // the gradient turns walls muddy seen from above
      },
    },
    {
      id: "city-trees", type: "fill-extrusion", source: "city-trees", minzoom: 15,
      filter: [">=", ["get", "part"], 0],
      paint: {
        "fill-extrusion-height": ["get", "top"],
        "fill-extrusion-base": ["get", "base"],
        "fill-extrusion-color": ["case", ["==", ["get", "part"], 0], d.trunk,
          ["match", ["get", "tone"],
            0, ["match", ["get", "part"], 1, d.canopy[0][0], 2, d.canopy[0][1], 3, d.canopy[0][2], d.canopy[0][3]],
            1, ["match", ["get", "part"], 1, d.canopy[1][0], 2, d.canopy[1][1], 3, d.canopy[1][2], d.canopy[1][3]],
            ["match", ["get", "part"], 1, d.canopy[2][0], 2, d.canopy[2][1], 3, d.canopy[2][2], d.canopy[2][3]]]],
        "fill-extrusion-vertical-gradient": false,
      },
    },
  ];
}

function poiLayer(stock, theme, source, dark) {
  const halo = theme.city_label_halo;
  return {
    id: "pois", type: "symbol", source, "source-layer": "pois", minzoom: 13,
    filter: ["all",
      ["in", ["get", "kind"], ["literal", ALL_POI_KINDS]],
      // One zoom later than the tiles suggest: fewer, calmer labels.
      [">=", ["zoom"], ["+", ["get", "min_zoom"], 1]]],
    layout: {
      "symbol-sort-key": ["get", "min_zoom"],
      "icon-image": catExpr(name => `badge-${name}`, "badge-civic"),
      "icon-size": ["interpolate", ["linear"], ["zoom"], 13, 0.7, 16, 0.9, 18, 1],
      "text-field": stock.layout["text-field"],
      "text-font": ["Noto Sans Medium"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 13, 10.5, 16, 12, 18, 13.5],
      "text-variable-anchor": ["left", "right", "top", "bottom"],
      "text-radial-offset": 1.05,
      "text-justify": "auto",
      "text-max-width": 7,
      "text-optional": true,
      "icon-padding": 4,
    },
    paint: {
      "text-color": catExpr((_, c) => dark ? mix(c.color, "#ffffff", 0.35) : mix(c.color, "#000000", 0.18), theme.city_label),
      "text-halo-color": halo,
      "text-halo-width": 1.4,
    },
  };
}

// ---- Sky + light -------------------------------------------------------------
export function citySky(d) {
  return {
    "sky-color": d.sky,
    "horizon-color": d.horizon,
    "fog-color": d.fog,
    "sky-horizon-blend": 0.7,
    "horizon-fog-blend": 0.8,
    "fog-ground-blend": 0.55,   // haze starts just past mid-distance
    "atmosphere-blend": 0,
  };
}
// Low intensity keeps wall/roof contrast gentle (the "soft clay" look);
// azimuth 210° puts the sun in the south-west, matching the faux shadows.
export function cityLight() {
  return { anchor: "map", position: [1.4, 210, 40], color: "#ffffff", intensity: 0.3 };
}
export const emptyTrees = () => ({ type: "geojson", data: { type: "FeatureCollection", features: [] } });

// ---- POI badges --------------------------------------------------------------
const GLYPHS = {
  food(c) {      // fork + knife
    c.lineWidth = 2.4;
    line(c, 17, 12, 17, 32); line(c, 13.5, 12, 13.5, 18); line(c, 20.5, 12, 20.5, 18); line(c, 13.5, 18.5, 20.5, 18.5);
    c.beginPath(); c.moveTo(27, 32); c.lineTo(27, 12); c.quadraticCurveTo(32, 15, 31, 23); c.lineTo(27, 23); c.stroke();
  },
  shop(c) {      // bag
    c.fillRect(13.5, 18, 17, 14); c.lineWidth = 2.2;
    c.beginPath(); c.arc(22, 18, 4.5, Math.PI, 0); c.stroke();
  },
  park(c) {      // tree
    c.beginPath(); c.arc(22, 18, 8, 0, 7); c.fill(); c.fillRect(20.6, 22, 2.8, 11);
  },
  culture(c) {   // museum: pediment, columns, base
    c.beginPath(); c.moveTo(22, 10.5); c.lineTo(33, 17.5); c.lineTo(11, 17.5); c.closePath(); c.fill();
    for (const x of [13.5, 20.5, 27.5]) c.fillRect(x, 19.5, 3, 9);
    c.fillRect(11.5, 30, 21, 2.6);
  },
  transit(c) {   // train front
    round(c, 14, 10.5, 16, 19, 4); c.fill();
    c.globalCompositeOperation = "destination-out";
    c.fillRect(16.5, 13.5, 11, 6); c.beginPath(); c.arc(18, 24.5, 1.5, 0, 7); c.arc(26, 24.5, 1.5, 0, 7); c.fill();
    c.globalCompositeOperation = "source-over";
    c.lineWidth = 2.2; line(c, 17, 30.5, 14.5, 33.5); line(c, 27, 30.5, 29.5, 33.5);
  },
  lodging(c) {   // bed
    c.fillRect(11, 15, 2.6, 16); c.fillRect(11, 23.5, 22, 3.6); c.fillRect(30.4, 23.5, 2.6, 7.5);
    round(c, 19, 18, 13, 5, 2.4); c.fill(); c.beginPath(); c.arc(16, 20.5, 2.4, 0, 7); c.fill();
  },
  school(c) {    // open book
    c.beginPath(); c.moveTo(22, 15); c.quadraticCurveTo(16, 11.5, 11, 13.5); c.lineTo(11, 29); c.quadraticCurveTo(16, 27, 22, 30.5);
    c.quadraticCurveTo(28, 27, 33, 29); c.lineTo(33, 13.5); c.quadraticCurveTo(28, 11.5, 22, 15); c.fill();
    c.globalCompositeOperation = "destination-out"; c.fillRect(21.3, 15, 1.4, 15.5); c.globalCompositeOperation = "source-over";
  },
  health(c) { c.fillRect(19.2, 12, 5.6, 20); c.fillRect(12, 19.2, 20, 5.6); },
  civic(c) { c.beginPath(); c.arc(22, 22, 5.5, 0, 7); c.fill(); },
};
function line(c, x1, y1, x2, y2) { c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); }
function round(c, x, y, w, h, r) {
  c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}

function drawBadge(name) {
  const S = 44, cv = document.createElement("canvas");
  cv.width = cv.height = S;
  const c = cv.getContext("2d");
  // White pictogram on its own layer so "destination-out" cuts only the glyph.
  const g = document.createElement("canvas"); g.width = g.height = S;
  const gc = g.getContext("2d");
  gc.fillStyle = gc.strokeStyle = "#fff"; gc.lineCap = gc.lineJoin = "round";
  gc.translate(S / 2, S / 2); gc.scale(0.82, 0.82); gc.translate(-S / 2, -S / 2);
  (GLYPHS[name] || GLYPHS.civic)(gc);

  c.shadowColor = "rgba(0,0,0,0.28)"; c.shadowBlur = 3; c.shadowOffsetY = 1;
  c.fillStyle = "#fff"; c.beginPath(); c.arc(S / 2, S / 2, 19, 0, 7); c.fill();
  c.shadowColor = "transparent";
  c.fillStyle = POI_CATS[name]?.color || POI_CATS.civic.color;
  c.beginPath(); c.arc(S / 2, S / 2, 17, 0, 7); c.fill();
  c.drawImage(g, 0, 0);
  return c.getImageData(0, 0, S, S);
}

/** Supplies badge-* images on demand, so they survive every setStyle(). */
export function installBadges(map) {
  map.on("styleimagemissing", e => {
    if (!e.id.startsWith("badge-") || map.hasImage(e.id)) return;
    map.addImage(e.id, drawBadge(e.id.slice(6)), { pixelRatio: 2 });
  });
}

// ---- TREES -------------------------------------------------------------------
// The tiles carry no individual trees, so these are PROCEDURAL: scattered on a
// deterministic jittered grid inside park / wood polygons, and planted along
// street edges. They show "this is green / this is a tree-lined street", not
// surveyed positions. Swap in real points (e.g. the NYC Street Tree Census)
// by feeding them to treeFeatures() instead of scatter().
const KX = 111320 * Math.cos(40.75 * Math.PI / 180);   // metres per degree lon
const KY = 111132;                                       // metres per degree lat

const GREEN = { wood: 0.9, forest: 0.9, nature_reserve: 0.7, park: 0.42, garden: 0.5, national_park: 0.6, cemetery: 0.22, village_green: 0.35 };
const NO_TREES = new Set(["pitch", "playground", "platform", "pier", "aerodrome", "runway", "taxiway", "railway", "dog_park", "beach"]);
const HALF = { highway: 9, major_road: 6.5, minor_road: 4, other: 3, path: 1.2, rail: 3 };

function hash(i, j, k) {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263) ^ Math.imul(k | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

class Grid {
  constructor(cell) { this.cell = cell; this.m = new Map(); }
  add(x0, y0, x1, y1, item) {
    const c = this.cell;
    for (let i = Math.floor(x0 / c); i <= Math.floor(x1 / c); i++)
      for (let j = Math.floor(y0 / c); j <= Math.floor(y1 / c); j++) {
        const k = i + "," + j; let a = this.m.get(k); if (!a) this.m.set(k, a = []); a.push(item);
      }
  }
  at(x, y) { return this.m.get(Math.floor(x / this.cell) + "," + Math.floor(y / this.cell)) || []; }
}

function inRings(rings, x, y) {
  let inside = false;
  for (const r of rings)
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  return inside;
}
function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

const toM = c => [c[0] * KX, c[1] * KY];
function polys(f) {
  const g = f.geometry;
  const list = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  return list.map(p => p.map(r => r.map(toM)));
}
function lines(f) {
  const g = f.geometry;
  const list = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
  return list.map(l => l.map(toM));
}

function scatter(map, source, cx, cy, R, limit) {
  const q = (layer) => map.querySourceFeatures(source, { sourceLayer: layer });
  const near = (x0, y0, x1, y1) => x1 > cx - R && x0 < cx + R && y1 > cy - R && y0 < cy + R;
  const bbox = rings => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of rings[0]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return [x0, y0, x1, y1];
  };

  const green = new Grid(96), block = new Grid(48), roads = new Grid(24);
  const addPoly = (grid, f, item) => {
    for (const rings of polys(f)) {
      const b = bbox(rings);
      if (near(...b)) grid.add(...b, { rings, ...item });
    }
  };
  for (const f of q("landuse")) {
    const k = f.properties.kind;
    if (GREEN[k]) addPoly(green, f, { density: GREEN[k] });
    else if (NO_TREES.has(k)) addPoly(block, f, {});
  }
  for (const f of q("water")) addPoly(block, f, {});
  for (const f of q("buildings")) addPoly(block, f, {});

  const streets = [];
  for (const f of q("roads")) {
    const p = f.properties, half = HALF[p.kind];
    // Mapped sidewalks / crossings run exactly where street trees stand.
    if (!half || p.kind_detail === "sidewalk" || p.kind_detail === "crossing") continue;
    for (const l of lines(f)) {
      let hit = false;
      for (let i = 1; i < l.length; i++) {
        const [ax, ay] = l[i - 1], [bx, by] = l[i];
        if (!near(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by))) continue;
        hit = true;
        roads.add(Math.min(ax, bx) - 12, Math.min(ay, by) - 12, Math.max(ax, bx) + 12, Math.max(ay, by) + 12, [ax, ay, bx, by, half]);
      }
      const lined = (p.kind === "minor_road" && p.kind_detail !== "service") || (p.kind === "major_road" && !p.is_link);
      if (hit && lined && !p.is_tunnel && !p.is_bridge) streets.push({ l, half });
    }
  }

  const clear = (x, y, margin) => {
    for (const s of roads.at(x, y)) { const r = s[4] + margin; if (segDist2(x, y, s[0], s[1], s[2], s[3]) < r * r) return false; }
    for (const b of block.at(x, y)) if (inRings(b.rings, x, y)) return false;
    return true;
  };

  const trees = [], taken = new Set();
  const plant = (x, y, big) => {
    const d2 = (x - cx) ** 2 + (y - cy) ** 2;
    if (d2 > R * R) return;
    const k = Math.round(x / 5) + "," + Math.round(y / 5);
    if (taken.has(k)) return;
    taken.add(k);
    trees.push({ x, y, d2, big });
  };

  // Parks and woods: jittered global grid, so trees never move as you pan.
  const S = 13;
  for (let i = Math.floor((cx - R) / S); i <= Math.ceil((cx + R) / S); i++)
    for (let j = Math.floor((cy - R) / S); j <= Math.ceil((cy + R) / S); j++) {
      const x = (i + 0.15 + 0.7 * hash(i, j, 1)) * S, y = (j + 0.15 + 0.7 * hash(i, j, 2)) * S;
      let density = 0;
      for (const g of green.at(x, y)) if (g.density > density && inRings(g.rings, x, y)) density = g.density;
      if (hash(i, j, 3) >= density) continue;
      if (clear(x, y, 2)) plant(x, y, hash(i, j, 4) < density);
    }

  // Street trees: both kerbs, ~every 13 m, with gaps. The "clear" test drops
  // any that would land in a cross street, a building, or water.
  for (const { l, half } of streets) {
    let carry = 6;
    for (let i = 1; i < l.length; i++) {
      const [ax, ay] = l[i - 1], [bx, by] = l[i];
      const len = Math.hypot(bx - ax, by - ay);
      if (!len) continue;
      const ux = (bx - ax) / len, uy = (by - ay) / len;
      let s = carry;
      for (; s < len; s += 13) {
        const mx = ax + ux * s, my = ay + uy * s;
        for (const side of [1, -1]) {
          const x = mx - uy * side * (half + 2.1), y = my + ux * side * (half + 2.1);
          const ix = Math.round(x / 3), iy = Math.round(y / 3);
          if (hash(ix, iy, 5) > 0.62) continue;
          if (clear(x, y, 1)) plant(x, y, false);
        }
      }
      carry = s - len;
    }
  }

  trees.sort((a, b) => a.d2 - b.d2);
  return trees.slice(0, limit);
}

// Unit octagon; each tree gets its own rotation so rows don't look stamped.
function ring(x, y, r, rot) {
  const out = [];
  for (let k = 0; k <= 8; k++) {
    const a = rot + (k % 8) * Math.PI / 4;
    out.push([(x + r * Math.cos(a)) / KX, (y + r * Math.sin(a)) / KY]);
  }
  return out;
}
// Canopy as four stacked slices approximating a sphere: [radius factor, base, top] of height.
const SLICES = [[0.66, 0.30, 0.46], [0.98, 0.46, 0.66], [0.94, 0.66, 0.84], [0.6, 0.84, 1.0]];

export function treeFeatures(trees) {
  const features = [];
  const poly = (coords, properties) => features.push({ type: "Feature", properties, geometry: { type: "Polygon", coordinates: [coords] } });
  for (const t of trees) {
    const ix = Math.round(t.x), iy = Math.round(t.y);
    const size = 0.75 + 0.5 * hash(ix, iy, 7) + (t.big ? 0.25 : 0);
    const H = 8.5 * size, R = 3.1 * size, rot = hash(ix, iy, 8) * Math.PI / 4;
    const tone = Math.floor(hash(ix, iy, 9) * 3);
    poly(ring(t.x, t.y, R * 0.8, rot), { part: -1 });
    poly(ring(t.x, t.y, 0.28 * size, rot), { part: 0, base: 0, top: H * 0.34 });
    SLICES.forEach(([f, b, top], n) => poly(ring(t.x, t.y, R * f, rot), { part: n + 1, tone, base: H * b, top: H * top }));
  }
  return { type: "FeatureCollection", features };
}

/**
 * Keeps the "city-trees" source populated around the camera.
 * Returns { invalidate() } — call after a style swap, which resets the source.
 */
export function installTrees(map, { source = "protomaps", minZoom = 15.3, radius = 950, limit = 4200 } = {}) {
  let key = null;
  const EMPTY = { type: "FeatureCollection", features: [] };
  function update() {
    const src = map.getSource("city-trees");
    if (!src) return;
    const z = map.getZoom();
    if (z < minZoom) {
      if (key !== "empty") { src.setData(EMPTY); key = "empty"; }
      return;
    }
    // Recompute only after moving a real distance; the scatter is stable anyway.
    const c = map.getCenter(), cx = c.lng * KX, cy = c.lat * KY;
    const k = Math.round(cx / 150) + ":" + Math.round(cy / 150);
    if (k === key) return;
    key = k;
    src.setData(treeFeatures(scatter(map, source, cx, cy, radius, limit)));
  }
  map.on("idle", update);
  return { invalidate() { key = null; } };
}
