"""
Generate a tiny OSM PBF for testing walk_graph.py.

Uses pyosmium's SimpleWriter so we don't need the external osmium-tool CLI.
Topology:
   N1 -- N2 -- N3 -- N4 -- N5    (one chain via two ways, all highway=footway)
Way 100: N1 -> N2 -> N3
Way 101: N3 -> N4 -> N5
"""
from __future__ import annotations

import sys
from pathlib import Path

import osmium
import osmium.osm.mutable as m


def main(out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)

    nodes = [
        (1, -73.9904, 40.7359),
        (2, -73.9892, 40.7359),
        (3, -73.9880, 40.7359),
        (4, -73.9880, 40.7350),
        (5, -73.9880, 40.7341),
    ]
    ways = [
        (100, [1, 2, 3], {"highway": "footway"}),
        (101, [3, 4, 5], {"highway": "footway"}),
    ]

    writer = osmium.SimpleWriter(str(out), overwrite=True)
    try:
        for nid, lon, lat in nodes:
            writer.add_node(m.Node(
                id=nid,
                version=1,
                location=(lon, lat),
            ))
        for wid, ns, tags in ways:
            writer.add_way(m.Way(
                id=wid,
                version=1,
                nodes=ns,
                tags=tags,
            ))
    finally:
        writer.close()
    print(f"wrote {out}")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
