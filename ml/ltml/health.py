"""Agent reliability and the mandate health score.

The health score is a transparent weighted index, NOT a trained model and NOT a credit rating. Weights are chosen by
hand and shown to the user together with every factor's contribution. Statistical estimates only when there is
enough data, and "insufficient data" otherwise.
"""
from __future__ import annotations

import math

from .chain import replay

WEIGHTS = {"runway": 0.30, "anomaly": 0.25, "discipline": 0.15, "approvals": 0.10, "settlement": 0.10, "integrity": 0.10}
LABELS = {
    "runway": "Budget runway (chance of lasting to expiry)",
    "anomaly": "Unusual spend (share of recent requests flagged)",
    "discipline": "Rule discipline (share of requests blocked by rules)",
    "approvals": "Approval backlog (requests waiting on the owner)",
    "settlement": "Settlement certainty (captures awaiting PayPal confirmation)",
    "integrity": "Chain integrity",
}


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return 0.0, 1.0
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    r = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return max(0.0, (c - r) / d), min(1.0, (c + r) / d)


def agent_reliability(blocks: list[dict], flagged_ids: set[str] | None = None) -> list[dict]:
    s = replay(blocks)
    cap = max(1, s.mandate["perTxCapCents"]) if s.mandate else 1
    flagged_ids = flagged_ids or set()
    per: dict[str, dict] = {}
    for r in s.requests.values():
        a = per.setdefault(r["agentId"], {"agent": r["agentId"], "requests": 0, "blocked": 0, "needsOwner": 0, "rejected": 0,
                                            "voided": 0, "settled": 0, "flagged": 0, "sumRatio": 0.0})
        a["requests"] += 1
        a["sumRatio"] += r["amountCents"] / cap
        if r.get("outcome") == "BLOCKED":
            a["blocked"] += 1
        if r.get("outcome") == "NEEDS_APPROVAL":
            a["needsOwner"] += 1
        a["rejected"] += r["status"] == "REJECTED"
        a["voided"] += r["status"] == "VOIDED"
        a["settled"] += r["status"] == "SETTLED"
        a["flagged"] += r["id"] in flagged_ids
    out = []
    for a in per.values():
        n = a["requests"]
        lo, hi = wilson(a["blocked"], n)
        if n < 5:
            label = "insufficient_data"
        elif lo > 0.30:
            label = "unreliable"
        elif hi < 0.15:
            label = "reliable"
        else:
            label = "watch"
        out.append({"agent": a["agent"], "requests": n, "blocked": a["blocked"], "needsOwner": a["needsOwner"], "rejected": a["rejected"],
                    "voided": a["voided"], "settled": a["settled"], "flagged": a["flagged"], "blockRate": a["blocked"] / n,
                    "blockRateInterval95": [round(lo, 4), round(hi, 4)], "meanTicketToCap": round(a["sumRatio"] / n, 4), "label": label})
    return sorted(out, key=lambda x: -x["requests"])


def health_score(*, p_exhaust: float | None, flagged_share: float, block_rate: float, stale_pending: int, unresolved_captures: int, quarantined: bool) -> dict:
    runway = 0.7 if p_exhaust is None else 1.0 - p_exhaust
    factors = {
        "runway": runway,
        "anomaly": 1.0 - min(1.0, flagged_share * 5.0),
        "discipline": 1.0 - min(1.0, block_rate * 2.0),
        "approvals": 1.0 - min(1.0, stale_pending / 3.0),
        "settlement": 1.0 - min(1.0, unresolved_captures / 2.0),
        "integrity": 0.0 if quarantined else 1.0,
    }
    parts = [{"factor": k, "label": LABELS[k], "weight": WEIGHTS[k], "value": round(v, 4), "points": round(100 * WEIGHTS[k] * v, 2),
              "maxPoints": round(100 * WEIGHTS[k], 2)} for k, v in factors.items()]
    score = round(sum(p["points"] for p in parts), 1)
    band = "healthy" if score >= 80 else "watch" if score >= 60 else "at_risk"
    notes = ["Weights are set by hand and shown above. This is an explanatory index, not a validated credit rating."]
    if p_exhaust is None:
        notes.append("Runway used a neutral 70% because there is not enough spending history to forecast yet.")
    return {"score": score, "band": band, "factors": parts, "notes": notes}
