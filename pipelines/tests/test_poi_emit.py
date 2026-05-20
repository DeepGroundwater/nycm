import struct

import pytest

from pipelines.poi_emit import POI, write_poi_blob, read_poi_header


def test_round_trip_three_pois():
    pois = [
        POI(lon=-74.0,  lat=40.7,  walk_node=0,  category=1, name="Joe's Pizza"),
        POI(lon=-73.99, lat=40.71, walk_node=5,  category=3, name="Central Park"),
        POI(lon=-73.95, lat=40.78, walk_node=9,  category=4, name=""),  # unnamed
    ]
    blob = write_poi_blob(pois, walk_graph_version=1)
    assert blob[:4] == b"POI1"
    header = read_poi_header(blob)
    assert header["version"] == 1
    assert header["walk_graph_version"] == 1
    assert header["n_pois"] == 3

    # Record 0 at offset 24.
    rec0 = struct.unpack_from("<iiIIHBB", blob, 24)
    lon_e7, lat_e7, walk_node, name_off, name_len, category, flags = rec0
    assert lon_e7 == -740_000_000
    assert lat_e7 == 407_000_000
    assert walk_node == 0
    assert category == 1
    assert flags == 0
    name = blob[header["names_off"] + name_off : header["names_off"] + name_off + name_len].decode()
    assert name == "Joe's Pizza"

    # Record 2 is unnamed.
    rec2 = struct.unpack_from("<iiIIHBB", blob, 24 + 2 * 20)
    flags2 = rec2[6]
    assert flags2 & 0x01 == 0x01


def test_dedupes_repeated_names():
    pois = [
        POI(lon=0, lat=0, walk_node=0, category=1, name="Joe's"),
        POI(lon=1, lat=1, walk_node=1, category=1, name="Joe's"),
    ]
    blob = write_poi_blob(pois, walk_graph_version=1)
    r0 = struct.unpack_from("<iiIIHBB", blob, 24)
    r1 = struct.unpack_from("<iiIIHBB", blob, 24 + 20)
    # Both records should point to the same names section offset.
    assert r0[3] == r1[3]   # name_off
    assert r0[4] == r1[4]   # name_len


def test_rejects_name_too_long():
    with pytest.raises(ValueError, match="name too long"):
        write_poi_blob(
            [POI(lon=0, lat=0, walk_node=0, category=1, name="x" * 201)],
            walk_graph_version=1,
        )
