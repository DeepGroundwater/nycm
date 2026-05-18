"""End-to-end test for walk_graph.py against a tiny PBF."""
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def test_pipeline_produces_loadable_blob(tmp_path):
    pbf = tmp_path / "mini.osm.pbf"
    subprocess.run(
        [sys.executable, str(REPO / "pipelines" / "tests" / "build_mini_pbf.py"), str(pbf)],
        check=True,
    )
    out_bin = tmp_path / "mini_walk.bin"
    subprocess.run(
        [sys.executable, str(REPO / "pipelines" / "walk_graph.py"), str(pbf), str(out_bin)],
        check=True,
    )
    assert out_bin.exists() and out_bin.stat().st_size > 8

    # Confirm Rust loader accepts it.
    res = subprocess.run(
        ["cargo", "run", "--quiet", "--example", "load_tiny_fixture", str(out_bin)],
        cwd=REPO / "nycm-router",
        check=True,
        capture_output=True,
        text=True,
    )
    # After contraction: node #3 has degree 2 (one neighbor in each way, {2, 4}),
    # so it's collapsed. Nodes #2 and #4 are also degree-2 interior, so also collapsed.
    # Survivors: #1 and #5 (each degree 1), one undirected edge between them with
    # interior polyline = [n2, n3, n4]. Output: 2 nodes, 2 directed edges.
    assert "nodes=2" in res.stdout, res.stdout
    assert "edges=2" in res.stdout, res.stdout
