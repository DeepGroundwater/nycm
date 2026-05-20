"""
Pack POIs into the `tiles/pois.bin` binary format documented in the spec.

Header (24 bytes, little-endian):
  magic              : 4 bytes = "POI1"
  version            : u32 = 1
  walk_graph_version : u32
  n_pois             : u32
  names_off          : u32   (byte offset to NAMES section)
  reserved           : u32

Records: n_pois × 20 bytes, fixed stride. lon/lat as i32×1e7.
Names: variable-length UTF-8, no terminator. Records index by (name_off, name_len).
"""
from __future__ import annotations

import struct
from dataclasses import dataclass

MAGIC = b"POI1"
HEADER_FMT = "<4sIIIII"
HEADER_SIZE = struct.calcsize(HEADER_FMT)  # 24
RECORD_FMT = "<iiIIHBB"
RECORD_SIZE = struct.calcsize(RECORD_FMT)  # 20
MAX_NAME_LEN = 200
FLAG_UNNAMED = 0x01


@dataclass
class POI:
    lon: float
    lat: float
    walk_node: int
    category: int  # 1..10
    name: str = ""


def write_poi_blob(pois: list[POI], walk_graph_version: int) -> bytes:
    names_buf = bytearray()
    name_index: dict[str, tuple[int, int]] = {}

    def store_name(name: str) -> tuple[int, int]:
        if not name:
            return (0, 0)
        if name in name_index:
            return name_index[name]
        encoded = name.encode("utf-8")
        if len(encoded) > MAX_NAME_LEN:
            raise ValueError(f"name too long ({len(encoded)} bytes): {name!r}")
        off = len(names_buf)
        names_buf.extend(encoded)
        name_index[name] = (off, len(encoded))
        return (off, len(encoded))

    records = bytearray()
    for p in pois:
        off, n_len = store_name(p.name)
        flags = 0 if p.name else FLAG_UNNAMED
        records.extend(struct.pack(
            RECORD_FMT,
            int(round(p.lon * 1e7)),
            int(round(p.lat * 1e7)),
            p.walk_node,
            off,
            n_len,
            p.category,
            flags,
        ))

    names_off = HEADER_SIZE + len(records)
    header = struct.pack(
        HEADER_FMT,
        MAGIC,
        1,
        walk_graph_version,
        len(pois),
        names_off,
        0,
    )
    return bytes(header + records + names_buf)


def read_poi_header(blob: bytes) -> dict:
    magic, version, walk_graph_version, n_pois, names_off, _ = struct.unpack_from(
        HEADER_FMT, blob, 0
    )
    if magic != MAGIC:
        raise ValueError(f"bad magic: {magic!r}")
    return {
        "version": version,
        "walk_graph_version": walk_graph_version,
        "n_pois": n_pois,
        "names_off": names_off,
    }
