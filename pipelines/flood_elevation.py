"""Join USGS 3DEP 1 m lidar elevation to building footprints, and pack the
terrain itself for in-browser flood mapping.

Inputs
  - one or more 3DEP 1 m DEM GeoTIFFs (bare earth, metres NAVD88, UTM), from
    https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects/<project>/TIFF/
  - the basemap PMTiles (building footprints come from its z14 `buildings` layer)

Outputs (prefix = --out, e.g. data/long-beach)
  <prefix>-dem.png         elevation grid, Web-Mercator aligned
                             R,G = big-endian uint16 of round((elev_m + OFFSET) * 100);
                                   0 means sea / tidal water / no data
                             B   = sill: how far (in SILL_STEP_M steps) the water
                                   must rise ABOVE this cell's own ground before a
                                   path to the sea opens. 0 = floods as soon as the
                                   water tops the ground; >0 = sheltered hollow.
  <prefix>-buildings.geojson
                           one polygon per footprint, with
                             g  = median ground elevation under the footprint (m NAVD88)
                             lo = 5th-percentile ground within 2 m of it — a
                                  stand-in for "lowest adjacent grade"
                             w  = water level at which the sea first reaches it
                                  (>= lo; higher when something shelters it)
                             h  = building height from OSM (m above ground), if any
  <prefix>-flood.json      bounds, encoding and provenance for the two files above

Usage
  python pipelines/flood_elevation.py --dem a.tif b.tif \
      --bbox=-73.745,40.573,-73.572,40.613 --out data/long-beach \
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
from rasterio.merge import merge
from rasterio.transform import from_bounds
from rasterio.warp import Resampling, reproject, transform, transform_bounds
import shapely
from shapely.geometry import Polygon, mapping, shape
from skimage.morphology import reconstruction

OFFSET_M = 20.0          # stored value = (elevation + OFFSET) in centimetres
# Ground below this (m NAVD88) counts as tidal water rather than land: roughly
# mean high water on this coast. It folds in the hydro-flattened bay surface,
# the intertidal foreshore the lidar caught at low tide, and low salt marsh.
# Approximate — set --sea-below from the local tidal datum (NOAA VDatum).
SEA_BELOW_M = 0.5
SILL_STEP_M = 0.02       # resolution of the B-channel sill (max 5.1 m)
R_MERC = 6378137.0


def merc(lon: float, lat: float) -> tuple[float, float]:
    return (math.radians(lon) * R_MERC,
            math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * R_MERC)


def load_mosaic(paths: list[str], bbox: tuple[float, float, float, float]):
    """Mosaic the DEM tiles, cropped to the bbox (+ a margin), in their native CRS."""
    srcs = [rasterio.open(p) for p in paths]
    crs = srcs[0].crs
    nodata = srcs[0].nodata
    left, bottom, right, top = transform_bounds("EPSG:4326", crs, *bbox, densify_pts=21)
    arr, tf = merge(srcs, bounds=(left - 50, bottom - 50, right + 50, top + 50), nodata=nodata)
    for s in srcs:
        s.close()
    dem = arr[0]
    dem[dem == nodata] = np.nan
    return dem, tf, crs


def write_grid(dem, tf, crs, bbox, cell_m: float, out_png: Path, sea_below: float = SEA_BELOW_M):
    """Average the 1 m DEM onto a Web-Mercator grid and encode it as a PNG."""
    x0, y0 = merc(bbox[0], bbox[1])
    x1, y1 = merc(bbox[2], bbox[3])
    scale = math.cos(math.radians((bbox[1] + bbox[3]) / 2))   # mercator units per ground metre
    w = round((x1 - x0) * scale / cell_m)
    h = round((y1 - y0) * scale / cell_m)
    dst = np.full((h, w), np.nan, dtype="float32")
    dst_tf = from_bounds(x0, y0, x1, y1, w, h)
    reproject(
        source=dem, destination=dst,
        src_transform=tf, src_crs=crs, src_nodata=np.nan,
        dst_transform=dst_tf, dst_crs="EPSG:3857", dst_nodata=np.nan,
        resampling=Resampling.average,
    )
    # Sea = no data (open ocean) or ground below the tidal threshold.
    sea = np.isnan(dst) | (dst < sea_below)
    fill = connected_fill(dst, sea)
    q = np.clip(np.round((np.where(sea, 0, dst) + OFFSET_M) * 100), 1, 65535).astype("uint16")
    q[sea] = 0
    sill = np.clip(np.round((fill - np.where(sea, 0, dst)) / SILL_STEP_M), 0, 255).astype("uint8")
    sill[sea] = 0
    rgb = np.zeros((h, w, 3), dtype="uint8")
    rgb[..., 0] = q >> 8
    rgb[..., 1] = q & 255
    rgb[..., 2] = sill
    Image.fromarray(rgb, "RGB").save(out_png, optimize=True)
    info = {"width": w, "height": h, "cell_m": cell_m, "land_fraction": float((~sea).mean()),
            "sheltered_fraction_of_land": float((sill[~sea] > 5).mean())}
    return info, np.where(sea, np.nan, fill), dst_tf


def connected_fill(elev, sea):
    """Lowest water level at which each cell is hydraulically connected to the sea.

    This is the classic depression fill: the minimum over all paths to the sea
    of the highest ground along the path. A plain "bathtub" floods every cell
    below the water level; this floods only those the water can actually reach.
    Morphological reconstruction by erosion computes it exactly.
    """
    ground = np.where(sea, -50.0, elev).astype("float32")
    seed = np.where(sea, -50.0, float(np.nanmax(ground)) + 1).astype("float32")
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


def building_elevations(dem, tf, crs, bbox, pmtiles_path: str, fill, fill_tf, pad_m: float = 0.4):
    inv = ~tf
    finv = ~fill_tf
    to_utm, to_ll, to_merc = reprojector("EPSG:4326", crs), reprojector(crs, "EPSG:4326"), reprojector(crs, "EPSG:3857")
    out = []
    skipped = 0
    for poly, props in footprints(pmtiles_path, bbox):
        c = poly.centroid
        if not (bbox[0] <= c.x <= bbox[2] and bbox[1] <= c.y <= bbox[3]):
            continue
        utm = shapely.transform(poly, to_utm)
        if utm.area < 12:                      # sheds, slivers left by tile clipping
            continue
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
        under = win[inside]
        under = under[~np.isnan(under)]
        near = win[around]
        near = near[~np.isnan(near)]
        if under.size < 4 or near.size < 4:
            skipped += 1
            continue
        # A whisker of padding so this copy fully encloses the basemap's own
        # extrusion of the same footprint (no z-fighting when both are drawn).
        padded = utm.buffer(pad_m, join_style=2)
        ll = shapely.transform(padded, to_ll)
        lo = float(np.percentile(near, 5))
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
        out.append({"type": "Feature", "properties": p,
                    "geometry": {"type": "Polygon",
                                 "coordinates": [[[round(x, 6), round(y, 6)] for x, y in r.coords]
                                                 for r in [ll.exterior, *ll.interiors]]}})
    return out, skipped


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dem", nargs="+", required=True, help="3DEP 1 m GeoTIFF(s)")
    ap.add_argument("--bbox", required=True, help="minLon,minLat,maxLon,maxLat")
    ap.add_argument("--out", required=True, help="output prefix, e.g. data/long-beach")
    ap.add_argument("--pmtiles", default="tiles/nyc-metro.pmtiles")
    ap.add_argument("--cell", type=float, default=4.0, help="grid cell size in ground metres")
    ap.add_argument("--sea-below", type=float, default=SEA_BELOW_M,
                    help="ground below this (m NAVD88) is treated as tidal water, ~mean high water")
    ap.add_argument("--name", default="Long Beach, NY")
    ap.add_argument("--source", default="USGS 3DEP 1 m DEM")
    a = ap.parse_args()
    bbox = tuple(float(v) for v in a.bbox.split(","))
    prefix = Path(a.out)

    dem, tf, crs = load_mosaic(a.dem, bbox)
    grid, fill, fill_tf = write_grid(dem, tf, crs, bbox, a.cell, prefix.with_name(prefix.name + "-dem.png"), a.sea_below)
    feats, skipped = building_elevations(dem, tf, crs, bbox, a.pmtiles, fill, fill_tf)
    fc = {"type": "FeatureCollection", "features": feats}
    prefix.with_name(prefix.name + "-buildings.geojson").write_text(json.dumps(fc, separators=(",", ":")))

    lows = np.array([f["properties"]["lo"] for f in feats])
    reach = np.array([f["properties"]["w"] for f in feats])
    meta = {
        "name": a.name,
        "bbox": bbox,
        "dem": {"url": prefix.name + "-dem.png", **grid, "offset_m": OFFSET_M, "scale": 100,
                "sill_step_m": SILL_STEP_M, "sea_below_m": a.sea_below},
        "buildings": {"url": prefix.name + "-buildings.geojson", "count": len(feats),
                      "with_osm_height": sum("h" in f["properties"] for f in feats),
                      "sheltered": int((reach > lows + 0.1).sum()),
                      "lo_percentiles_m": {str(p): round(float(np.percentile(lows, p)), 2) for p in (5, 25, 50, 75, 95)}},
        "vertical_datum": "NAVD88",
        "units": "m",
        "source": a.source,
    }
    prefix.with_name(prefix.name + "-flood.json").write_text(json.dumps(meta, indent=2))
    print(json.dumps(meta, indent=2))
    print(f"skipped {skipped} footprints with no DEM coverage")


if __name__ == "__main__":
    main()
