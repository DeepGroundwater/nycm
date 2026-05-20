from pathlib import Path

import pytest

from pipelines.walk_graph_reader import WalkGraphReader


REPO = Path(__file__).resolve().parents[2]


def test_reader_loads_real_walk_graph():
    bin_path = REPO / "tiles" / "walk_graph.bin"
    if not bin_path.exists():
        # Assemble from chunks if needed (CI / fresh checkout).
        chunks = sorted((REPO / "tiles").glob("walk-graph.part-*"))
        if not chunks:
            pytest.skip("walk_graph.bin and chunks both missing")
        bin_path.write_bytes(b"".join(p.read_bytes() for p in chunks))
    r = WalkGraphReader(bin_path.read_bytes())
    assert r.version == 1
    assert r.n_nodes > 100_000
    # Snap a street-adjacent point (14th & Park, NYC).
    node = r.snap(-73.9879, 40.7363)
    assert node is not None
    assert 0 <= node < r.n_nodes
    # Reachable from LCC.
    assert node in r.lcc_nodes
    # LCC should be the dominant component.
    assert len(r.lcc_nodes) > r.n_nodes // 2


def test_snap_in_lcc_returns_lcc_member():
    bin_path = REPO / "tiles" / "walk_graph.bin"
    if not bin_path.exists():
        pytest.skip("walk_graph.bin missing")
    r = WalkGraphReader(bin_path.read_bytes())
    node = r.snap_in_lcc(-73.9879, 40.7363, max_m=200.0)
    assert node is not None
    assert node in r.lcc_nodes


def test_snap_in_lcc_returns_none_when_too_far():
    bin_path = REPO / "tiles" / "walk_graph.bin"
    if not bin_path.exists():
        pytest.skip("walk_graph.bin missing")
    r = WalkGraphReader(bin_path.read_bytes())
    # Middle of the Atlantic — nothing within 100 m.
    assert r.snap_in_lcc(-65.0, 35.0, max_m=100.0) is None
