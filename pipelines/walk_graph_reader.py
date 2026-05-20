"""
Decode a walk_graph.bin produced by pipelines/walk_graph.py.

Binary layout (header + bincode body):
  magic              : 4 bytes = b"NWLK"
  version            : u32 LE
  nodes              : vec<(f64 lon, f64 lat)>
  adj_offsets        : vec<u32>   # CSR; len = n_nodes + 1
  edges              : vec<(u32 to, u32 seconds, u32 poly_start, u32 poly_end)>
  polylines          : vec<(f64 lon, f64 lat)>   (skipped here)
  snap_min_lon/lat   : f64, f64                  (skipped here)
  snap_cell_deg      : f64                       (skipped here)
  snap_cols/rows     : u32, u32                  (skipped here)
  snap_cell_offsets  : vec<u32>                  (skipped here)
  snap_cell_nodes    : vec<u32>                  (skipped here)

We rebuild a simple snap dict and LCC ourselves so the reader is self-
contained — useful when offline tools (pois.py) need a stable view of
which nodes are routable.
"""
from __future__ import annotations

import math
import struct


MAGIC = b"NWLK"
SNAP_CELL_DEG = 0.0025  # ~278 m at 40°N — local snap grid for our pre-snap


class _Cursor:
    __slots__ = ("buf", "off")

    def __init__(self, buf: bytes):
        self.buf = buf
        self.off = 0

    def take(self, fmt: str):
        size = struct.calcsize(fmt)
        vals = struct.unpack_from("<" + fmt, self.buf, self.off)
        self.off += size
        return vals

    def u32(self) -> int:
        (v,) = self.take("I")
        return v

    def u64(self) -> int:
        (v,) = self.take("Q")
        return v

    def f64(self) -> float:
        (v,) = self.take("d")
        return v

    def vec_lonlat(self) -> list[tuple[float, float]]:
        n = self.u64()
        # 2 f64 per item; unpack one big block for speed.
        size = 16 * n
        flat = struct.unpack_from(f"<{2*n}d", self.buf, self.off)
        self.off += size
        return list(zip(flat[0::2], flat[1::2]))

    def vec_u32(self) -> list[int]:
        n = self.u64()
        out = list(struct.unpack_from(f"<{n}I", self.buf, self.off))
        self.off += 4 * n
        return out

    def vec_walk_edge(self):
        n = self.u64()
        # 4 u32 per edge.
        flat = struct.unpack_from(f"<{4*n}I", self.buf, self.off)
        self.off += 16 * n
        return flat  # interleaved (to, sec, ps, pe, ...) — we only use `to`

    def skip_bytes(self, n: int):
        self.off += n


class WalkGraphReader:
    """Read-only view of a walk_graph.bin. Builds LCC + local snap on demand."""

    def __init__(self, blob: bytes):
        if blob[:4] != MAGIC:
            raise ValueError(f"bad magic: {blob[:4]!r} (expected {MAGIC!r})")
        cur = _Cursor(blob)
        cur.skip_bytes(4)            # magic
        self.version = cur.u32()
        self.nodes: list[tuple[float, float]] = cur.vec_lonlat()
        self.n_nodes = len(self.nodes)
        # adj_offsets is CSR; length = n_nodes + 1.
        self._adj_off: list[int] = cur.vec_u32()
        edges_flat = cur.vec_walk_edge()
        # Build a Python adjacency list keyed by source node.
        # edges_flat is (to, sec, ps, pe) repeating; we only need `to`.
        self._edge_to: list[int] = list(edges_flat[0::4])
        # (We ignore polylines + snap grid + everything after — pois.py
        # builds its own snap.)

        self._lcc: frozenset[int] | None = None
        self._snap_cells: dict[tuple[int, int], list[int]] | None = None

    # ---- adjacency (CSR access) -------------------------------------------

    def neighbors(self, u: int) -> list[int]:
        return self._edge_to[self._adj_off[u]:self._adj_off[u + 1]]

    # ---- largest connected component --------------------------------------

    @property
    def lcc_nodes(self) -> frozenset[int]:
        if self._lcc is None:
            self._lcc = self._compute_lcc()
        return self._lcc

    def _compute_lcc(self) -> frozenset[int]:
        visited = bytearray(self.n_nodes)
        best: set[int] = set()
        for start in range(self.n_nodes):
            if visited[start]:
                continue
            stack = [start]
            comp: set[int] = set()
            while stack:
                u = stack.pop()
                if visited[u]:
                    continue
                visited[u] = 1
                comp.add(u)
                for v in self.neighbors(u):
                    if not visited[v]:
                        stack.append(v)
            if len(comp) > len(best):
                best = comp
        return frozenset(best)

    # ---- local snap grid ---------------------------------------------------

    def _build_snap(self) -> None:
        cells: dict[tuple[int, int], list[int]] = {}
        for i, (lon, lat) in enumerate(self.nodes):
            key = (int(lon / SNAP_CELL_DEG), int(lat / SNAP_CELL_DEG))
            cells.setdefault(key, []).append(i)
        self._snap_cells = cells

    def snap(self, lon: float, lat: float) -> int | None:
        if self._snap_cells is None:
            self._build_snap()
        cx = int(lon / SNAP_CELL_DEG)
        cy = int(lat / SNAP_CELL_DEG)
        best_d = math.inf
        best_n: int | None = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for n in self._snap_cells.get((cx + dx, cy + dy), ()):
                    nlon, nlat = self.nodes[n]
                    d = self._dist_m(lon, lat, nlon, nlat)
                    if d < best_d:
                        best_d = d
                        best_n = n
        return best_n

    def snap_in_lcc(
        self, lon: float, lat: float, max_m: float = 100.0,
    ) -> int | None:
        if self._snap_cells is None:
            self._build_snap()
        lcc = self.lcc_nodes
        cx = int(lon / SNAP_CELL_DEG)
        cy = int(lat / SNAP_CELL_DEG)
        best_d = math.inf
        best_n: int | None = None
        # Widen the search radius a little — LCC misses can land further
        # than the immediate 3x3 cell ring.
        for dx in (-2, -1, 0, 1, 2):
            for dy in (-2, -1, 0, 1, 2):
                for n in self._snap_cells.get((cx + dx, cy + dy), ()):
                    if n not in lcc:
                        continue
                    nlon, nlat = self.nodes[n]
                    d = self._dist_m(lon, lat, nlon, nlat)
                    if d < best_d:
                        best_d = d
                        best_n = n
        return best_n if best_d <= max_m else None

    # ---- helpers ----------------------------------------------------------

    @staticmethod
    def _dist_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
        # Equirectangular; fine for our distances.
        dx = (lon2 - lon1) * 85_000
        dy = (lat2 - lat1) * 111_000
        return math.sqrt(dx * dx + dy * dy)
