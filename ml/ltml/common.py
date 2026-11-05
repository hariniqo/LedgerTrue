from __future__ import annotations

import numpy as np

EXHAUST_FRAC = 0.9  # a mandate counts as "exhausted" once 90% of its budget is committed (settled + held + reserved)


def pr_auc(y: np.ndarray, p: np.ndarray) -> float:
    from sklearn.metrics import average_precision_score
    return float(average_precision_score(y, p)) if 0 < np.sum(y) < len(y) else float("nan")


def roc_auc(y: np.ndarray, p: np.ndarray) -> float:
    from sklearn.metrics import roc_auc_score
    return float(roc_auc_score(y, p)) if 0 < np.sum(y) < len(y) else float("nan")


def prf_at(y: np.ndarray, p: np.ndarray, thr: float) -> dict:
    pred = p >= thr
    tp = int(np.sum(pred & (y == 1)))
    fp = int(np.sum(pred & (y == 0)))
    fn = int(np.sum(~pred & (y == 1)))
    tn = int(np.sum(~pred & (y == 0)))
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
    return {"threshold": float(thr), "precision": prec, "recall": rec, "f1": f1,
            "falsePositiveRate": fp / (fp + tn) if fp + tn else 0.0, "tp": tp, "fp": fp, "fn": fn, "tn": tn}


def threshold_for_fpr(y: np.ndarray, p: np.ndarray, max_fpr: float) -> float:
    """Smallest threshold whose false-positive rate on `y` stays at or below max_fpr."""
    neg = np.sort(p[y == 0])
    if not len(neg):
        return 0.5
    k = int(np.ceil((1 - max_fpr) * len(neg))) - 1
    k = min(max(k, 0), len(neg) - 1)
    return float(min(1.0, neg[k] + 1e-9))


def brier(y: np.ndarray, p: np.ndarray) -> float:
    return float(np.mean((p - y) ** 2))


def ece(y: np.ndarray, p: np.ndarray, bins: int = 10) -> float:
    """Expected calibration error with equal-width bins."""
    edges = np.linspace(0, 1, bins + 1)
    idx = np.clip(np.digitize(p, edges[1:-1]), 0, bins - 1)
    total = 0.0
    for b in range(bins):
        m = idx == b
        if m.any():
            total += m.mean() * abs(p[m].mean() - y[m].mean())
    return float(total)


def reliability(y: np.ndarray, p: np.ndarray, bins: int = 10) -> list[dict]:
    edges = np.linspace(0, 1, bins + 1)
    idx = np.clip(np.digitize(p, edges[1:-1]), 0, bins - 1)
    out = []
    for b in range(bins):
        m = idx == b
        if m.any():
            out.append({"bin": b, "n": int(m.sum()), "meanPredicted": float(p[m].mean()), "observed": float(y[m].mean())})
    return out


def level(p: float, t_med: float, t_high: float) -> str:
    return "high" if p >= t_high else "medium" if p >= t_med else "low"


def bootstrap_ci(y: np.ndarray, p: np.ndarray, fn, n: int = 300, seed: int = 0) -> list[float]:
    """95% percentile bootstrap interval for a metric. Small test sets deserve error bars."""
    rng = np.random.default_rng(seed)
    vals = []
    for _ in range(n):
        i = rng.integers(0, len(y), len(y))
        v = fn(y[i], p[i])
        if not np.isnan(v):
            vals.append(v)
    return [float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5))] if vals else [float("nan")] * 2
