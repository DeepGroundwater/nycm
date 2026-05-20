from pathlib import Path

import osmium
import osmium.osm.mutable as m
import pytest

from pipelines.pois import CATEGORIES, classify_tags, extract_pois


def _write_pbf(out: Path, items: list[tuple[int, float, float, dict]]):
    """items: list of (node_id, lon, lat, tags)"""
    out.parent.mkdir(parents=True, exist_ok=True)
    w = osmium.SimpleWriter(str(out), overwrite=True)
    try:
        for nid, lon, lat, tags in items:
            w.add_node(m.Node(id=nid, version=1, location=(lon, lat), tags=tags))
    finally:
        w.close()


def test_classify_tags_food():
    assert classify_tags({"amenity": "restaurant"}) == CATEGORIES["food"]
    assert classify_tags({"amenity": "cafe"}) == CATEGORIES["food"]


def test_classify_tags_school():
    assert classify_tags({"amenity": "school"}) == CATEGORIES["school"]


def test_classify_tags_park():
    assert classify_tags({"leisure": "park"}) == CATEGORIES["park"]


def test_classify_tags_returns_none_for_unmapped():
    assert classify_tags({"amenity": "bench"}) is None
    assert classify_tags({"foo": "bar"}) is None


def test_classify_tags_multi_picks_deterministically():
    # An entity tagged as both school and attraction should pick exactly one
    # category — implementation choice doesn't matter as long as it's deterministic.
    cat = classify_tags({"amenity": "school", "tourism": "attraction"})
    assert cat is not None
    assert cat in {CATEGORIES["school"], CATEGORIES["attraction"]}


def test_extract_pois_filters_unmapped_and_unnamed(tmp_path: Path):
    pbf = tmp_path / "mini.osm.pbf"
    _write_pbf(pbf, [
        (1, -74.0,  40.70, {"amenity": "restaurant", "name": "Joe's"}),
        (2, -74.0,  40.71, {"amenity": "restaurant"}),               # no name → dropped
        (3, -74.0,  40.72, {"amenity": "bench"}),                    # unmapped → dropped
        (4, -74.0,  40.73, {"leisure": "park"}),                     # unnamed park → kept
    ])
    pois = list(extract_pois(pbf, bbox=(-74.5, 40.5, -73.5, 41.0), walk_graph=None))
    names = [p.name for p in pois]
    assert "Joe's" in names
    assert "" in names                                                # unnamed park
    assert len(pois) == 2
    # Categories preserved correctly.
    by_name = {p.name: p for p in pois}
    assert by_name["Joe's"].category == CATEGORIES["food"]
    assert by_name[""].category == CATEGORIES["park"]


def test_extract_pois_clips_to_bbox(tmp_path: Path):
    pbf = tmp_path / "mini.osm.pbf"
    _write_pbf(pbf, [
        (1, -74.0, 40.7, {"amenity": "cafe", "name": "In"}),    # inside bbox
        (2, -90.0, 30.0, {"amenity": "cafe", "name": "Out"}),   # New Orleans — outside bbox
    ])
    pois = list(extract_pois(pbf, bbox=(-74.5, 40.5, -73.5, 41.0), walk_graph=None))
    assert [p.name for p in pois] == ["In"]
