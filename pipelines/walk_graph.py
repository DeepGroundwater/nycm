"""
Build a walking graph from an OSM PBF.

    uv run python pipelines/walk_graph.py <input.osm.pbf> <output.bin>

Walking-eligible: highway tag in {footway, path, sidewalk, pedestrian,
residential, living_street, service, unclassified, tertiary, secondary,
primary, trunk, cycleway, steps, track}. Excludes: motorway, motorway_link,
trunk_link (handled by deny-list), and any way with access=private/no.

Steps:
  1. Pass 1: collect node IDs touched by eligible ways.
  2. Pass 2: collect coordinates for those nodes.
  3. Build directed (undirected-as-two-directed) adjacency.
  4. Contract degree-2 chains (collapse interior nodes into polyline segments).
  5. Build flat-grid snap index (~250 m cells).
  6. Emit bincode blob.
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from pathlib import Path

import osmium

from bincode_emit import emit_walk_graph, write_walk_blob

WALK_SPEED = 1.35  # m/s

ALLOWED = {
    "footway", "path", "sidewalk", "pedestrian", "residential", "living_street",
    "service", "unclassified", "tertiary", "secondary", "primary", "trunk",
    "cycleway", "steps", "track",
}


def is_walkable(way) -> bool:
    hw = way.tags.get("highway")
    if hw is None or hw not in ALLOWED:
        return False
    if way.tags.get("access") in {"private", "no"}:
        return False
    return True


class WayCollector(osmium.SimpleHandler):
    """Pass 1: gather way → list of node refs for walkable ways."""

    def __init__(self) -> None:
        super().__init__()
        self.ways: list[list[int]] = []
        self.touched: set[int] = set()

    def way(self, w) -> None:
        if not is_walkable(w):
            return
        ns = [n.ref for n in w.nodes]
        if len(ns) < 2:
            return
        self.ways.append(ns)
        self.touched.update(ns)


class NodeCollector(osmium.SimpleHandler):
    """Pass 2: gather (lon, lat) for the touched node set."""

    def __init__(self, wanted: set[int]) -> None:
        super().__init__()
        self.wanted = wanted
        self.coords: dict[int, tuple[float, float]] = {}

    def node(self, n) -> None:
        if n.id in self.wanted:
            self.coords[n.id] = (n.location.lon, n.location.lat)


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    r = 6_371_000.0
    lon1, lat1 = a
    lon2, lat2 = b
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    la1 = math.radians(lat1)
    la2 = math.radians(lat2)
    h = math.sin(dlat / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def build_adj(
    ways: list[list[int]],
    coords: dict[int, tuple[float, float]],
) -> dict[int, list[tuple[int, float, list[tuple[float, float]]]]]:
    """
    Returns: osm_id → list of (neighbor_osm_id, distance_m, polyline_excluding_endpoints).
    Polyline is empty initially (no contraction yet).
    """
    adj: dict[int, list[tuple[int, float, list[tuple[float, float]]]]] = defaultdict(list)
    for ns in ways:
        for u, v in zip(ns, ns[1:]):
            if u not in coords or v not in coords:
                continue
            d = haversine_m(coords[u], coords[v])
            adj[u].append((v, d, []))
            adj[v].append((u, d, []))
    return adj


def contract_degree_2(
    adj: dict[int, list[tuple[int, float, list[tuple[float, float]]]]],
    coords: dict[int, tuple[float, float]],
) -> dict[int, list[tuple[int, float, list[tuple[float, float]]]]]:
    """Collapse chains: A — m1 — m2 — … — B where each interior is degree-2."""
    # Identify nodes to keep: degree != 2.
    keep = {n for n, es in adj.items() if len(es) != 2}
    new_adj: dict[int, list[tuple[int, float, list[tuple[float, float]]]]] = defaultdict(list)
    visited_edges: set[tuple[int, int]] = set()

    for start in keep:
        for nb, d, _poly in adj[start]:
            if (start, nb) in visited_edges:
                continue
            # Walk chain from start through nb until we hit another keep node.
            prev = start
            cur = nb
            total_d = d
            interior: list[tuple[float, float]] = []
            while cur not in keep:
                interior.append(coords[cur])
                # cur has exactly two neighbors; find the one that isn't prev.
                nxt = None
                for nb2, d2, _ in adj[cur]:
                    if nb2 != prev:
                        nxt = nb2
                        next_d = d2
                        break
                if nxt is None:
                    break  # degenerate dead-end
                prev = cur
                cur = nxt
                total_d += next_d
            new_adj[start].append((cur, total_d, interior))
            visited_edges.add((start, cur))
            # Reverse direction handled by the symmetric pass from `cur`.

    return new_adj


def build_snap(
    nodes: list[tuple[float, float]],
    cell_deg: float,
) -> tuple[float, float, int, int, list[int], list[int]]:
    if not nodes:
        return 0.0, 0.0, 0, 0, [0], []
    lons = [p[0] for p in nodes]
    lats = [p[1] for p in nodes]
    min_lon = min(lons) - cell_deg
    min_lat = min(lats) - cell_deg
    max_lon = max(lons) + cell_deg
    max_lat = max(lats) + cell_deg
    cols = int(math.ceil((max_lon - min_lon) / cell_deg))
    rows = int(math.ceil((max_lat - min_lat) / cell_deg))
    bins: dict[int, list[int]] = defaultdict(list)
    for idx, (lon, lat) in enumerate(nodes):
        c = int((lon - min_lon) / cell_deg)
        r = int((lat - min_lat) / cell_deg)
        c = max(0, min(cols - 1, c))
        r = max(0, min(rows - 1, r))
        bins[r * cols + c].append(idx)
    cell_offsets = [0]
    cell_nodes: list[int] = []
    for k in range(cols * rows):
        cell_nodes.extend(bins.get(k, []))
        cell_offsets.append(len(cell_nodes))
    return min_lon, min_lat, cols, rows, cell_offsets, cell_nodes


def main(in_pbf: str, out_bin: str) -> None:
    way_h = WayCollector()
    print(f"pass 1: scanning ways in {in_pbf}", file=sys.stderr)
    way_h.apply_file(in_pbf)
    print(f"  {len(way_h.ways)} walkable ways, {len(way_h.touched)} unique nodes", file=sys.stderr)

    node_h = NodeCollector(way_h.touched)
    print("pass 2: collecting node coordinates", file=sys.stderr)
    node_h.apply_file(in_pbf, locations=False)
    print(f"  {len(node_h.coords)} coordinates", file=sys.stderr)

    raw_adj = build_adj(way_h.ways, node_h.coords)
    print(f"raw graph: {len(raw_adj)} nodes", file=sys.stderr)

    contracted = contract_degree_2(raw_adj, node_h.coords)
    print(f"contracted: {len(contracted)} nodes", file=sys.stderr)

    # Densify osm_id → dense_idx.
    keep_ids = sorted(contracted.keys())
    id_to_idx = {osm_id: i for i, osm_id in enumerate(keep_ids)}
    nodes = [node_h.coords[osm_id] for osm_id in keep_ids]

    # Build CSR + polyline blob.
    adj_offsets: list[int] = [0]
    edges: list[tuple[int, int, int, int]] = []
    polylines: list[tuple[float, float]] = []
    for osm_id in keep_ids:
        for nb_id, dist_m, interior in contracted[osm_id]:
            if nb_id not in id_to_idx:
                continue
            poly_start = len(polylines)
            polylines.extend(interior)
            poly_end = len(polylines)
            seconds = max(1, int(round(dist_m / WALK_SPEED)))
            edges.append((id_to_idx[nb_id], seconds, poly_start, poly_end))
        adj_offsets.append(len(edges))

    print(f"emitting {len(nodes)} nodes, {len(edges)} edges, {len(polylines)} polyline pts",
          file=sys.stderr)

    cell_deg = 0.003  # ~250 m at NYC latitude
    min_lon, min_lat, cols, rows, cell_offsets, cell_nodes = build_snap(nodes, cell_deg)

    payload = emit_walk_graph(
        nodes=nodes,
        adj=adj_offsets,
        edges=edges,
        polylines=polylines,
        snap_min_lon=min_lon,
        snap_min_lat=min_lat,
        snap_cell_deg=cell_deg,
        snap_cols=cols,
        snap_rows=rows,
        snap_cell_offsets=cell_offsets,
        snap_cell_nodes=cell_nodes,
    )
    Path(out_bin).parent.mkdir(parents=True, exist_ok=True)
    write_walk_blob(out_bin, payload)
    print(f"wrote {out_bin} ({(len(payload) + 8) / 1e6:.1f} MB)", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: walk_graph.py <input.osm.pbf> <output.bin>", file=sys.stderr)
        sys.exit(2)
    main(sys.argv[1], sys.argv[2])
