"""Drift monitoring: Population Stability Index of live features against the training distribution.

PSI < 0.1 stable, 0.1-0.25 moderate shift, > 0.25 significant shift (common rule of thumb, not a statistical test).
The window lives in memory and holds only numeric feature vectors (no identifiers, no text).
"""
from __future__ import annotations

from collections import deque
from threading import Lock

import numpy as np


def reference_edges(X: np.ndarray, names: list[str], bins: int = 10) -> dict:
    out = {}
    for j, n in enumerate(names):
        col = X[:, j]
        edges = np.unique(np.quantile(col, np.linspace(0, 1, bins + 1)[1:-1]))
        counts = np.bincount(np.searchsorted(edges, col, side="right"), minlength=len(edges) + 1) / len(col)
        out[n] = {"edges": [float(e) for e in edges], "expected": [float(c) for c in counts]}
    return out


def psi(ref: dict, values: np.ndarray) -> float | None:
    if len(values) < 30 or len(ref["edges"]) < 1:
        return None
    edges = np.asarray(ref["edges"])
    act = np.bincount(np.searchsorted(edges, values, side="right"), minlength=len(edges) + 1) / len(values)
    exp = np.asarray(ref["expected"])
    eps = 1e-4
    return float(np.sum((act - exp) * np.log((act + eps) / (exp + eps))))


class DriftWindow:
    def __init__(self, names: list[str], reference: dict, size: int = 1000) -> None:
        self.names, self.reference = names, reference
        self.rows: deque = deque(maxlen=size)
        self.lock = Lock()
        self.seen = 0

    def add(self, X: np.ndarray) -> None:
        with self.lock:
            for r in X:
                self.rows.append(r)
            self.seen += len(X)

    def report(self) -> dict:
        with self.lock:
            M = np.asarray(self.rows) if self.rows else np.empty((0, len(self.names)))
        feats = []
        for j, n in enumerate(self.names):
            v = psi(self.reference[n], M[:, j]) if len(M) else None
            feats.append({"feature": n, "psi": None if v is None else round(v, 4)})
        vals = [f["psi"] for f in feats if f["psi"] is not None]
        worst = max(vals) if vals else None
        status = "insufficient_data" if worst is None else "significant_shift" if worst > 0.25 else "moderate_shift" if worst > 0.1 else "stable"
        return {"status": status, "windowSize": int(len(M)), "totalSeen": int(self.seen), "maxPsi": worst,
                "features": sorted(feats, key=lambda f: -(f["psi"] or 0))[:8]}
