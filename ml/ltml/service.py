"""HTTP service (Starlette ASGI). Run:  python -m ltml.service   (binds 127.0.0.1:8808)

Read-only by design: every endpoint takes data in and returns estimates out. Nothing here can write to the ledger,
approve a payment or call PayPal. Set ML_SERVICE_TOKEN to require `Authorization: Bearer <token>`.
FastAPI would be a drop-in swap; Starlette + pydantic is what FastAPI is built on and is what could be installed.
"""
from __future__ import annotations

import hmac
import os
import time
from typing import Any

import numpy as np
from pydantic import BaseModel, Field, ValidationError
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from . import __version__, features as F, forecast as fc, health, registry, synth
from .chain import ChainState, replay, validate_blocks
from .common import EXHAUST_FRAC
from .monitor import DriftWindow

MAX_BODY = 2_000_000
MAX_BLOCKS = 5000
MAX_PAYMENTS = 500


class Block(BaseModel):
    model_config = {"extra": "allow"}
    index: int | None = None
    ts: int
    type: str
    data: dict = Field(default_factory=dict)


class MandateIn(BaseModel):
    blocks: list[Block] = Field(max_length=MAX_BLOCKS)
    now: int
    context: dict = Field(default_factory=dict)


class ScoreIn(BaseModel):
    blocks: list[Block] = Field(max_length=MAX_BLOCKS)
    candidate: dict
    ts: int


class PaymentIn(BaseModel):
    paymentId: str = Field(max_length=80)
    engineState: str = Field(max_length=30)
    events: list[dict] = Field(max_length=200)


class PaymentsIn(BaseModel):
    payments: list[PaymentIn] = Field(max_length=MAX_PAYMENTS)
    now: int


class Models:
    def __init__(self, root=registry.MODELS_DIR) -> None:
        self.root = root
        self.m: dict[str, Any] = {}
        self.manifests: dict[str, dict] = {}
        self.errors: dict[str, str] = {}
        self.windows: dict[str, DriftWindow] = {}
        for name in ("risk", "distress", "recon", "forecast"):
            try:
                obj, man = registry.load(name, root=root)
                self.m[name], self.manifests[name] = obj, man
                if man.get("reference"):
                    self.windows[name] = DriftWindow(man["features"], man["reference"])
            except Exception as e:  # missing or tampered artifact: that model is simply unavailable
                self.errors[name] = str(e)

    def summary(self) -> list[dict]:
        out = []
        for name, man in self.manifests.items():
            mt = man.get("metrics", {})
            head = (mt.get("test", {}) or {}).get("prAuc") or (mt.get("attention", {}) or {}).get("prAuc")
            out.append({"name": name, "version": man["version"], "createdAt": man["createdAt"], "dataSource": man.get("dataSource"),
                        "algorithm": mt.get("algorithm"), "headlinePrAuc": head, "thresholds": man.get("thresholds"),
                        "sha256": man["sha256"][:16], "trainedOn": man.get("trainedOnMandates") or man.get("trainedOnPayments"),
                        "dataNote": man.get("dataNote")})
        for name, err in self.errors.items():
            out.append({"name": name, "error": err})
        return out

    def version(self, name: str) -> str | None:
        return self.manifests.get(name, {}).get("version")


def _json(data: Any, status: int = 200) -> JSONResponse:
    return JSONResponse(data, status_code=status, headers={"Cache-Control": "no-store"})


def build_app(models: Models | None = None, token: str | None = None) -> Starlette:
    M = models or Models()
    tok = os.environ.get("ML_SERVICE_TOKEN", "") if token is None else token

    def authed(req: Request) -> bool:
        if not tok:
            return True
        got = req.headers.get("authorization", "").removeprefix("Bearer ").strip()
        return hmac.compare_digest(got, tok)

    async def body(req: Request, model: type[BaseModel]):
        raw = await req.body()
        if len(raw) > MAX_BODY:
            return None, _json({"error": "body too large"}, 413)
        try:
            return model.model_validate_json(raw), None
        except ValidationError as e:
            return None, _json({"error": "invalid request", "detail": [x["msg"] + " @ " + ".".join(map(str, x["loc"])) for x in e.errors()[:5]]}, 422)

    def guard(fn):
        async def wrapped(req: Request):
            if not authed(req):
                return _json({"error": "unauthorized"}, 401)
            try:
                return await fn(req)
            except Exception as e:  # never leak internals
                return _json({"error": "internal error", "type": type(e).__name__}, 500)
        return wrapped

    # ---------------------------------------------------------------- helpers
    def score_rows(rows: list[dict]) -> list[dict]:
        risk = M.m["risk"]
        X = F.matrix(rows)
        p, nov = risk.proba(X), risk.novelty(X)
        if "risk" in M.windows:
            M.windows["risk"].add(X)
        out = []
        for i, r in enumerate(rows):
            lvl = risk.level(float(p[i]))
            n_prior = float(np.expm1(r["features"]["agent_n_prior"]))
            out.append({"requestId": r["requestId"], "agentId": r["agentId"], "ts": r["ts"], "amountCents": r["amountCents"], "merchant": r["merchant"],
                        "score": round(float(p[i]), 4), "noveltyPercentile": round(float(nov[i]), 3), "level": lvl,
                        "priorRequests": int(round(n_prior)), "confidence": round(min(0.9, 0.3 + 0.12 * n_prior), 2),
                        "dataQuality": "cold_start" if n_prior < 5 else "ok",
                        "evidence": risk.explain(X[i], r) if lvl != "low" else []})
        return out

    # ---------------------------------------------------------------- routes
    async def healthz(req: Request):
        return _json({"ok": True, "service": "ledgertrue-ml", "version": __version__, "models": {k: M.version(k) for k in ("risk", "distress", "recon", "forecast")}, "errors": M.errors})

    async def models(req: Request):
        return _json({"models": M.summary(), "advisoryOnly": True})

    async def monitor(req: Request):
        return _json({"drift": {k: w.report() for k, w in M.windows.items()}, "note": "PSI of recent live feature vectors against the training distribution."})

    async def analyze_mandate(req: Request):
        data, err = await body(req, MandateIn)
        if err:
            return err
        blocks = [b.model_dump() for b in data.blocks]
        problems = validate_blocks(blocks)
        if problems:
            return _json({"error": "invalid chain", "detail": problems}, 422)
        if not {"risk", "distress", "forecast"} <= set(M.m):
            return _json({"error": "models unavailable", "detail": M.errors}, 503)
        now = data.now
        state = replay([b for b in blocks if b["ts"] <= now])
        mandate = state.mandate
        scored = score_rows(F.request_rows(blocks))
        by_id = state.requests
        for s in scored:
            r = by_id.get(s["requestId"], {})
            s["outcome"], s["status"] = r.get("outcome"), r.get("status")
        flagged = {s["requestId"] for s in scored if s["level"] == "high"}
        flagged_recent = [s for s in scored[-50:] if s["level"] in ("high", "medium")]
        recent_n = max(1, len(scored[-50:]))

        f = fc.forecast(mandate, blocks, now, M.m["forecast"])
        committed = state.committed
        ex = None
        dist = {"status": "not_applicable"}
        if now >= mandate["expiresAt"]:
            dist = {"status": "expired"}
        elif committed >= EXHAUST_FRAC * mandate["budgetCents"]:
            dist = {"status": "ok", "probability": 1.0, "level": "high", "alreadyExhausted": True, "contributions": [], "algorithm": None}
        elif len(state.requests) >= 3:
            d = M.m["distress"]
            feats = F.checkpoint_features(blocks, now)
            x = np.array([[feats[k] for k in F.CHECKPOINT_FEATURES]])
            if "distress" in M.windows:
                M.windows["distress"].add(x)
            p = float(d.proba(x)[0])
            fp = f["exhaustion"]["probBeforeExpiry"] if f["status"] == "ok" else None
            dist = {"status": "ok", "probability": round(p, 4), "level": d.level(p), "alreadyExhausted": False, "contributions": d.explain(x[0]),
                    "algorithm": getattr(d, "algorithm", None), "forecastProbability": None if fp is None else round(fp, 4),
                    "agreement": None if fp is None else abs(p - fp) <= 0.25}
        else:
            dist = {"status": "insufficient_history", "note": "Fewer than 3 requests so far."}

        p_ex = dist.get("probability") if dist.get("status") == "ok" else None
        stale = sum(1 for r in state.requests.values() if r["status"] == "PENDING_APPROVAL" and now - r["ts"] > 24 * 3_600_000)
        n_req = max(1, len(state.requests))
        blocked = sum(1 for r in state.requests.values() if r.get("outcome") == "BLOCKED")
        hs = health.health_score(p_exhaust=p_ex, flagged_share=len(flagged_recent) / recent_n if scored else 0.0, block_rate=blocked / n_req if state.requests else 0.0,
                                 stale_pending=stale, unresolved_captures=int(data.context.get("unresolvedCaptures", 0)), quarantined=bool(data.context.get("quarantined", False)))
        sc = data.context.get("serverCommittedCents")
        return _json({
            "engine": "ml", "asOf": now, "committedCents": committed, "budgetCents": mandate["budgetCents"],
            "committedMatchesServer": None if sc is None else int(sc) == committed,
            "modelVersions": {k: M.version(k) for k in ("risk", "distress", "forecast")},
            "requests": scored[-300:], "riskSummary": {"scored": len(scored), "high": sum(1 for s in scored if s["level"] == "high"), "medium": sum(1 for s in scored if s["level"] == "medium"),
                                                       "maxScore": max((s["score"] for s in scored), default=0.0), "highIds": sorted(flagged)[:50]},
            "forecast": f, "distress": dist, "behaviour": health.agent_reliability(blocks, flagged), "health": hs,
        })

    async def score_request(req: Request):
        data, err = await body(req, ScoreIn)
        if err:
            return err
        if "risk" not in M.m:
            return _json({"error": "risk model unavailable"}, 503)
        c = data.candidate
        if not isinstance(c.get("amountCents"), int) or c["amountCents"] <= 0:
            return _json({"error": "candidate.amountCents must be a positive integer"}, 422)
        blocks = [b.model_dump() for b in data.blocks]
        problems = validate_blocks(blocks)
        if problems:
            return _json({"error": "invalid chain", "detail": problems}, 422)
        rows = F.request_rows(blocks, candidate={**c, "requestId": c.get("requestId", "candidate")}, candidate_ts=data.ts)
        s = score_rows(rows[-1:])[0]
        return _json({"engine": "ml", "modelVersion": M.version("risk"), "thresholds": M.m["risk"].thresholds, **s})

    async def analyze_payments(req: Request):
        data, err = await body(req, PaymentsIn)
        if err:
            return err
        if "recon" not in M.m:
            return _json({"error": "recon model unavailable"}, 503)
        model = M.m["recon"]
        feats, keep = [], []
        for p in data.payments:
            if not p.events:
                continue
            feats.append(F.recon_features(p.events, p.engineState, data.now))
            keep.append(p)
        out = []
        if keep:
            X = F.recon_matrix(feats)
            if "recon" in M.windows:
                M.windows["recon"].add(X)
            pa, pm = model.proba(X, "attention"), model.proba(X, "moneyMoved")
            th = model.thresholds["attention"]
            for i, p in enumerate(keep):
                a = float(pa[i])
                lvl = "high" if a >= th["high"] else "medium" if a >= th["medium"] else "low"
                out.append({"paymentId": p.paymentId, "engineState": p.engineState, "attentionProbability": round(a, 4), "moneyMovedProbability": round(float(pm[i]), 4),
                            "level": lvl, "evidence": model.explain(X[i], feats[i], "attention") if lvl != "low" else [], "eventsSeen": len(p.events)})
        return _json({"engine": "ml", "modelVersion": M.version("recon"), "asOf": data.now, "payments": out,
                      "note": "Estimates of how the reconciler will end up. The reconciler's own state stays authoritative."})

    async def synthetic(req: Request):
        try:
            seed = int((await req.json()).get("seed", 1))
        except Exception:
            seed = 1
        seed = max(0, min(seed, 10_000_000))
        sim = synth.simulate(seed, 0, forced=["spike", "structuring", "duplicate", "burst"], anomaly_rate=0.02)
        m = sim.mandate
        now = int(m["createdAt"] + 0.55 * (m["expiresAt"] - m["createdAt"]))
        return _json({"synthetic": True, "note": "Simulated mandate. Not your data and not on the ledger.", "now": now, "blocks": sim.truncated(now)})

    def wrap(fn):
        return guard(fn)

    return Starlette(routes=[
        Route("/healthz", healthz, methods=["GET"]),
        Route("/v1/models", wrap(models), methods=["GET"]),
        Route("/v1/monitor", wrap(monitor), methods=["GET"]),
        Route("/v1/analyze/mandate", wrap(analyze_mandate), methods=["POST"]),
        Route("/v1/analyze/payments", wrap(analyze_payments), methods=["POST"]),
        Route("/v1/score/request", wrap(score_request), methods=["POST"]),
        Route("/v1/synthetic/mandate", wrap(synthetic), methods=["POST"]),
    ])


app = None


def main() -> None:
    import uvicorn
    host = os.environ.get("ML_HOST", "127.0.0.1")
    if host not in ("127.0.0.1", "localhost") and not os.environ.get("ML_SERVICE_TOKEN"):
        raise SystemExit("Refusing to bind a non-loopback address without ML_SERVICE_TOKEN.")
    uvicorn.run(build_app(), host=host, port=int(os.environ.get("ML_PORT", "8808")), log_level="warning")


if __name__ == "__main__":
    main()
