"""Ghost-balance early warning: predict how a payment will end BEFORE PayPal is polled.

Training data: simulated event streams replayed through the project's real reconciler (tools/gen-recon-dataset.mjs).
Targets are the engine's own final verdicts:
  attention   - the payment ended as a ghost balance, RECONCILE, a critical anomaly or an amount mismatch
  moneyMoved  - the engine's final state says PayPal really took the money
The second one is the practical signal: "the client timed out, but is it safe to let the customer retry?"
The engine stays the authority; this only says how worried to be while it is still waiting.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.isotonic import IsotonicRegression

from .features import RECON_FEATURES, recon_features, recon_matrix

TARGETS = ("attention", "moneyMoved")
SILENCE_MS = 12_000  # the server waits ~8s before it polls; rows are also built "after the wait"

GROUPS = {
    "client signals": ["has_timeout", "has_client_error", "attempt_to_timeout_log", "timeout_before_paypal", "has_attempt"],
    "paypal signals": ["n_webhook", "n_poll", "has_complete", "has_pending", "has_denied", "attempt_to_paypal_log"],
    "delivery faults": ["n_dup", "out_of_order", "n_events", "n_unique", "n_app"],
    "silence": ["silence_log", "span_log"],
    "engine state": [f for f in RECON_FEATURES if f.startswith("state_")],
    "money": ["amount_mismatch", "has_refund", "has_dispute", "log_amount"],
}


def load_samples(path: str | Path) -> list[dict]:
    with open(path, encoding="utf8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def build_rows(samples: list[dict]) -> tuple[np.ndarray, dict[str, np.ndarray], np.ndarray, list[int]]:
    """One row per delivered event (the model sees only what had arrived by then), plus a 'silence' variant."""
    rows, ys_att, ys_mm, groups, k_prefix = [], [], [], [], []
    for gi, s in enumerate(samples):
        ev, st = s["events"], s["states"]
        for i in range(1, len(ev) + 1):
            for extra in (0, SILENCE_MS):
                if extra and i != len(ev):
                    continue  # silence only matters once everything has arrived and nothing more is coming
                rows.append(recon_features(ev[:i], st[i - 1], ev[i - 1]["receivedAt"] + extra))
                ys_att.append(int(s["final"]["attention"]))
                ys_mm.append(int(s["final"]["moneyMoved"]))
                groups.append(gi)
                k_prefix.append(i)
    return recon_matrix(rows), {"attention": np.array(ys_att), "moneyMoved": np.array(ys_mm)}, np.array(groups), k_prefix


class ReconModel:
    def __init__(self, seed: int = 7) -> None:
        self.seed = seed
        self.features = list(RECON_FEATURES)
        self.clf: dict[str, HistGradientBoostingClassifier] = {}
        self.iso: dict[str, IsotonicRegression] = {}
        self.reference: np.ndarray | None = None
        self.thresholds = {"attention": {"medium": 0.3, "high": 0.6}}

    def fit(self, X, Y, Xv, Yv) -> "ReconModel":
        for t in TARGETS:
            c = HistGradientBoostingClassifier(max_depth=4, learning_rate=0.06, max_iter=200, l2_regularization=1.0,
                                               min_samples_leaf=25, random_state=self.seed).fit(X, Y[t])
            self.clf[t] = c
            self.iso[t] = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0).fit(c.predict_proba(Xv)[:, 1], Yv[t])
        self.reference = np.median(X, axis=0)
        return self

    def proba(self, X: np.ndarray, target: str) -> np.ndarray:
        return np.clip(self.iso[target].predict(self.clf[target].predict_proba(X)[:, 1]), 0.0, 1.0)

    def explain(self, x: np.ndarray, feats: dict, target: str = "attention", top: int = 3) -> list[dict]:
        base = float(self.proba(x.reshape(1, -1), target)[0])
        out = []
        for g, names in GROUPS.items():
            xo = x.copy()
            for n in names:
                j = self.features.index(n)
                xo[j] = self.reference[j]
            drop = base - float(self.proba(xo.reshape(1, -1), target)[0])
            if drop > 0.03:
                out.append((drop, g))
        out.sort(reverse=True)
        return [{"group": g, "contribution": round(d, 4), "text": _text(g, feats)} for d, g in out[:top]]


def _secs(log_ms: float) -> float:
    return float(np.expm1(log_ms)) / 1000.0


def _text(group: str, f: dict) -> str:
    if group == "client signals":
        if f["has_timeout"]:
            when = f"{_secs(f['attempt_to_timeout_log']):.0f}s after the attempt" if f["attempt_to_timeout_log"] >= 0 else "after the attempt"
            return f"The app recorded a timeout {when}" + (" before PayPal had confirmed anything" if f["timeout_before_paypal"] else "")
        if f["has_client_error"]:
            return "The app recorded a client error"
        return "No client-side failure signal"
    if group == "paypal signals":
        if not (f["n_webhook"] or f["n_poll"]):
            return "No PayPal webhook or poll result has arrived"
        if f["has_denied"] and f["has_complete"]:
            return "PayPal sent both a denial and a completion"
        return "PayPal webhook " + ("confirms the capture" if f["has_complete"] else "has arrived without a capture")
    if group == "delivery faults":
        bits = []
        if f["n_dup"]:
            bits.append(f"{int(f['n_dup'])} duplicate delivery(s)")
        if f["out_of_order"]:
            bits.append("events arrived out of order")
        return ", ".join(bits) or f"{int(f['n_events'])} event(s) so far"
    if group == "silence":
        return f"No new event for {_secs(f['silence_log']):.0f}s"
    if group == "engine state":
        s = next((n[6:] for n in RECON_FEATURES if n.startswith("state_") and f[n]), "?")
        return f"The reconciler currently shows {s}"
    return "Amount mismatch, refund or dispute present" if (f["amount_mismatch"] or f["has_refund"] or f["has_dispute"]) else "Amount details"
