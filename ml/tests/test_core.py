import numpy as np
import pytest

from ltml import chain, features as F, forecast as fc, health, monitor, registry, synth
from ltml.common import brier, ece, pr_auc, threshold_for_fpr


@pytest.fixture(scope="module")
def sim():
    return synth.simulate(3, 5)


def test_simulator_is_reproducible():
    a, b = synth.simulate(5, 2), synth.simulate(5, 2)
    assert a.blocks == b.blocks and a.labels == b.labels
    assert synth.simulate(6, 2).blocks != a.blocks


def test_simulated_chain_obeys_budget_invariant(sim):
    s = chain.ChainState()
    for b in sim.blocks:
        chain.apply_block(s, b)
        assert 0 <= s.committed <= s.mandate["budgetCents"]
        assert s.settled >= 0 and s.held >= 0 and s.reserved >= 0
    assert chain.validate_blocks(sim.blocks) == []


def test_validate_blocks_catches_bad_input():
    assert chain.validate_blocks([]) == ["no blocks"]
    assert any("block 0" in p for p in chain.validate_blocks([{"type": "REQUEST", "ts": 1}]))
    bad = [{"type": "MANDATE", "ts": 5}, {"type": "REQUEST", "ts": 1}]
    assert any("backwards" in p for p in chain.validate_blocks(bad))


def test_request_features_have_no_lookahead(sim):
    """Features for request i must not change when later blocks are removed."""
    full = F.request_rows(sim.blocks)
    cut = max(i for i, b in enumerate(sim.blocks) if b["type"] == "REQUEST") // 2
    part = F.request_rows(sim.blocks[:cut])
    for a, b in zip(part, full):
        assert a["requestId"] == b["requestId"]
        assert a["features"] == b["features"]


def test_candidate_row_matches_recorded_row(sim):
    rows = F.request_rows(sim.blocks)
    k = len(rows) // 2
    target = rows[k]
    first = next(b for b in sim.blocks if b["type"] == "REQUEST" and b["data"]["requestId"] == target["requestId"])
    prior = sim.blocks[: first["index"]]
    cand = F.request_rows(prior, candidate=first["data"], candidate_ts=first["ts"])[-1]
    assert cand["features"] == target["features"]


def test_feature_matrix_is_finite(sim):
    X = F.matrix(F.request_rows(sim.blocks))
    assert X.shape[1] == len(F.REQUEST_FEATURES) and np.isfinite(X).all()


def test_forecast_insufficient_history_is_explicit():
    m = synth.simulate(3, 5)
    t0 = m.mandate["createdAt"] + 60_000
    f = fc.forecast(m.mandate, m.truncated(t0), t0)
    assert f["status"] == "insufficient_history" and f["horizons"] == [] and f["exhaustion"] is None


def test_forecast_is_deterministic_and_ordered(sim):
    m = sim.mandate
    t0 = int(m["createdAt"] + 0.5 * (m["expiresAt"] - m["createdAt"]))
    a = fc.forecast(m, sim.truncated(t0), t0)
    b = fc.forecast(m, sim.truncated(t0), t0)
    assert a == b
    if a["status"] == "ok":
        for h in a["horizons"]:
            assert 0 <= h["p10"] <= h["p50"] <= h["p90"]
            assert 0 <= h["exceedsBudgetProb"] <= 1
        assert 0 <= a["exhaustion"]["probBeforeExpiry"] <= 1


def test_forecast_after_expiry_refuses():
    s = synth.simulate(3, 1)
    f = fc.forecast(s.mandate, s.blocks, s.mandate["expiresAt"] + 1)
    assert f["status"] == "expired"


def test_wilson_and_reliability_labels(sim):
    lo, hi = health.wilson(0, 0)
    assert (lo, hi) == (0.0, 1.0)
    lo, hi = health.wilson(5, 50)
    assert lo < 0.1 < hi
    rel = health.agent_reliability(sim.blocks)
    assert rel and all(r["label"] in ("reliable", "watch", "unreliable", "insufficient_data") for r in rel)


def test_health_score_is_explainable_and_bounded():
    h = health.health_score(p_exhaust=0.2, flagged_share=0.0, block_rate=0.0, stale_pending=0, unresolved_captures=0, quarantined=False)
    assert h["score"] == pytest.approx(100 - 0.3 * 20, abs=0.1) and h["band"] == "healthy"
    assert sum(f["points"] for f in h["factors"]) == pytest.approx(h["score"], abs=0.1)
    bad = health.health_score(p_exhaust=1.0, flagged_share=1.0, block_rate=1.0, stale_pending=9, unresolved_captures=9, quarantined=True)
    assert bad["score"] == 0 and bad["band"] == "at_risk"
    unk = health.health_score(p_exhaust=None, flagged_share=0, block_rate=0, stale_pending=0, unresolved_captures=0, quarantined=False)
    assert any("neutral" in n for n in unk["notes"])


def test_metric_helpers():
    y = np.array([0, 0, 0, 1, 1]); p = np.array([0.1, 0.2, 0.3, 0.8, 0.9])
    assert pr_auc(y, p) == 1.0
    assert brier(y, p) < 0.05 and 0 <= ece(y, p) <= 1
    assert threshold_for_fpr(y, p, 0.0) > 0.3


def test_psi_detects_shift():
    rng = np.random.default_rng(0)
    X = rng.normal(size=(2000, 1))
    ref = monitor.reference_edges(X, ["a"])
    stable = monitor.psi(ref["a"], rng.normal(size=500))
    shifted = monitor.psi(ref["a"], rng.normal(loc=2.0, size=500))
    assert stable < 0.1 < 0.25 < shifted
    assert monitor.psi(ref["a"], rng.normal(size=5)) is None


def test_registry_refuses_tampered_artifact(tmp_path):
    registry.save("demo", {"x": 1}, {"features": []}, root=tmp_path)
    obj, man = registry.load("demo", root=tmp_path)
    assert obj == {"x": 1} and man["sha256"]
    f = next((tmp_path / "demo").glob("*/artifact.joblib"))
    f.write_bytes(f.read_bytes() + b"tamper")
    with pytest.raises(registry.ArtifactError):
        registry.load("demo", root=tmp_path)
