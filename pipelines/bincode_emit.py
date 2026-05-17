"""
Minimal emitter for bincode 1.x default-config payloads.
Default config: little-endian, fixint length encoding (u64), no variable-length ints.
We only emit what nycm-router's WalkGraph layout needs.
"""
from __future__ import annotations

import struct
from io import BytesIO


class W:
    def __init__(self) -> None:
        self.buf = BytesIO()

    def bytes(self) -> bytes:
        return self.buf.getvalue()

    def u32(self, v: int) -> None:
        self.buf.write(struct.pack("<I", v))

    def u64(self, v: int) -> None:
        self.buf.write(struct.pack("<Q", v))

    def f64(self, v: float) -> None:
        self.buf.write(struct.pack("<d", v))

    def vec_u32(self, xs: list[int]) -> None:
        self.u64(len(xs))
        for x in xs:
            self.u32(x)

    def vec_f64(self, xs: list[float]) -> None:
        self.u64(len(xs))
        for x in xs:
            self.f64(x)

    def vec_lonlat(self, pts: list[tuple[float, float]]) -> None:
        self.u64(len(pts))
        for lon, lat in pts:
            self.f64(lon)
            self.f64(lat)

    def vec_walk_edge(self, edges: list[tuple[int, int, int, int]]) -> None:
        # (to, seconds, poly_start, poly_end)
        self.u64(len(edges))
        for to, sec, ps, pe in edges:
            self.u32(to)
            self.u32(sec)
            self.u32(ps)
            self.u32(pe)


def emit_walk_graph(
    nodes: list[tuple[float, float]],
    adj: list[int],
    edges: list[tuple[int, int, int, int]],
    polylines: list[tuple[float, float]],
    snap_min_lon: float,
    snap_min_lat: float,
    snap_cell_deg: float,
    snap_cols: int,
    snap_rows: int,
    snap_cell_offsets: list[int],
    snap_cell_nodes: list[int],
) -> bytes:
    w = W()
    w.vec_lonlat(nodes)
    w.vec_u32(adj)
    w.vec_walk_edge(edges)
    w.vec_lonlat(polylines)
    # SnapIndex
    w.f64(snap_min_lon)
    w.f64(snap_min_lat)
    w.f64(snap_cell_deg)
    w.u32(snap_cols)
    w.u32(snap_rows)
    w.vec_u32(snap_cell_offsets)
    w.vec_u32(snap_cell_nodes)
    return w.bytes()


WALK_MAGIC = b"NWLK"
WALK_VERSION = 1


def write_walk_blob(path: str, payload: bytes) -> None:
    header = WALK_MAGIC + struct.pack("<I", WALK_VERSION)
    with open(path, "wb") as f:
        f.write(header + payload)
