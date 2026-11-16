"""Join USGS 3DEP 1 m lidar elevation to building footprints, and pack the
terrain itself for in-browser flood mapping. Built to cover a county: the
lidar is streamed one tile at a time and the output is cut into map tiles.

Inputs
  - 3DEP 1 m DEM GeoTIFFs (bare earth, metres NAVD88, UTM), from
    https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects/<project>/TIFF/
  - the basemap PMTiles (building footprints and the coastline come from it)

Outputs, in the --out directory
  index.json               bounds, encoding, tile lists, regions and provenance
  dem-<x>-<y>.png          elevation tiles (TILE x TILE cells), Web-Mercator aligned
                             R,G = big-endian uint16 of round((elev_m + OFFSET) * 100);
                                   0 means sea / tidal water / no data
                             B   = sill: how far (in SILL_STEP_M steps) the water
                                   must rise ABOVE this cell's own ground before a
                                   path to the sea opens. 0 = floods as soon as the
                                   water tops the ground; >0 = sheltered hollow.
  bld-<x>-<y>.json         building footprints by the same tiles (GeoJSON), with
                             g  = median ground elevation under the footprint (m NAVD88)
                             lo = 10th-percentile ground (water excluded) within
                                  2 m of it — a stand-in for "lowest adjacent grade"
                             w  = water level at which the sea first reaches it
                                  (>= lo; higher when something shelters it)
                             h  = building height from OSM (m above ground), if any

Regions
  A region is a stretch of coast that answers to one tide gauge. For each,
  index.json carries the gauge and tide files the map should use there and a
  table of how many buildings the sea reaches at each level, so the map can
  report counts without loading every building.

Usage
  python pipelines/flood_elevation.py --dem lidar/*.tif \
      --bbox=-73.78,40.573,-73.42,40.915 --out data/flood/nassau --name "Nassau County, NY" \
      --region "south:South shore bays:-73.78,40.53,-73.42,40.76:data/hog-island-gauge.json:data/long-beach-tide.json" \
      --region "north:North shore:-73.78,40.76,-73.42,40.93:data/kings-point-gauge.json:data/kings-point-tide.json" \
      --source "USGS 3DEP 1 m, NY_LongIsland_A24 (lidar flown Mar-Apr 2024)"

Requires: rasterio numpy pillow shapely pmtiles mapbox-vector-tile scikit-image
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
from pathlib import Path

import mapbox_vector_tile
import numpy as np
import rasterio
from PIL import Image
from pmtiles.reader import MmapSource, Reader
from rasterio import features
from rasterio.transform import from_bounds
from rasterio.warp import Resampling, reproject, transform, transform_bounds
import shapely
from shapely.geometry import Polygon, mapping, shape
from skimage.morphology import reconstruction

OFFSET_M = 20.0          # stored value = (elevation + OFFSET) in centimetres
# Ground below this (m NAVD88) counts as permanent water rather than land.
# 3DEP hydro-flattens tidal water to the surface it saw on the day of the
# flight (about -0.5 to -0.6 m here), so there is no real ground below that:
# the threshold sits just above it. Everything higher — foreshore, salt marsh —
# is genuine lidar ground and is left to wet and dry with the tide.
SEA_BELOW_M = -0.3
SILL_STEP_M = 0.02       # resolution of the B-channel sill (max 5.1 m)
TILE = 1024              # cells per side of an output tile
NO_LIDAR_M = 600.0       # stand-in elevation for land with no lidar: above anything the map can flood
R_MERC = 6378137.0


def merc(lon: float, lat: float) -> tuple[float, float]:
    return (math.radians(lon) * R_MERC,
            math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * R_MERC)


class Lidar:
    """The 1 m DEM tiles, opened lazily. One tile is about 100 million cells,
    so a county never fits in memory at once: callers take them one by one."""

    def __init__(self, paths: list[str]):
        self.paths = sorted(paths)
        self.bounds = []
        for p in self.paths:
            with rasterio.open(p) as src:
                self.crs = src.crs
                self.bounds.append(src.bounds)

    def __len__(self):
        return len(self.paths)

    def read(self, i: int):
        """(array with NaN for no data, affine transform) for tile i."""
        with rasterio.open(self.paths[i]) as src:
            arr = src.read(1).astype("float32")
            arr[arr == src.nodata] = np.nan
            return arr, src.transform

    def index_of(self, x: float, y: float) -> int | None:
        """Which tile holds this point (native CRS), or None."""
        for i, b in enumerate(self.bounds):
            if b.left <= x < b.right and b.bottom <= y < b.top:
                return i
        return None


def encode_grid(elev, sea, fill):
    """Pack ground + sill into an (h, w, 3) uint8 array — see the module docstring.

    Decoding (js/flood.js): elev = q / 100 - OFFSET_M, reach = elev + B * SILL_STEP_M.
    """
    ground = np.where(sea, 0, elev)
    q = np.clip(np.round((ground + OFFSET_M) * 100), 1, 65535).astype("uint16")
    q[sea] = 0                      # 0 is reserved for sea; land is clipped to >= 1
    sill = np.clip(np.round((fill - ground) / SILL_STEP_M), 0, 255).astype("uint8")
    sill[sea] = 0
    rgb = np.zeros((*elev.shape, 3), dtype="uint8")
    rgb[..., 0] = q >> 8
    rgb[..., 1] = q & 255
    rgb[..., 2] = sill
    return rgb


def basemap_land(pmtiles_path: str, bbox, shape, dst_tf, z: int = 14):
    """Rasterise the basemap's own land polygons (`earth` layer) onto the grid.

    The lidar reaches further seaward than the map's coastline (it was flown
    near low tide), which would paint "flood" on what the map already draws as
    ocean. Clipping to the basemap's land keeps the two shorelines identical.
    """
    n = 2 ** z
    world = 2 * math.pi * R_MERC
    shapes = []
    with open(pmtiles_path, "rb") as f:
        reader = Reader(MmapSource(f))
        xs, ys = tile_range(bbox, z)
        for x in xs:
            for y in ys:
                raw = reader.get(z, x, y)
                if not raw:
                    continue
                if raw[:2] == b"\x1f\x8b":
                    raw = gzip.decompress(raw)
                layer = mapbox_vector_tile.decode(raw, default_options={"y_coord_down": True}).get("earth")
                if not layer:
                    continue
                ext = layer["extent"]

                def to_merc(a, x=x, y=y, ext=ext):
                    return np.column_stack(((x + a[:, 0] / ext) / n * world - world / 2,
                                            world / 2 - (y + a[:, 1] / ext) / n * world))

                for feat in layer["features"]:
                    geom = shape_of(feat["geometry"])
                    if geom is not None:
                        shapes.append(mapping(shapely.transform(geom, to_merc)))
    if not shapes:
        return np.ones(shape, dtype=bool)
    return features.rasterize(shapes, out_shape=shape, transform=dst_tf, fill=0, default_value=1,
                              all_touched=False, dtype="uint8").astype(bool)


def shape_of(geometry):
    if geometry["type"] not in ("Polygon", "MultiPolygon"):
        return None
    geom = shape(geometry)
    return geom if geom.is_valid else geom.buffer(0)


def build_grid(lidar: Lidar, bbox, cell_m: float, sea_below: float = SEA_BELOW_M, pmtiles_path: str | None = None):
    """Average the 1 m DEM onto a Web-Mercator grid, one lidar tile at a time.

    Returns (ground with NaN for sea, sea mask, connected-fill level, grid transform).
    """
    x0, y0 = merc(bbox[0], bbox[1])
    x1, y1 = merc(bbox[2], bbox[3])
    scale = math.cos(math.radians((bbox[1] + bbox[3]) / 2))   # mercator units per ground metre
    w = round((x1 - x0) * scale / cell_m)
    h = round((y1 - y0) * scale / cell_m)
    dst_tf = from_bounds(x0, y0, x1, y1, w, h)
    ground = np.full((h, w), np.nan, dtype="float32")
    land_share = np.full((h, w), np.nan, dtype="float32")

    for i in range(len(lidar)):
        dem, tf = lidar.read(i)
        # Where on the grid does this tile land? Work on that window only.
        left, bottom, right, top = transform_bounds(lidar.crs, "EPSG:3857", *lidar.bounds[i], densify_pts=21)
        c0, r0 = (int(math.floor(v)) for v in ~dst_tf * (left, top))
        c1, r1 = (int(math.ceil(v)) for v in ~dst_tf * (right, bottom))
        c0, r0, c1, r1 = max(c0 - 1, 0), max(r0 - 1, 0), min(c1 + 1, w), min(r1 + 1, h)
        if c1 <= c0 or r1 <= r0:
            continue
        win_tf = dst_tf * rasterio.Affine.translation(c0, r0)

        def to_grid(src):
            out = np.full((r1 - r0, c1 - c0), np.nan, dtype="float32")
            reproject(source=src, destination=out, src_transform=tf, src_crs=lidar.crs, src_nodata=np.nan,
                      dst_transform=win_tf, dst_crs="EPSG:3857", dst_nodata=np.nan, resampling=Resampling.average)
            return out

        # Average LAND ONLY. A cell on a canal edge is part yard, part water; a
        # plain average would drag the yard down toward the water surface and
        # make every bulkhead look half a metre lower than it is. So water is
        # masked out at 1 m first, and a cell counts as land when at least half
        # of it is land.
        covered = ~np.isnan(dem)
        water = ~covered | (dem < sea_below)
        g = to_grid(np.where(water, np.nan, dem))
        share = to_grid(np.where(covered, np.where(water, 0.0, 1.0), np.nan).astype("float32"))
        # Neighbouring lidar tiles overlap by a few metres: first one in wins.
        gw, sw = ground[r0:r1, c0:c1], land_share[r0:r1, c0:c1]
        np.copyto(gw, g, where=np.isnan(gw))
        np.copyto(sw, share, where=np.isnan(sw))
        del dem, water, covered

    # Sea = mostly water at 1 m, or anything the basemap itself draws as water.
    no_lidar = np.isnan(land_share)
    sea = ~no_lidar & ~(land_share >= 0.5)
    if pmtiles_path:
        land = basemap_land(pmtiles_path, bbox, ground.shape, dst_tf)
        sea |= ~land
        # Land the basemap knows but this lidar project does not cover (across a
        # county line, say) is UNKNOWN, not water. Calling it sea would let the
        # flood leak in from a coast that is not there; so it stands as a wall:
        # never flooded, never a path. Water that really arrives that way is missed.
        ground[no_lidar & land] = NO_LIDAR_M
    else:
        sea |= no_lidar
    fill = connected_fill(ground, sea)
    return np.where(sea, np.nan, ground), sea, np.where(sea, np.nan, fill), dst_tf


def write_tiles(ground, sea, fill, out_dir: Path, max_reach_m: float):
    """Cut the grid into TILE x TILE PNGs. A tile is kept when it holds open water
    or any land the sea could reach within the map's range; the rest of the
    county is high ground the map never needs."""
    h, w = ground.shape
    kept = []
    for ty in range(math.ceil(h / TILE)):
        for tx in range(math.ceil(w / TILE)):
            sl = np.s_[ty * TILE:(ty + 1) * TILE, tx * TILE:(tx + 1) * TILE]
            s_, f_ = sea[sl], fill[sl]
            if not (s_.any() or np.nanmin(np.where(s_, np.inf, f_), initial=np.inf) <= max_reach_m):
                continue
            rgb = np.zeros((TILE, TILE, 3), dtype="uint8")        # padding decodes as sea
            part = encode_grid(np.where(s_, 0, ground[sl]), s_, np.where(s_, 0, f_))
            rgb[:part.shape[0], :part.shape[1]] = part
            Image.fromarray(rgb, "RGB").save(out_dir / f"dem-{tx}-{ty}.png", optimize=True)
            kept.append([tx, ty])
    return kept


def connected_fill(elev, sea):
    """Lowest water level at which each cell is hydraulically connected to the sea.

    This is the classic depression fill: the minimum over all paths to the sea
    of the highest ground along the path. A plain "bathtub" floods every cell
    below the water level; this floods only those the water can actually reach.
    Morphological reconstruction by erosion computes it exactly.
    """
    ground = np.where(sea, -50.0, np.nan_to_num(elev, nan=-50.0)).astype("float32")
    seed = np.where(sea, -50.0, float(ground.max()) + 1).astype("float32")
    cross = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=bool)   # 4-connected: no diagonal leaks
    return reconstruction(seed, ground, method="erosion", footprint=cross)


def tile_range(bbox, z: int):
    n = 2 ** z

    def xy(lon, lat):
        return (int((lon + 180) / 360 * n),
                int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n))

    xa, ya = xy(bbox[0], bbox[3])
    xb, yb = xy(bbox[2], bbox[1])
    return range(xa, xb + 1), range(ya, yb + 1)


def footprints(pmtiles_path: str, bbox, z: int = 14):
    """Yield (polygon in lon/lat, properties) for every building footprint.

    The tiles merge many footprints into one multipolygon and repeat anything
    that crosses a tile edge in both tiles' buffers, so: explode, and keep a
    piece only in the tile that contains its centroid.
    """
    n = 2 ** z
    with open(pmtiles_path, "rb") as f:
        reader = Reader(MmapSource(f))
        xs, ys = tile_range(bbox, z)
        for x in xs:
            for y in ys:
                raw = reader.get(z, x, y)
                if not raw:
                    continue
                if raw[:2] == b"\x1f\x8b":
                    raw = gzip.decompress(raw)
                layer = mapbox_vector_tile.decode(raw, default_options={"y_coord_down": True}).get("buildings")
                if not layer:
                    continue
                ext = layer["extent"]

                def to_lonlat(px, py, _z=None, x=x, y=y, ext=ext):
                    lon = (x + np.asarray(px) / ext) / n * 360 - 180
                    lat = np.degrees(np.arctan(np.sinh(math.pi * (1 - 2 * (y + np.asarray(py) / ext) / n))))
                    return lon, lat

                for feat in layer["features"]:
                    props = feat["properties"]
                    # Footprints only; building parts sit inside them.
                    if props.get("kind") != "building":
                        continue
                    geom = shape(feat["geometry"])
                    if not geom.is_valid:
                        geom = geom.buffer(0)
                    for poly in getattr(geom, "geoms", [geom]):
                        if not isinstance(poly, Polygon) or poly.is_empty:
                            continue
                        c = poly.centroid
                        if not (0 <= c.x < ext and 0 <= c.y < ext):
                            continue
                        yield shapely.transform(poly, lambda a: np.column_stack(to_lonlat(a[:, 0], a[:, 1]))), props


def reprojector(src, dst):
    return lambda a: np.column_stack(transform(src, dst, a[:, 0], a[:, 1])[:2])


def building_elevations(lidar: Lidar, bbox, pmtiles_path: str, fill, fill_tf, pad_m: float = 0.4,
                        sea_below: float = SEA_BELOW_M):
    """Ground elevation and reach level for every footprint.

    Footprints are first sorted into the lidar tile that holds their centre, so
    each 1 m tile is loaded exactly once.
    """
    finv = ~fill_tf
    to_utm, to_ll, to_merc = (reprojector("EPSG:4326", lidar.crs), reprojector(lidar.crs, "EPSG:4326"),
                              reprojector(lidar.crs, "EPSG:3857"))
    buckets: dict[int, list] = {}
    skipped = 0
    for poly, props in footprints(pmtiles_path, bbox):
        c = poly.centroid
        if not (bbox[0] <= c.x <= bbox[2] and bbox[1] <= c.y <= bbox[3]):
            continue
        utm = shapely.transform(poly, to_utm)
        if utm.area < 12:                      # sheds, slivers left by tile clipping
            continue
        i = lidar.index_of(utm.centroid.x, utm.centroid.y)
        if i is None:
            skipped += 1
            continue
        buckets.setdefault(i, []).append((utm, props))

    out = []
    for i in sorted(buckets):
        dem, tf = lidar.read(i)
        inv = ~tf
        for utm, props in buckets[i]:
            ring = utm.buffer(2.0)
            minx, miny, maxx, maxy = ring.bounds
            c0, r0 = (int(v) for v in inv * (minx, maxy))
            c1, r1 = (int(math.ceil(v)) for v in inv * (maxx, miny))
            r0, c0 = max(r0, 0), max(c0, 0)
            win = dem[r0:r1, c0:c1]
            if win.size == 0:
                skipped += 1
                continue
            wtf = tf * rasterio.Affine.translation(c0, r0)
            inside = features.geometry_mask([mapping(utm)], win.shape, wtf, invert=True, all_touched=True)
            around = features.geometry_mask([mapping(ring)], win.shape, wtf, invert=True, all_touched=True)
            # Ground only: a waterfront building's surroundings include the canal
            # itself, and the flattened water surface is not grade.
            under = win[inside]
            under = under[~np.isnan(under) & (under >= sea_below)]
            near = win[around]
            near = near[~np.isnan(near) & (near >= sea_below)]
            if under.size < 4 or near.size < 4:
                skipped += 1
                continue
            # A whisker of padding so this copy fully encloses the basemap's own
            # extrusion of the same footprint (no z-fighting when both are drawn).
            padded = utm.buffer(pad_m, join_style=2)
            ll = shapely.transform(padded, to_ll)
            lo = float(np.percentile(near, 10))
            # When does the sea reach it? Lowest connected-fill level touching the
            # footprint's surroundings, on the coarser grid.
            mx0, my0, mx1, my1 = shapely.transform(ring, to_merc).bounds
            fc0, fr0 = (int(v) for v in finv * (mx0, my1))
            fc1, fr1 = (int(math.ceil(v)) for v in finv * (mx1, my0))
            fwin = fill[max(fr0, 0):fr1 + 1, max(fc0, 0):fc1 + 1]
            reach = float(np.nanmin(fwin)) if fwin.size and not np.all(np.isnan(fwin)) else lo
            p = {"g": round(float(np.median(under)), 2), "lo": round(lo, 2), "w": round(max(lo, reach), 2)}
            if props.get("height"):
                p["h"] = round(float(props["height"]), 1)
            centre = ll.centroid
            col, row = finv * merc(centre.x, centre.y)
            out.append({"type": "Feature", "properties": p,
                        "geometry": {"type": "Polygon",
                                     "coordinates": [[[round(x, 6), round(y, 6)] for x, y in r.coords]
                                                     for r in [ll.exterior, *ll.interiors]]},
                        "_tile": (int(col) // TILE, int(row) // TILE), "_at": (centre.x, centre.y)})
        del dem
    return out, skipped


def reach_table(levels_m):
    """How many buildings the sea reaches at each level: (sorted centimetres,
    cumulative count). The map uses it to report a count without the buildings."""
    cm = np.sort(np.round(np.asarray(levels_m) * 100).astype(int))
    uniq, counts = np.unique(cm, return_counts=True)
    return uniq.tolist(), np.cumsum(counts).tolist()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dem", nargs="+", required=True, help="3DEP 1 m GeoTIFF(s)")
    ap.add_argument("--bbox", required=True, help="minLon,minLat,maxLon,maxLat")
    ap.add_argument("--out", required=True, help="output directory, e.g. data/flood/nassau")
    ap.add_argument("--pmtiles", default="tiles/nyc-metro.pmtiles")
    ap.add_argument("--cell", type=float, default=4.0, help="grid cell size in ground metres")
    ap.add_argument("--sea-below", type=float, default=SEA_BELOW_M,
                    help="ground below this (m NAVD88) is treated as permanent water (the lidar's flattened water surface)")
    ap.add_argument("--max-ground", type=float, default=4.6,
                    help="leave out buildings and terrain tiles the sea cannot reach below this level (m NAVD88): "
                         "the map's slider tops out below it")
    ap.add_argument("--region", action="append", default=[],
                    help="id:name:minLon,minLat,maxLon,maxLat:gauge.json:tide.json — a stretch of coast and the gauge it answers to")
    ap.add_argument("--view", default=None,
                    help="camera for the map's 'take me there': lng,lat,zoom[,pitch[,bearing]]")
    ap.add_argument("--name", default="")
    ap.add_argument("--source", default="USGS 3DEP 1 m DEM")
    a = ap.parse_args()
    bbox = tuple(float(v) for v in a.bbox.split(","))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for old in [*out.glob("dem-*.png"), *out.glob("bld-*.json")]:
        old.unlink()

    lidar = Lidar(a.dem)
    ground, sea, fill, grid_tf = build_grid(lidar, bbox, a.cell, a.sea_below, a.pmtiles)
    dem_tiles = write_tiles(ground, sea, fill, out, a.max_ground)
    feats, skipped = building_elevations(lidar, bbox, a.pmtiles, fill, grid_tf, sea_below=a.sea_below)

    regions = []
    for spec in a.region:
        rid, name, box, gauge, tide = spec.split(":")
        rb = [float(v) for v in box.split(",")]
        inside = [f for f in feats if rb[0] <= f["_at"][0] < rb[2] and rb[1] <= f["_at"][1] < rb[3]]
        cm, count = reach_table([f["properties"]["w"] for f in inside if f["properties"]["w"] <= a.max_ground])
        regions.append({"id": rid, "name": name, "bbox": rb, "gauge": gauge, "tide": tide,
                        "buildings_total": len(inside), "reach_cm": cm, "reach_count": count})

    total = len(feats)
    by_tile: dict[tuple, list] = {}
    for f in feats:
        if f["properties"]["lo"] > a.max_ground:
            continue
        by_tile.setdefault(f.pop("_tile"), []).append({k: v for k, v in f.items() if not k.startswith("_")})
    bld_tiles = []
    for (tx, ty), fs in sorted(by_tile.items()):
        (out / f"bld-{tx}-{ty}.json").write_text(json.dumps({"type": "FeatureCollection", "features": fs}, separators=(",", ":")))
        bld_tiles.append([tx, ty, len(fs)])

    view = None
    if a.view:
        v = [float(x) for x in a.view.split(",")]
        view = {"center": v[:2], "zoom": v[2], "pitch": v[3] if len(v) > 3 else 0, "bearing": v[4] if len(v) > 4 else 0}
    h, w = ground.shape
    meta = {
        "name": a.name,
        "bbox": bbox,
        "dem": {"url": "dem-{x}-{y}.png", "width": w, "height": h, "cell_m": a.cell, "tile": TILE, "tiles": dem_tiles,
                "offset_m": OFFSET_M, "scale": 100, "sill_step_m": SILL_STEP_M, "sea_below_m": a.sea_below,
                "land_fraction": float((~sea).mean())},
        "buildings": {"url": "bld-{x}-{y}.json", "tiles": bld_tiles, "count": sum(t[2] for t in bld_tiles),
                      "count_total": total, "max_ground_m": a.max_ground},
        "regions": regions,
        **({"view": view} if view else {}),
        "vertical_datum": "NAVD88",
        "units": "m",
        "source": a.source,
    }
    (out / "index.json").write_text(json.dumps(meta, separators=(",", ":")))
    print(json.dumps({**meta, "regions": [{k: v for k, v in r.items() if not k.startswith("reach_")} for r in regions],
                      "dem": {**meta["dem"], "tiles": len(dem_tiles)},
                      "buildings": {**meta["buildings"], "tiles": len(bld_tiles)}}, indent=2))
    print(f"skipped {skipped} footprints with no DEM coverage")


if __name__ == "__main__":
    main()
