"""Budget-exhaustion early warning: will this mandate run out of budget before it expires?

Features come from the chain up to a checkpoint. The label (exhausted before expiry) comes from the simulation's
future, so it is synthetic by construction. Compared against a plain logistic regression and a one-line heuristic
(projected utilisation >= 90%) so the gradient-boosted model has to earn its place.
"""
from __future__ import annotations

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .common import EXHAUST_FRAC, level
from .features import CHECKPOINT_FEATURES

GROUPS = {
    "spend so far": ["util", "settled_frac", "held_frac"],
    "pace vs time": ["time_frac", "burn_ratio", "log_remaining_days"],
    "recent trend": ["recent_burn_ratio", "projected_util"],
    "request pattern": ["req_per_day", "mean_ticket_to_cap", "log_budget"],
    "friction": ["block_rate", "pending_share"],
}


class DistressModel:
    def __init__(self, seed: int = 7) -> None:
        self.seed = seed
        self.features = list(CHECKPOINT_FEATURES)
        self.clf = None
        self.iso = None
        self.baseline = None
        self.reference = None
        self.thresholds = {"medium": 0.35, "high": 0.65}

    def fit(self, X, y, Xv, yv) -> "DistressModel":
        """Fit both candidates and keep whichever has the lower validation Brier score.
        With ~1,000 checkpoints a regularised linear model usually wins; the choice is recorded, not assumed."""
        cands = {
            "logistic_regression": make_pipeline(StandardScaler(), LogisticRegression(max_iter=500, C=1.0)),
            "gradient_boosting": HistGradientBoostingClassifier(max_depth=3, learning_rate=0.05, max_iter=150, l2_regularization=2.0,
                                                                 min_samples_leaf=30, random_state=self.seed),
        }
        self.candidate_brier = {}
        best = None
        for name, est in cands.items():
            est.fit(X, y)
            pv = est.predict_proba(Xv)[:, 1]
            iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0).fit(pv, yv)
            b = float(np.mean((iso.predict(pv) - yv) ** 2))
            self.candidate_brier[name] = b
            if best is None or b < best[0]:
                best = (b, name, est, iso)
        _, self.algorithm, self.clf, self.iso = best
        self.baseline = cands["logistic_regression"]
        self.reference = np.median(X, axis=0)
        return self

    def proba(self, X: np.ndarray) -> np.ndarray:
        return np.clip(self.iso.predict(self.clf.predict_proba(X)[:, 1]), 0.0, 1.0)

    def baseline_proba(self, X: np.ndarray) -> np.ndarray:
        return self.baseline.predict_proba(X)[:, 1]

    @staticmethod
    def heuristic(X: np.ndarray, features: list[str]) -> np.ndarray:
        return (X[:, features.index("projected_util")] >= EXHAUST_FRAC).astype(float)

    def explain(self, x: np.ndarray, top: int = 3) -> list[dict]:
        base = float(self.proba(x.reshape(1, -1))[0])
        out = []
        for g, names in GROUPS.items():
            xo = x.copy()
            for n in names:
                j = self.features.index(n)
                xo[j] = self.reference[j]
            drop = base - float(self.proba(xo.reshape(1, -1))[0])
            if abs(drop) > 0.03:
                out.append((abs(drop), g, drop))
        out.sort(reverse=True)
        return [{"group": g, "contribution": round(d, 4)} for _, g, d in out[:top]]

    def level(self, p: float) -> str:
        return level(p, self.thresholds["medium"], self.thresholds["high"])
