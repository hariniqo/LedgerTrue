"""Agent spend risk: which requests look unlike this agent's own behaviour.

Two models on the same 22 behavioural features:
  * IsolationForest: unsupervised novelty. Needs no labels, so it is the part that stays valid on real data.
  * HistGradientBoosting + isotonic calibration: a supervised prior learned from SYNTHETIC injected anomalies.
The supervised probability is the risk score. The novelty percentile is shown beside it as independent evidence.
Neither can approve or block. A high score can only ask the owner to look (see shared/rules.js ML_RISK_REVIEW).
"""
from __future__ import annotations

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier, IsolationForest
from sklearn.isotonic import IsotonicRegression

from .common import level
from .features import REQUEST_FEATURES

GROUPS = {
    "amount": ["log_amount", "amount_vs_agent_median", "amount_vs_agent_max", "amount_rank_agent", "amount_to_cap", "amount_to_budget", "amount_to_available", "z_amount_agent", "z_amount_mandate"],
    "velocity": ["gap_log", "gap_ratio", "req_last_10m", "req_last_1h", "req_last_24h"],
    "merchant": ["merchant_freq_agent", "merchant_new_for_agent"],
    "timing": ["hour_dist"],
    "repeat": ["dup_24h", "similar_amount_24h"],
    "threshold": ["near_threshold", "amount_to_threshold"],
    "context": ["agent_n_prior", "agent_block_rate", "util_before", "time_frac"],
}


class RiskModel:
    def __init__(self, seed: int = 7) -> None:
        self.seed = seed
        self.features = list(REQUEST_FEATURES)
        self.clf: HistGradientBoostingClassifier | None = None
        self.iso: IsotonicRegression | None = None
        self.forest: IsolationForest | None = None
        self.novelty_quantiles: np.ndarray | None = None
        self.reference: np.ndarray | None = None
        self.thresholds = {"medium": 0.5, "high": 0.8}

    # ------------------------------------------------------------------ training
    def fit(self, X_train: np.ndarray, y_train: np.ndarray, X_val: np.ndarray, y_val: np.ndarray) -> "RiskModel":
        self.clf = HistGradientBoostingClassifier(max_depth=4, learning_rate=0.06, max_iter=250, l2_regularization=1.0,
                                                  min_samples_leaf=30, random_state=self.seed)
        self.clf.fit(X_train, y_train)
        self.iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0).fit(self.clf.predict_proba(X_val)[:, 1], y_val)
        self.forest = IsolationForest(n_estimators=200, contamination="auto", random_state=self.seed, n_jobs=1)
        self.forest.fit(X_train)
        self.novelty_quantiles = np.quantile(-self.forest.score_samples(X_train), np.linspace(0, 1, 101))
        self.reference = np.median(X_train, axis=0)
        return self

    # ------------------------------------------------------------------ inference
    def proba(self, X: np.ndarray) -> np.ndarray:
        return np.clip(self.iso.predict(self.clf.predict_proba(X)[:, 1]), 0.0, 1.0)

    def novelty(self, X: np.ndarray) -> np.ndarray:
        raw = -self.forest.score_samples(X)
        return np.searchsorted(self.novelty_quantiles, raw) / 100.0  # percentile against the training distribution

    def explain(self, x: np.ndarray, row: dict, top: int = 3) -> list[dict]:
        """Group occlusion: how much does the score fall if this group of features looked typical?"""
        base = float(self.proba(x.reshape(1, -1))[0])
        out = []
        for g, names in GROUPS.items():
            xo = x.copy()
            for n in names:
                j = self.features.index(n)
                xo[j] = self.reference[j]
            drop = base - float(self.proba(xo.reshape(1, -1))[0])
            if drop > 0.02:
                out.append((drop, g))
        out.sort(reverse=True)
        return [{"group": g, "contribution": round(d, 4), "text": _text(g, row)} for d, g in out[:top]]

    def level(self, p: float) -> str:
        return level(p, self.thresholds["medium"], self.thresholds["high"])


def _text(group: str, row: dict) -> str:
    f = row["features"]
    if group == "amount":
        if f["agent_n_prior"] > 1.0:
            return f"Amount is {np.exp(f['amount_vs_agent_median']):.1f}x this agent's median ticket and {np.exp(f['amount_vs_agent_max']):.1f}x its largest so far ({f['amount_to_cap']:.0%} of the per-payment cap)"
        return f"Amount is {f['amount_to_cap']:.0%} of the per-payment cap and this agent has no history yet"
    if group == "velocity":
        return f"{int(f['req_last_10m'])} earlier request(s) by this agent in the last 10 minutes, {int(f['req_last_24h'])} in 24 hours"
    if group == "merchant":
        if f["merchant_new_for_agent"]:
            return f"First time this agent pays {row.get('merchant')}"
        return f"{row.get('merchant')} is only {f['merchant_freq_agent']:.0%} of this agent's history"
    if group == "timing":
        return f"Request time is {f['hour_dist']:.0f} hours away from this agent's usual hours"
    if group == "repeat":
        if f["dup_24h"]:
            return f"Same merchant and amount already requested {int(f['dup_24h'])} time(s) in 24 hours"
        return f"{int(f['similar_amount_24h'])} near-identical amount(s) from this agent in 24 hours"
    if group == "threshold":
        return f"Amount sits at {f['amount_to_threshold']:.0%} of the owner-approval threshold"
    return f"Mandate context: {f['util_before']:.0%} of the budget already committed, agent block rate {f['agent_block_rate']:.0%}"
