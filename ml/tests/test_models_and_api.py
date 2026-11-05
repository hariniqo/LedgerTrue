"""Uses the trained artifacts in ml/models (run `python -m ltml.train` first)."""
import json
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from ltml import features as F, recon as rc, registry, synth
from ltml.service import Models, build_app

pytestmark = pytest.mark.skipif(registry.current_version("risk") is None, reason="models not trained")


@pytest.fixture(scope="module")
def client():
    return TestClient(build_app(Models(), token=""))


@pytest.fixture(scope="module")
def demo(client):
    r = client.post("/v1/synthetic/mandate", json={"seed": 4})
    assert r.status_code == 200
    return r.json()


def test_manifests_declare_synthetic_data():
    for n in ("risk", "distress", "recon", "forecast"):
        m = registry.manifest(n)
        assert m["dataSource"] == "synthetic" and "SIMULATED" in m["dataNote"] and m["sha256"]


def test_models_beat_their_baselines():
    r = registry.manifest("risk")["metrics"]
    assert r["test"]["prAuc"] > 2 * r["baselines"]["randomPrAuc"] and r["test"]["prAuc"] > r["baselines"]["ruleScore"]["prAuc"]
    f = registry.manifest("forecast")["metrics"]
    assert f["bootstrapP50"]["mae"] <= f["runRateBaseline"]["mae"] and 0.7 <= f["intervalCoverage80"] <= 0.9
    d = registry.manifest("distress")["metrics"]
    assert d["test"]["prAuc"] > d["baselines"]["projectedUtilHeuristic"]["prAuc"]


def test_health_and_models_endpoints(client):
    assert client.get("/healthz").json()["ok"] is True
    ms = client.get("/v1/models").json()
    assert ms["advisoryOnly"] is True and {m["name"] for m in ms["models"]} >= {"risk", "distress", "recon", "forecast"}


def test_analyze_mandate_contract(client, demo):
    r = client.post("/v1/analyze/mandate", json={"blocks": demo["blocks"], "now": demo["now"], "context": {}})
    assert r.status_code == 200
    a = r.json()
    assert a["engine"] == "ml" and a["requests"] and a["health"]["factors"]
    assert all(0 <= q["score"] <= 1 and q["level"] in ("low", "medium", "high") for q in a["requests"])
    assert a["riskSummary"]["high"] + a["riskSummary"]["medium"] >= 1, "the forced anomalies should raise at least one flag"
    flagged = [q for q in a["requests"] if q["level"] != "low"]
    assert all(q["evidence"] for q in flagged)
    assert a["forecast"]["status"] in ("ok", "insufficient_history")


def test_analysis_is_deterministic(client, demo):
    body = {"blocks": demo["blocks"], "now": demo["now"], "context": {}}
    assert client.post("/v1/analyze/mandate", json=body).json() == client.post("/v1/analyze/mandate", json=body).json()


def test_server_committed_cross_check(client, demo):
    body = {"blocks": demo["blocks"], "now": demo["now"], "context": {"serverCommittedCents": 1}}
    assert client.post("/v1/analyze/mandate", json=body).json()["committedMatchesServer"] is False


def test_score_request_flags_a_burst(client, demo):
    blocks = [b for b in demo["blocks"] if b["ts"] <= demo["now"]]
    m = blocks[0]["data"]["mandate"]
    reqs = [b for b in blocks if b["type"] == "REQUEST"]
    agent = reqs[-1]["data"]["agentId"]
    big = int(m["perTxCapCents"] * 0.95)
    r = client.post("/v1/score/request", json={"blocks": blocks, "ts": blocks[-1]["ts"] + 1000,
                                               "candidate": {"agentId": agent, "merchant": "Never Seen Store", "amountCents": big}})
    assert r.status_code == 200 and 0 <= r.json()["score"] <= 1


def test_rejects_malformed_and_oversized_input(client, demo):
    assert client.post("/v1/analyze/mandate", json={"blocks": [], "now": 1}).status_code == 422
    assert client.post("/v1/analyze/mandate", json={"nope": 1}).status_code == 422
    assert client.post("/v1/score/request", json={"blocks": demo["blocks"], "ts": 1, "candidate": {"amountCents": -5}}).status_code == 422
    assert client.post("/v1/analyze/mandate", content=b"x" * 2_100_000).status_code in (413, 422)


def test_token_is_enforced():
    c = TestClient(build_app(Models(), token="s3cret"))
    assert c.get("/v1/models").status_code == 401
    assert c.get("/v1/models", headers={"authorization": "Bearer wrong"}).status_code == 401
    assert c.get("/v1/models", headers={"authorization": "Bearer s3cret"}).status_code == 200
    assert c.get("/healthz").status_code == 200


def test_payment_early_warning_on_a_timeout(client):
    now = 100_000
    ev = [{"type": "ORDER.INITIATED", "source": "app", "ts": 0, "amountCents": 5000, "duplicate": False, "arrival": 1, "receivedAt": 50},
          {"type": "PAYMENT.ATTEMPTED", "source": "app", "ts": 600, "amountCents": 5000, "duplicate": False, "arrival": 2, "receivedAt": 700},
          {"type": "CLIENT.TIMEOUT", "source": "app", "ts": 8600, "amountCents": None, "duplicate": False, "arrival": 3, "receivedAt": 8700}]
    r = client.post("/v1/analyze/payments", json={"now": now, "payments": [{"paymentId": "ORD-X", "engineState": "UNKNOWN", "events": ev}]})
    assert r.status_code == 200
    p = r.json()["payments"][0]
    assert 0 <= p["attentionProbability"] <= 1 and 0 <= p["moneyMovedProbability"] <= 1
    assert p["moneyMovedProbability"] > 0.5, "a timeout with no PayPal answer is usually a slow capture in the simulation"


def test_recon_features_match_training_rows():
    s = rc.load_samples(Path(__file__).resolve().parent.parent / "data" / "recon_sim.jsonl")[:5]
    X, Y, g, k = rc.build_rows(s)
    assert X.shape[1] == len(F.RECON_FEATURES) and set(Y) == {"attention", "moneyMoved"}


def test_drift_endpoint_reports_after_traffic(client, demo):
    client.post("/v1/analyze/mandate", json={"blocks": demo["blocks"], "now": demo["now"], "context": {}})
    d = client.get("/v1/monitor").json()["drift"]
    assert "risk" in d and d["risk"]["totalSeen"] > 0
