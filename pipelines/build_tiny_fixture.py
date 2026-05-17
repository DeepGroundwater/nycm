"""
Generate tests/fixtures/tiny_walk.bin: a 4-node walking graph around Union Sq
used by nycm-router's golden tests.

Layout:
    N0 ───── N1 ───── N2
                       │
                       │
                      N3

All edges ~100 m at NYC latitude. Walking speed 1.35 m/s → ~74 s/edge.
"""
from __future__ import annotations

import sys
from pathlib import Path

from bincode_emit import emit_walk_graph, write_walk_blob


def main(out_path: str) -> None:
    # Coordinates near Union Sq, NYC. ~100 m apart in cardinal directions.
    n0 = (-73.9904, 40.7359)
    n1 = (-73.9892, 40.7359)  # 100 m east of n0
    n2 = (-73.9880, 40.7359)  # 100 m east of n1
    n3 = (-73.9880, 40.7350)  # 100 m south of n2

    nodes = [n0, n1, n2, n3]

    # Edges, in adj order (one block per node).
    # Node 0: → 1
    # Node 1: → 0, → 2
    # Node 2: → 1, → 3
    # Node 3: → 2
    edges = [
        (1, 74, 0, 0),
        (0, 74, 0, 0),
        (2, 74, 0, 0),
        (1, 74, 0, 0),
        (3, 74, 0, 0),
        (2, 74, 0, 0),
    ]
    adj = [0, 1, 3, 5, 6]

    # Snap: one big cell covering everything.
    snap_min_lon = -73.9910
    snap_min_lat = 40.7345
    cell_deg = 0.01  # ~1.1 km, larger than the spread
    cols, rows = 1, 1
    cell_offsets = [0, 4]
    cell_nodes = [0, 1, 2, 3]

    payload = emit_walk_graph(
        nodes=nodes,
        adj=adj,
        edges=edges,
        polylines=[],
        snap_min_lon=snap_min_lon,
        snap_min_lat=snap_min_lat,
        snap_cell_deg=cell_deg,
        snap_cols=cols,
        snap_rows=rows,
        snap_cell_offsets=cell_offsets,
        snap_cell_nodes=cell_nodes,
    )
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    write_walk_blob(out_path, payload)
    print(f"wrote {out_path} ({len(payload) + 8} bytes)")


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "nycm-router/tests/fixtures/tiny_walk.bin"
    main(out)
