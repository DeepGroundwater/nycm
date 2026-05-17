"""
Round-trip check: emit the tiny fixture, then call out to `cargo run --example
load_tiny_fixture` (a dev binary defined next) to confirm Rust deserializes it.
"""
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def test_fixture_loads_in_rust(tmp_path):
    out = tmp_path / "tiny_walk.bin"
    subprocess.run(
        ["python", str(REPO / "pipelines" / "build_tiny_fixture.py"), str(out)],
        check=True,
    )
    res = subprocess.run(
        ["cargo", "run", "--quiet", "--example", "load_tiny_fixture", str(out)],
        cwd=REPO / "nycm-router",
        check=True,
        capture_output=True,
        text=True,
    )
    assert "nodes=4" in res.stdout, res.stdout
    assert "edges=6" in res.stdout, res.stdout
