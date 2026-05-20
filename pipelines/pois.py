"""
Extract POIs from an OSM PBF and emit `pois.bin`.

    uv run python pipelines/pois.py <input.osm.pbf> <walk_graph.bin> <output.bin>

Pipeline:
  1. Pass 0 (ways): record way-node refs for ways with category tags.
  2. Pass 1 (nodes): resolve coords; emit standalone-node POIs immediately,
     and collect coords for way nodes we'll need for centroids.
  3. Compute way centroids (bbox center) for buffered ways.
  4. Pre-snap each POI to a walk-graph node in the LCC; drop unsnappable.
  5. Clip to bbox.
  6. Emit pois.bin (sorted by (category, name) for cache-friendly category scans).
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import osmium

from pipelines.poi_emit import POI, write_poi_blob
from pipelines.walk_graph_reader import WalkGraphReader


# Category code constants. Order = priority (lower wins on multi-tagged POIs).
CATEGORIES: dict[str, int] = {
    "food":       1,
    "transit":    2,
    "park":       3,
    "culture":    4,
    "attraction": 5,
    "shop":       6,
    "school":     7,
    "health":     8,
    "service":    9,
    "worship":    10,
}

SHOP_ALLOWED = {
    "supermarket", "convenience", "bakery", "books", "clothes",
    "department_store", "mall", "hardware",
}


def classify_tags(tags: dict[str, str]) -> int | None:
    """Map an OSM tag bundle to a category code; None if no category applies.
    Order matches the CATEGORIES dict: food > transit > park > culture >
    attraction > shop > school > health > service > worship.
    """
    amenity = tags.get("amenity")
    tourism = tags.get("tourism")
    leisure = tags.get("leisure")
    railway = tags.get("railway")
    pt = tags.get("public_transport")
    aeroway = tags.get("aeroway")
    shop = tags.get("shop")
    historic = tags.get("historic")

    if amenity in {"restaurant", "cafe", "bar", "fast_food", "pub",
                   "food_court", "ice_cream", "biergarten"}:
        return CATEGORIES["food"]
    if (railway in {"station", "halt", "tram_stop"}
            or pt == "station"
            or amenity == "ferry_terminal"
            or aeroway == "aerodrome"):
        return CATEGORIES["transit"]
    if leisure in {"park", "playground", "garden", "nature_reserve"}:
        return CATEGORIES["park"]
    if tourism in {"museum", "gallery"} or amenity in {"theatre", "cinema", "arts_centre", "library"}:
        return CATEGORIES["culture"]
    if tourism in {"attraction", "viewpoint", "zoo", "aquarium"} or historic:
        return CATEGORIES["attraction"]
    if shop in SHOP_ALLOWED:
        return CATEGORIES["shop"]
    if amenity in {"school", "university", "college"}:
        return CATEGORIES["school"]
    if amenity in {"hospital", "clinic", "pharmacy", "doctors"}:
        return CATEGORIES["health"]
    if amenity in {"post_office", "bank", "fuel", "police", "fire_station"}:
        return CATEGORIES["service"]
    if amenity == "place_of_worship":
        return CATEGORIES["worship"]
    return None


# Categories we KEEP even when name is missing (parks/playgrounds).
KEEP_UNNAMED_CATS = {CATEGORIES["park"]}


@dataclass
class _RawPOI:
    lon: float
    lat: float
    category: int
    name: str


class _WayCollector(osmium.SimpleHandler):
    """Pass 0: find category-tagged ways; record node refs + tags."""

    def __init__(self):
        super().__init__()
        self.way_tags: dict[int, dict[str, str]] = {}
        self.way_refs: dict[int, list[int]] = {}

    def way(self, w):
        tags = dict(w.tags)
        cat = classify_tags(tags)
        if cat is None:
            return
        name = tags.get("name", "")
        if not name and cat not in KEEP_UNNAMED_CATS:
            return
        self.way_tags[w.id] = tags
        self.way_refs[w.id] = [n.ref for n in w.nodes]


class _NodeCollector(osmium.SimpleHandler):
    """Pass 1: collect standalone POIs (node-tagged) + coords for way nodes."""

    def __init__(self, way_refs_flat: set[int]):
        super().__init__()
        self.way_refs_flat = way_refs_flat
        self.standalone: list[_RawPOI] = []
        self.way_node_coords: dict[int, tuple[float, float]] = {}

    def node(self, n):
        if n.id in self.way_refs_flat:
            self.way_node_coords[n.id] = (n.location.lon, n.location.lat)
        tags = dict(n.tags)
        cat = classify_tags(tags)
        if cat is None:
            return
        name = tags.get("name", "")
        if not name and cat not in KEEP_UNNAMED_CATS:
            return
        self.standalone.append(_RawPOI(n.location.lon, n.location.lat, cat, name))


def extract_pois(
    pbf_path: Path,
    bbox: tuple[float, float, float, float],
    walk_graph: WalkGraphReader | None = None,
):
    """Yield `POI` records from an OSM PBF. If `walk_graph` is None,
    walk_node = 0 (used by extraction-only tests)."""
    pbf_path = Path(pbf_path)
    min_lon, min_lat, max_lon, max_lat = bbox

    # Pass 0: ways.
    wc = _WayCollector()
    wc.apply_file(str(pbf_path))

    way_refs_flat: set[int] = set()
    for refs in wc.way_refs.values():
        way_refs_flat.update(refs)

    # Pass 1: standalone POIs + way-node coords.
    nc = _NodeCollector(way_refs_flat)
    nc.apply_file(str(pbf_path))

    # Compute centroids for ways.
    way_pois: list[_RawPOI] = []
    for way_id, tags in wc.way_tags.items():
        coords = [nc.way_node_coords.get(n) for n in wc.way_refs[way_id]]
        coords = [c for c in coords if c is not None]
        if not coords:
            continue
        lons, lats = zip(*coords)
        clon = (min(lons) + max(lons)) / 2
        clat = (min(lats) + max(lats)) / 2
        cat = classify_tags(tags)
        way_pois.append(_RawPOI(clon, clat, cat, tags.get("name", "")))

    all_raw = nc.standalone + way_pois

    for r in all_raw:
        if not (min_lon <= r.lon <= max_lon and min_lat <= r.lat <= max_lat):
            continue
        if walk_graph is None:
            walk_node = 0
        else:
            node = walk_graph.snap(r.lon, r.lat)
            if node is None or node not in walk_graph.lcc_nodes:
                node = walk_graph.snap_in_lcc(r.lon, r.lat, max_m=100.0)
            if node is None:
                continue
            walk_node = node
        yield POI(
            lon=r.lon, lat=r.lat, walk_node=walk_node,
            category=r.category, name=r.name,
        )


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print("usage: pois.py <input.osm.pbf> <walk_graph.bin> <output.bin>",
              file=sys.stderr)
        return 2
    pbf, wg, out = map(Path, argv[1:])

    walk = WalkGraphReader(wg.read_bytes())
    # scripts/bbox.env BASEMAP_BBOX = -74.30,40.49,-71.85,41.20
    bbox = (-74.30, 40.49, -71.85, 41.20)
    pois = list(extract_pois(pbf, bbox, walk))
    pois.sort(key=lambda p: (p.category, p.name))
    blob = write_poi_blob(pois, walk_graph_version=walk.version)
    out.write_bytes(blob)
    print(f"wrote {out} with {len(pois)} POIs ({len(blob)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
