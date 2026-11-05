"""Feature extraction. One implementation is used for training and for serving, so there is no train/serve skew.

Every feature for a request is computed from information available strictly BEFORE that request (no leakage).
"""
from __future__ import annotations

import math
from bisect import bisect_left
from collections import Counter, defaultdict
from typing import Iterable

import numpy as np

from .chain import ChainState, apply_block

DAY_MS = 86_400_000
HOUR_MS = 3_600_000

REQUEST_FEATURES = [
    "log_amount", "amount_vs_agent_median", "amount_vs_agent_max", "amount_rank_agent", "amount_to_cap", "amount_to_budget", "amount_to_available", "amount_to_threshold",
    "near_threshold", "agent_n_prior", "z_amount_agent", "z_amount_mandate", "gap_log", "gap_ratio",
    "req_last_10m", "req_last_1h", "req_last_24h", "merchant_freq_agent", "merchant_new_for_agent",
    "hour_dist", "dup_24h", "similar_amount_24h", "util_before", "time_frac", "agent_block_rate",
]


def _robust_z(x: float, prior: list[float]) -> float:
    if len(prior) < 3:
        return 0.0
    a = np.asarray(prior, dtype=float)
    med = float(np.median(a))
    mad = float(np.median(np.abs(a - med)))
    z = (x - med) / (1.4826 * mad + 0.15)
    return float(min(12.0, max(-8.0, z)))


def _circ_dist_hours(hour: float, vecs: list[tuple[float, float]]) -> float:
    if len(vecs) < 5:
        return 0.0
    sx = sum(v[0] for v in vecs)
    sy = sum(v[1] for v in vecs)
    center = (math.atan2(sy, sx) % (2 * math.pi)) * 24 / (2 * math.pi)
    d = abs(hour - center) % 24
    return float(min(d, 24 - d))


class _Agent:
    __slots__ = ("log_amounts", "ts", "merchants", "hours", "decided", "blocked", "dups", "recent")

    def __init__(self) -> None:
        self.log_amounts: list[float] = []
        self.ts: list[int] = []
        self.merchants: Counter = Counter()
        self.hours: list[tuple[float, float]] = []
        self.decided = 0
        self.blocked = 0
        self.dups: dict[tuple, list[int]] = defaultdict(list)
        self.recent: list[tuple[int, int]] = []  # (ts, amountCents)


def _hour_of(ts_ms: int) -> float:
    return ((ts_ms % DAY_MS) / HOUR_MS)


def _row_features(state: ChainState, ag: _Agent, all_logs: list[float], req: dict, ts: int) -> dict[str, float]:
    m = state.mandate
    amt = max(1, int(req["amountCents"]))
    la = math.log(amt)
    budget = max(1, m["budgetCents"])
    cap = max(1, m["perTxCapCents"])
    thr = m.get("approvalAboveCents") or 0
    avail = max(1, state.available)
    created, expires = m["createdAt"], m["expiresAt"]
    n = len(ag.log_amounts)

    if n:
        gap = max(0, ts - ag.ts[-1]) / 1000.0
        gaps = np.diff(ag.ts) / 1000.0 if n > 1 else np.array([])
        med_gap = float(np.median(gaps)) if len(gaps) >= 2 else None
    else:
        gap = max(0, ts - created) / 1000.0
        med_gap = None
    gap_ratio = 1.0 if not med_gap else float(min(50.0, max(0.0, gap / max(med_gap, 1.0))))

    def window(ms: int) -> int:
        return n - bisect_left(ag.ts, ts - ms) if n else 0

    key = (req.get("merchant"), amt)
    dup = sum(1 for t in ag.dups.get(key, ()) if ts - t <= DAY_MS)
    sim = sum(1 for (t, a) in ag.recent if ts - t <= DAY_MS and abs(a - amt) <= 0.02 * amt)
    total_m = sum(ag.merchants.values())
    freq = ag.merchants.get(req.get("merchant"), 0) / total_m if total_m else 0.0

    if n >= 3:
        arr = np.asarray(ag.log_amounts)
        vs_med = float(min(5.0, max(-5.0, la - float(np.median(arr)))))
        vs_max = float(min(5.0, max(-5.0, la - float(arr.max()))))
        rank = float(np.mean(arr <= la))
    else:
        vs_med, vs_max, rank = 0.0, 0.0, 0.5
    return {
        "log_amount": la,
        "amount_vs_agent_median": vs_med,
        "amount_vs_agent_max": vs_max,
        "amount_rank_agent": rank,
        "amount_to_cap": min(2.0, amt / cap),
        "amount_to_budget": min(2.0, amt / budget),
        "amount_to_available": min(10.0, amt / avail),
        "amount_to_threshold": min(5.0, amt / thr) if thr else 0.0,
        "near_threshold": 1.0 if thr and 0.9 * thr <= amt <= thr else 0.0,
        "agent_n_prior": math.log1p(n),
        "z_amount_agent": _robust_z(la, ag.log_amounts),
        "z_amount_mandate": _robust_z(la, all_logs),
        "gap_log": math.log1p(gap),
        "gap_ratio": gap_ratio,
        "req_last_10m": float(window(10 * 60_000)),
        "req_last_1h": float(window(HOUR_MS)),
        "req_last_24h": float(window(DAY_MS)),
        "merchant_freq_agent": freq,
        "merchant_new_for_agent": 1.0 if (n >= 3 and ag.merchants.get(req.get("merchant"), 0) == 0) else 0.0,
        "hour_dist": _circ_dist_hours(_hour_of(ts), ag.hours),
        "dup_24h": float(dup),
        "similar_amount_24h": float(sim),
        "util_before": float(min(2.0, state.committed / budget)),
        "time_frac": float(min(1.5, max(0.0, (ts - created) / max(1, expires - created)))),
        "agent_block_rate": (ag.blocked + 0.5) / (ag.decided + 5.0),
    }


def request_rows(blocks: Iterable[dict], candidate: dict | None = None, candidate_ts: int | None = None) -> list[dict]:
    """One feature row per REQUEST block (plus the optional not-yet-recorded candidate, as the last row)."""
    state = ChainState()
    agents: dict[str, _Agent] = defaultdict(_Agent)
    all_logs: list[float] = []
    rows: list[dict] = []
    owner: dict[str, str] = {}

    def emit(req: dict, ts: int, rid: str) -> dict:
        ag = agents[req.get("agentId") or "?"]
        return {
            "requestId": rid, "agentId": req.get("agentId"), "ts": ts, "amountCents": int(req["amountCents"]),
            "merchant": req.get("merchant"), "features": _row_features(state, ag, all_logs, req, ts),
        }

    def remember(req: dict, ts: int) -> None:
        ag = agents[req.get("agentId") or "?"]
        amt = max(1, int(req["amountCents"]))
        la = math.log(amt)
        ag.log_amounts.append(la)
        ag.ts.append(ts)
        ag.merchants[req.get("merchant")] += 1
        h = _hour_of(ts) * 2 * math.pi / 24
        ag.hours.append((math.cos(h), math.sin(h)))
        ag.dups[(req.get("merchant"), amt)].append(ts)
        ag.recent.append((ts, amt))
        if len(ag.recent) > 400:
            del ag.recent[:200]
        all_logs.append(la)

    for b in blocks:
        t = b["type"]
        if t == "MANDATE":
            apply_block(state, b)
        elif t == "REQUEST":
            d = b["data"]
            rid = d["requestId"]
            owner[rid] = d.get("agentId") or "?"
            rows.append(emit(d, int(b["ts"]), rid))
            remember(d, int(b["ts"]))
            apply_block(state, b)
        else:
            if t == "DECISION":
                a = agents[owner.get(b["data"].get("requestId"), "?")]
                a.decided += 1
                if b["data"].get("outcome") == "BLOCKED":
                    a.blocked += 1
            apply_block(state, b)
    if candidate is not None and state.mandate is not None:
        rows.append(emit(candidate, int(candidate_ts), candidate.get("requestId", "candidate")))
    return rows


def matrix(rows: list[dict]) -> np.ndarray:
    return np.asarray([[r["features"][k] for k in REQUEST_FEATURES] for r in rows], dtype=float).reshape(len(rows), len(REQUEST_FEATURES))


# ------------------------------------------------------------------ mandate checkpoint (exhaustion / forecast)

CHECKPOINT_FEATURES = [
    "util", "settled_frac", "held_frac", "time_frac", "burn_ratio", "recent_burn_ratio", "projected_util",
    "req_per_day", "mean_ticket_to_cap", "block_rate", "pending_share", "log_budget", "log_remaining_days",
]


def truncate(blocks: list[dict], t0: int) -> list[dict]:
    return [b for b in blocks if b["ts"] <= t0]


def checkpoint_features(blocks: list[dict], t0: int) -> dict[str, float]:
    from .chain import committed_series  # local import keeps the module graph simple

    sub = truncate(blocks, t0)
    s = ChainState()
    for b in sub:
        apply_block(s, b)
    m = s.mandate
    budget = max(1, m["budgetCents"])
    created, expires = m["createdAt"], m["expiresAt"]
    life = max(1, expires - created)
    elapsed = max(1, t0 - created)
    tf = min(1.5, elapsed / life)
    util = s.committed / budget
    series = committed_series(sub)
    recent_window = max(elapsed * 0.25, HOUR_MS)
    base = 0
    for ts, c in series:
        if ts <= t0 - recent_window:
            base = c
    recent_rate = (s.committed - base) / recent_window  # cents per ms
    overall_rate = s.committed / elapsed
    remaining = max(0, expires - t0)
    projected = util + recent_rate * remaining / budget
    reqs = list(s.requests.values())
    n = len(reqs)
    blocked = sum(1 for r in reqs if r["status"] == "BLOCKED")
    pending = sum(1 for r in reqs if r["status"] == "PENDING_APPROVAL")
    cap = max(1, m["perTxCapCents"])
    return {
        "util": float(min(2.0, util)),
        "settled_frac": float(min(2.0, s.settled / budget)),
        "held_frac": float(min(2.0, (s.held + s.reserved) / budget)),
        "time_frac": float(tf),
        "burn_ratio": float(min(20.0, util / max(tf, 0.05))),
        "recent_burn_ratio": float(min(20.0, (recent_rate / overall_rate) if overall_rate > 0 else 0.0)),
        "projected_util": float(min(5.0, projected)),
        "req_per_day": float(min(500.0, n / max(elapsed / DAY_MS, 0.04))),
        "mean_ticket_to_cap": float(np.mean([r["amountCents"] / cap for r in reqs])) if reqs else 0.0,
        "block_rate": (blocked + 0.5) / (n + 5.0),
        "pending_share": pending / n if n else 0.0,
        "log_budget": math.log(budget),
        "log_remaining_days": math.log1p(remaining / DAY_MS),
    }


# ------------------------------------------------------------------ payment / reconciliation early warning

ENGINE_STATES = ["INITIATED", "PROCESSING", "PENDING", "UNKNOWN", "SUCCESS", "VERIFIED", "FAILED", "DISPUTED",
                 "PARTIALLY_REFUNDED", "REFUNDED", "REVERSED", "RECONCILE"]

RECON_FEATURES = [
    "n_events", "n_dup", "n_unique", "n_app", "n_webhook", "n_poll",
    "has_attempt", "has_timeout", "has_client_error", "has_complete", "has_pending", "has_denied",
    "has_refund", "has_dispute", "out_of_order", "amount_mismatch", "log_amount",
    "span_log", "silence_log", "attempt_to_timeout_log", "attempt_to_paypal_log", "timeout_before_paypal",
] + [f"state_{s}" for s in ENGINE_STATES]


def _lg(ms: float | None) -> float:
    return -1.0 if ms is None else math.log1p(max(0.0, ms))


def recon_features(events: list[dict], engine_state: str, ref_now: int) -> dict[str, float]:
    ev = sorted(events, key=lambda e: e["arrival"]) if events and "arrival" in events[0] else list(events)
    uniq = [e for e in ev if not e.get("duplicate")]
    types = {e["type"] for e in uniq}
    by_src = Counter(e["source"] for e in uniq)

    attempt = next((e for e in uniq if e["type"] == "PAYMENT.ATTEMPTED"), None)
    timeout = next((e for e in uniq if e["type"] in ("CLIENT.TIMEOUT", "CLIENT.ERROR")), None)
    first_pp = next((e for e in sorted(uniq, key=lambda e: e.get("receivedAt", e["ts"])) if e["source"] != "app"), None)

    def rcv(e: dict) -> float:
        return float(e.get("receivedAt", e["ts"]))

    srt = sorted(uniq, key=lambda e: e["ts"])
    ooo = any(a.get("arrival", 0) > b.get("arrival", 0) for a, b in zip(srt, srt[1:]))
    app_amt = next((e["amountCents"] for e in uniq if e["source"] == "app" and e.get("amountCents")), None)
    pp_amt = next((e["amountCents"] for e in reversed(uniq) if e["source"] != "app" and e.get("amountCents") and e["type"] in ("PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.PENDING")), None)
    amt = pp_amt or app_amt or 0
    last_rcv = max((rcv(e) for e in ev), default=ref_now)
    first_ts = min((e["ts"] for e in ev), default=ref_now)

    f = {
        "n_events": float(len(ev)), "n_dup": float(sum(1 for e in ev if e.get("duplicate"))), "n_unique": float(len(uniq)),
        "n_app": float(by_src.get("app", 0)), "n_webhook": float(by_src.get("paypal_webhook", 0)), "n_poll": float(by_src.get("paypal_poll", 0)),
        "has_attempt": float(attempt is not None), "has_timeout": float(timeout is not None and timeout["type"] == "CLIENT.TIMEOUT"),
        "has_client_error": float(timeout is not None and timeout["type"] == "CLIENT.ERROR"),
        "has_complete": float("PAYMENT.CAPTURE.COMPLETED" in types), "has_pending": float("PAYMENT.CAPTURE.PENDING" in types),
        "has_denied": float("PAYMENT.CAPTURE.DENIED" in types),
        "has_refund": float("PAYMENT.CAPTURE.REFUNDED" in types), "has_dispute": float(any(t.startswith("CUSTOMER.DISPUTE") for t in types)),
        "out_of_order": float(ooo), "amount_mismatch": float(bool(app_amt and pp_amt and app_amt != pp_amt)),
        "log_amount": math.log1p(amt),
        "span_log": _lg(max((e["ts"] for e in ev), default=first_ts) - first_ts),
        "silence_log": _lg(ref_now - last_rcv),
        "attempt_to_timeout_log": _lg(timeout["ts"] - attempt["ts"]) if (attempt and timeout) else -1.0,
        "attempt_to_paypal_log": _lg(rcv(first_pp) - attempt["ts"]) if (attempt and first_pp) else -1.0,
        "timeout_before_paypal": float(bool(timeout and (first_pp is None or rcv(timeout) <= rcv(first_pp)))),
    }
    for s in ENGINE_STATES:
        f[f"state_{s}"] = float(engine_state == s)
    return f


def recon_matrix(rows: list[dict]) -> np.ndarray:
    return np.asarray([[r[k] for k in RECON_FEATURES] for r in rows], dtype=float).reshape(len(rows), len(RECON_FEATURES))
