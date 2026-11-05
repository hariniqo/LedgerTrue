"""Synthetic mandate streams. THIS IS NOT REAL DATA and every artifact trained on it says so.

LedgerTrue has no production history and no labelled fraud, so the models are pre-trained on simulated agents whose
anomalies are injected by construction. The simulator emits blocks in exactly the shape the server's chain has
(MANDATE, REQUEST, DECISION, APPROVAL, HOLD, CAPTURE, VOID), so the same feature code runs in training and serving.

What this can show: the pipeline works end to end and separates the anomaly types that were designed in.
What this cannot show: how the models behave on real agents or real fraud. See docs/AI_ML.md.
"""
from __future__ import annotations

import heapq
import math
from dataclasses import dataclass

import numpy as np

from .chain import ChainState, apply_block

DAY = 86_400_000
HOUR = 3_600_000
BASE_TS = 1_780_000_000_000  # fixed origin so every seed reproduces bit for bit

ANOMALY_TYPES = ["spike", "burst", "rare_merchant", "off_hours", "duplicate", "structuring"]
ANOMALY_P = [0.24, 0.10, 0.20, 0.20, 0.12, 0.14]
MERCHANTS = ["Dell Store", "IKEA", "Amazon Business", "Staples", "Croma", "Flipkart", "Reliance Digital", "Urban Ladder"]


class _Builder:
    def __init__(self, mandate_id: str, mandate: dict) -> None:
        self.mid = mandate_id
        self.blocks: list[dict] = []
        self.state = ChainState()
        self.add(mandate["createdAt"], "MANDATE", {"mandate": mandate})

    def add(self, ts: float, typ: str, data: dict) -> dict:
        last = self.blocks[-1]["ts"] if self.blocks else 0
        b = {"index": len(self.blocks), "ts": int(max(ts, last)), "type": typ, "mandateId": self.mid, "data": data}
        self.blocks.append(b)
        apply_block(self.state, b)
        return b


@dataclass
class Sim:
    mandate: dict
    blocks: list[dict]
    labels: dict[str, str | None]
    exhausted: bool
    peak_util: float
    regime: dict

    def truncated(self, t0: int) -> list[dict]:
        return [b for b in self.blocks if b["ts"] <= t0]


def make_mandate(rng: np.random.Generator, idx: int, created: int) -> dict:
    life_days = int(rng.choice([3, 7, 14, 30, 60, 90], p=[0.1, 0.25, 0.2, 0.25, 0.1, 0.1]))
    budget = int(round(math.exp(rng.uniform(math.log(5e6), math.log(5e8))) / 100) * 100)
    cap = int(round(budget * rng.uniform(0.12, 0.5) / 100) * 100)
    approval = int(round(cap * rng.uniform(0.5, 1.0) / 100) * 100)
    n_agents = int(rng.integers(1, 5))
    n_merch = int(rng.integers(2, 7))
    return {
        "id": "m_" + format(idx, "024x"), "title": f"Synthetic mandate {idx}", "goal": "Office supplies for the team",
        "helper": "ai_agent", "currency": "INR", "budgetCents": budget, "perTxCapCents": max(100, cap),
        "approvalAboveCents": max(100, approval), "allowedMerchants": list(rng.permutation(MERCHANTS)[:n_merch]),
        "agents": [f"agent-{i + 1}" for i in range(n_agents)], "allowedCategories": [],
        "createdAt": created, "expiresAt": created + life_days * DAY,
    }


def _hour_weights(center: float) -> np.ndarray:
    h = np.arange(24) + 0.5
    d = np.abs(h - center)
    d = np.minimum(d, 24 - d)
    w = 0.015 + np.exp(-0.5 * (d / 2.5) ** 2)  # night-time activity is rare, not uniform noise
    return w / w.sum()


def simulate(seed: int, idx: int = 0, anomaly_rate: float = 0.03, forced: list[str] | None = None, created: int | None = None) -> Sim:
    rng = np.random.default_rng([seed, idx])
    created = BASE_TS + idx * 3 * HOUR if created is None else created
    m = make_mandate(rng, idx, created)
    life_days = (m["expiresAt"] - created) / DAY
    budget, cap, thr = m["budgetCents"], m["perTxCapCents"], m["approvalAboveCents"]
    merchants, agents = m["allowedMerchants"], m["agents"]

    # target utilisation drives how hard the agents spend; the regime change makes forecasting non-trivial
    u_star = math.exp(rng.normal(math.log(0.5), 0.5))
    split = rng.dirichlet(np.full(len(agents), 2.0))
    regime_at = rng.uniform(0.3, 0.7) if rng.random() < 0.4 else None
    regime_mult = float(np.clip(math.exp(rng.normal(0, 0.5)), 0.35, 3.0)) if regime_at else 1.0

    profiles = []
    for a in range(len(agents)):
        med = budget * rng.uniform(0.004, 0.04)
        sigma = rng.uniform(0.3, 0.7)
        e_amt = min(0.95 * cap, med * math.exp(sigma ** 2 / 2))
        prefs = rng.dirichlet(np.full(len(merchants), 0.5)) + 0.01
        prefs = prefs / prefs.sum()
        profiles.append({"med": med, "sigma": sigma, "e_amt": e_amt, "prefs": prefs, "center": rng.uniform(7, 17),
                         "lam": 0.0})
    for a, p in enumerate(profiles):
        total_req = u_star * budget * split[a] / (max(p["e_amt"], 1.0) * 0.85)
        p["lam"] = total_req / life_days  # requests per day for this agent

    arrivals: list[tuple[int, int, str, int, str | None]] = []  # ts, agent idx, merchant, amount, label

    def clip_amt(x: float) -> int:
        return int(max(100, min(0.99 * cap, round(x / 100) * 100)))

    n_hours = int(math.ceil(life_days * 24))
    for ai, p in enumerate(profiles):
        w = _hour_weights(p["center"])
        for hb in range(n_hours):
            t_bin = created + hb * HOUR
            frac = hb / n_hours
            mult = regime_mult if (regime_at is not None and frac >= regime_at) else 1.0
            lam_h = p["lam"] * mult * w[int(((t_bin % DAY) // HOUR))]
            k = int(rng.poisson(lam_h))
            for _ in range(k):
                ts = int(t_bin + rng.integers(0, HOUR))
                amt = clip_amt(math.exp(rng.normal(math.log(p["med"]), p["sigma"])))
                mer = merchants[int(rng.choice(len(merchants), p=p["prefs"]))]
                label = None
                if rng.random() < anomaly_rate:
                    typ = str(rng.choice(ANOMALY_TYPES, p=ANOMALY_P))
                    _inject(rng, typ, arrivals, ts, ai, p, merchants, amt, mer, cap, thr, created, m["expiresAt"], clip_amt)
                    continue
                arrivals.append((ts, ai, mer, amt, label))

    for typ in forced or []:
        ai = int(rng.integers(0, len(profiles)))
        p = profiles[ai]
        ts = int(created + rng.uniform(0.35, 0.55) * (m["expiresAt"] - created))
        amt = clip_amt(math.exp(rng.normal(math.log(p["med"]), p["sigma"])))
        mer = merchants[int(rng.choice(len(merchants), p=p["prefs"]))]
        _inject(rng, typ, arrivals, ts, ai, p, merchants, amt, mer, cap, thr, created, m["expiresAt"], clip_amt)

    arrivals.sort(key=lambda a: a[0])
    b = _Builder(m["id"], m)
    labels: dict[str, str | None] = {}
    heap: list[tuple[int, int, str, str]] = []
    seq = 0
    peak = 0.0
    rid_n = 0

    def push(ts: float, kind: str, rid: str) -> None:
        nonlocal seq
        seq += 1
        heapq.heappush(heap, (int(ts), seq, kind, rid))

    def settle(ts: float, rid: str) -> None:
        if rng.random() < 0.88:
            push(ts + rng.exponential(4 * HOUR) + 60_000, "capture", rid)
        else:
            push(ts + rng.exponential(6 * HOUR) + 60_000, "void", rid)

    def place_hold(ts: float, rid: str) -> None:
        rq = b.state.requests[rid]
        b.add(ts, "HOLD", {"requestId": rid, "amountCents": rq["amountCents"], "gateway": "simulator", "orderId": f"ORD-{rid}", "authId": f"AUTH-{rid}"})
        settle(ts, rid)

    def drain(until: float) -> None:
        nonlocal peak
        while heap and heap[0][0] <= until:
            ts, _, kind, rid = heapq.heappop(heap)
            rq = b.state.requests.get(rid)
            if rq is None:
                continue
            if kind == "approval" and rq["status"] == "PENDING_APPROVAL":
                if rng.random() < 0.65:
                    b.add(ts, "APPROVAL", {"requestId": rid, "decision": "APPROVE"})
                    place_hold(ts + 1000, rid)
                else:
                    b.add(ts, "APPROVAL", {"requestId": rid, "decision": "REJECT"})
            elif kind == "capture" and rq["status"] == "HELD":
                b.add(ts, "CAPTURE", {"requestId": rid, "amountCents": rq["heldCents"], "via": "gateway"})
            elif kind == "void" and rq["status"] == "HELD":
                b.add(ts, "VOID", {"requestId": rid, "reason": "released by operator"})
            peak = max(peak, b.state.committed / budget)

    for ts, ai, mer, amt, label in arrivals:
        if ts >= m["expiresAt"]:
            continue
        drain(ts)
        rid_n += 1
        rid = f"r_{idx:x}_{rid_n:x}"
        b.add(ts, "REQUEST", {"requestId": rid, "agentId": agents[ai], "merchant": mer, "amountCents": amt, "currency": "INR",
                              "reason": "Routine purchase", "category": "office", "item": "Supplies"})
        labels[rid] = label
        reasons = []
        if amt > cap:
            reasons.append("PER_TX_CAP")
        if amt > b.state.available:
            reasons.append("BUDGET_AVAILABLE")
        if reasons:
            outcome = "BLOCKED"
        elif amt > thr:
            outcome, reasons = "NEEDS_APPROVAL", ["OWNER_APPROVAL_THRESHOLD"]
        else:
            outcome = "APPROVED"
        b.add(ts + 500, "DECISION", {"requestId": rid, "outcome": outcome, "reasons": reasons, "checks": []})
        peak = max(peak, b.state.committed / budget)
        if outcome == "APPROVED":
            place_hold(ts + 1500, rid)
        elif outcome == "NEEDS_APPROVAL":
            push(ts + math.exp(rng.normal(math.log(2 * HOUR), 1.0)), "approval", rid)
    drain(m["expiresAt"])

    return Sim(mandate=m, blocks=b.blocks, labels=labels, exhausted=peak >= 0.9, peak_util=float(peak),
               regime={"at": regime_at, "mult": regime_mult, "u_star": float(u_star)})


def _inject(rng, typ, arrivals, ts, ai, p, merchants, amt, mer, cap, thr, created, expires, clip_amt) -> None:
    """Append the anomalous pattern. The first member of a multi-request pattern stays unlabelled: a human could
    not call it suspicious yet, so it would be unfair to score the model on it."""
    def add(t, a, m, label):
        if created <= t < expires:
            arrivals.append((int(t), ai, m, int(a), label))

    if typ == "spike":
        mult = max(2.0, math.exp(rng.normal(math.log(3.5), 0.5)))
        add(ts, clip_amt(amt * mult), mer, "spike")
    elif typ == "rare_merchant":
        rare = merchants[int(np.argmin(p["prefs"]))]
        add(ts, clip_amt(amt * rng.uniform(1.3, 2.5)), rare, "rare_merchant")
    elif typ == "off_hours":
        center = p["center"]
        hour = (center + rng.choice([-1, 1]) * rng.uniform(8, 12)) % 24
        t = ts - (ts % DAY) + hour * HOUR
        add(t, clip_amt(amt * rng.uniform(1.0, 2.0)), mer, "off_hours")
    elif typ == "duplicate":
        add(ts, amt, mer, None)
        for k in range(int(rng.integers(1, 4))):
            add(ts + rng.uniform(1, 30) * 60_000 * (k + 1), amt, mer, "duplicate")
    elif typ == "burst":
        add(ts, clip_amt(amt), mer, None)
        for k in range(int(rng.integers(3, 8))):
            add(ts + rng.uniform(5, 600) * 1000 * (k + 1) / 3, clip_amt(amt * rng.uniform(0.8, 1.5)), mer, "burst")
    elif typ == "structuring":
        add(ts, clip_amt(thr * rng.uniform(0.9, 0.995)), mer, None)
        for k in range(int(rng.integers(2, 6))):
            add(ts + rng.uniform(5, 120) * 60_000 * (k + 1) / 3, clip_amt(thr * rng.uniform(0.9, 0.995)), mer, "structuring")


def portfolio(seed: int, n: int, **kw) -> list[Sim]:
    return [simulate(seed, i, **kw) for i in range(n)]
