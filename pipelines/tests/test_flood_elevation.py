"""Checks on the flood maths in pipelines/flood_elevation.py.

Needs the optional `flood` extra (rasterio, scikit-image, ...); skipped without it.
"""
import pytest

# Every third-party import goes through importorskip: CI installs only the
# `dev` extra, and a bare `import numpy` would fail collection for the whole run.
np = pytest.importorskip("numpy")
pytest.importorskip("rasterio")
pytest.importorskip("skimage")

from pipelines.flood_elevation import (NEVER_CM, OFFSET_M, SEA_CM, SILL_STEP_M, connected_fill,  # noqa: E402
                                        connected_fill_cm, encode_grid)


def decode(rgb):
    """Mirror of decodeGrid() in js/flood.js."""
    q = (rgb[..., 0].astype(int) << 8) | rgb[..., 1]
    elev = np.where(q == 0, np.nan, q / 100 - OFFSET_M)
    return elev, elev + rgb[..., 2] * SILL_STEP_M


def brute_force_fill(ground, sea):
    """Minimax path to the sea by relaxation — slow, obviously correct."""
    fill = np.where(sea, -np.inf, np.inf)
    h, w = ground.shape
    changed = True
    while changed:
        changed = False
        for r in range(h):
            for c in range(w):
                if sea[r, c]:
                    continue
                best = min((fill[rr, cc] for rr, cc in ((r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1))
                            if 0 <= rr < h and 0 <= cc < w), default=np.inf)
                v = max(ground[r, c], best)
                if v < fill[r, c]:
                    fill[r, c] = v
                    changed = True
    return fill


def test_fill_matches_brute_force_on_random_terrain():
    rng = np.random.default_rng(7)
    for _ in range(20):
        ground = rng.uniform(0.6, 5.0, size=(12, 15)).astype("float32")
        sea = np.zeros_like(ground, dtype=bool)
        sea[:, 0] = True                      # sea along the west edge
        sea[rng.integers(0, 12), rng.integers(1, 15)] = True
        got = connected_fill(ground, sea)
        want = brute_force_fill(ground, sea)
        assert np.allclose(got[~sea], want[~sea], atol=1e-5)


def test_fill_never_below_ground():
    rng = np.random.default_rng(1)
    ground = rng.uniform(0.6, 4.0, size=(30, 30)).astype("float32")
    sea = np.zeros_like(ground, dtype=bool)
    sea[0, :] = True
    assert (connected_fill(ground, sea)[~sea] >= ground[~sea] - 1e-6).all()


def test_hollow_behind_a_wall_floods_only_when_the_wall_is_topped():
    # sea | 1 m beach | 3 m wall | 1 m hollow
    ground = np.array([[0.0, 1.0, 3.0, 1.0]] * 3, dtype="float32")
    sea = np.zeros_like(ground, dtype=bool)
    sea[:, 0] = True
    fill = connected_fill(ground, sea)
    assert np.allclose(fill[:, 1], 1.0)       # beach: floods at its own level
    assert np.allclose(fill[:, 2], 3.0)
    assert np.allclose(fill[:, 3], 3.0)       # hollow: 1 m ground, but needs 3 m of water


def test_no_diagonal_leak():
    # The only gap in the wall is diagonal; 4-connected water must not pass.
    ground = np.array([[0.0, 9.0, 1.0],
                       [9.0, 1.0, 1.0],
                       [9.0, 1.0, 1.0]], dtype="float32")
    sea = np.zeros_like(ground, dtype=bool)
    sea[0, 0] = True
    assert connected_fill(ground, sea)[1, 1] == pytest.approx(9.0)


def test_encoding_round_trip_within_half_a_centimetre():
    rng = np.random.default_rng(3)
    elev = rng.uniform(-19.9, 60.0, size=(40, 40)).astype("float64")
    sea = rng.random(elev.shape) < 0.2
    fill = elev + rng.uniform(0, 5.0, size=elev.shape)
    got_elev, got_reach = decode(encode_grid(elev, sea, fill))
    assert np.isnan(got_elev[sea]).all()
    assert not np.isnan(got_elev[~sea]).any()                      # land never collides with the sea code
    assert np.abs(got_elev[~sea] - elev[~sea]).max() <= 0.005 + 1e-9
    assert (got_reach[~sea] >= got_elev[~sea]).all()
    assert np.abs(got_reach[~sea] - fill[~sea]).max() <= 0.005 + SILL_STEP_M / 2 + 1e-9


def test_sill_saturates_rather_than_wrapping():
    elev = np.array([[1.0]])
    rgb = encode_grid(elev, np.array([[False]]), elev + 40.0)
    assert rgb[0, 0, 2] == 255


def test_bucket_flood_matches_the_morphological_fill_in_centimetres():
    """The big-grid algorithm must give the same levels as the reference one."""
    pytest.importorskip("numba")
    rng = np.random.default_rng(11)
    for _ in range(10):
        cm = rng.integers(60, 500, size=(40, 50)).astype("int16")
        sea = np.zeros(cm.shape, dtype=bool)
        sea[:, 0] = True
        sea[rng.integers(0, 40, 6), rng.integers(1, 50, 6)] = True
        want = np.rint(connected_fill(cm / 100.0, sea) * 100).astype(int)
        elev = cm.copy()
        elev[sea] = SEA_CM
        got = connected_fill_cm(elev, 700)
        assert (got[sea] == SEA_CM).all()
        assert (got[~sea] == want[~sea]).all()


def test_bucket_flood_leaves_high_ground_and_sealed_hollows_alone():
    pytest.importorskip("numba")
    # sea | 1 m shore | 9 m ridge (above the cap) | 1 m hollow sealed behind it
    elev = np.array([[SEA_CM, 100, 900, 100]] * 3, dtype="int16")
    got = connected_fill_cm(elev, 700)
    assert (got[:, 1] == 100).all()
    assert (got[:, 2] == 900).all()            # above the cap: its own height
    assert (got[:, 3] == NEVER_CM).all()       # the sea cannot get there below the cap
