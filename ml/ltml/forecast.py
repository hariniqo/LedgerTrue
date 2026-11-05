"""Burn-rate forecast: how much of the budget will be committed by 7 / 30 / 90 days, and will it run out first?

Method: recency-weighted bootstrap of the mandate's own per-bin committed spend. No assumption about the shape of
the distribution, honest prediction intervals from simulated paths, and it degrades to "not enough history"
instead of inventing a number. Backtested against run-rate baselines in train.py.
"""
from __future__ import annotations

import zlib
from dataclasses import dataclass

import numpy as np

from .chain import committed_series
from .common import EXHAUST_FRAC

DAY = 86_400_000
HOUR = 3_600_000
MIN_BINS = 6
MIN_EVENTS = 4


@dataclass
class ForecastConfig:
    paths: int = 600
    horizons_days: tuple = (7, 30, 90)
    interval: tuple = (10, 90)
    half_life_frac: float = 0.25   # recency weighting: half-life as a fraction of the observed history (chosen by backtest)
    interval_scale: float = 1.0    # conformal widening of paths around their median (fitted on held-out backtests)


def bin_ms_for(life_ms: int) -> int:
    return int(min(DAY, max(HOUR, round(life_ms / 30 / HOUR) * HOUR)))


def _net_bins(series: list[tuple[int, int]], created: int, now: int, bin_ms: int) -> np.ndarray:
    n = max(1, int((now - created) // bin_ms))
    out = np.zeros(n)
    prev = 0
    for ts, c in series:
        if ts > now:
            break
        k = min(n - 1, max(0, int((ts - created) // bin_ms)))
        out[k] += c - prev
        prev = c
    return out


def forecast(mandate: dict, blocks: list[dict], now: int, cfg: ForecastConfig = ForecastConfig()) -> dict:
    created, expires, budget = mandate["createdAt"], mandate["expiresAt"], mandate["budgetCents"]
    life = max(1, expires - created)
    bin_ms = bin_ms_for(life)
    series = committed_series([b for b in blocks if b["ts"] <= now])
    committed = series[-1][1] if series else 0
    elapsed = max(0, min(now, expires) - created)
    hist = _net_bins(series, created, min(now, expires), bin_ms)
    n_events = len(series)
    base = {"engine": "bootstrap-v1", "binHours": bin_ms / HOUR, "committedCents": int(committed), "budgetCents": int(budget),
            "asOf": int(now), "expiresAt": int(expires)}

    if now >= expires:
        return {**base, "status": "expired", "dataQuality": "mandate_expired", "horizons": [], "exhaustion": None, "curve": [], "history": _history(series, now)}
    if len(hist) < MIN_BINS or n_events < MIN_EVENTS:
        return {**base, "status": "insufficient_history", "dataQuality": "insufficient_history", "horizons": [], "exhaustion": None, "curve": [],
                "history": _history(series, now),
                "note": f"Needs at least {MIN_BINS} time bins ({MIN_BINS * bin_ms / HOUR:.0f}h) and {MIN_EVENTS} spend events; has {len(hist)} bins and {n_events} events."}

    K = len(hist)
    hl = max(3.0, cfg.half_life_frac * K)
    w = 0.5 ** ((K - 1 - np.arange(K)) / hl)
    w /= w.sum()
    remaining_bins = int(np.ceil((expires - now) / bin_ms))
    steps = max(1, remaining_bins)
    seed = zlib.crc32(f"{mandate.get('id')}:{n_events}:{int(now // bin_ms)}".encode())
    rng = np.random.default_rng(seed)
    draws = hist[rng.choice(K, size=(cfg.paths, steps), p=w)]
    cum = committed + np.cumsum(draws, axis=1)
    if cfg.interval_scale != 1.0:
        med = np.median(cum, axis=0, keepdims=True)
        cum = med + cfg.interval_scale * (cum - med)
    cum = np.maximum(cum, 0.0)
    lo, hi = cfg.interval

    def at(step: int) -> dict:
        col = cum[:, min(step, steps) - 1]
        p10, p50, p90 = np.percentile(col, [lo, 50, hi])
        return {"p10": int(p10), "p50": int(p50), "p90": int(p90), "exceedsBudgetProb": float(np.mean(col >= budget))}

    horizons = []
    for d in cfg.horizons_days:
        steps_d = int(np.ceil(d * DAY / bin_ms))
        eff = min(steps_d, steps)
        horizons.append({"days": d, "effectiveDays": round(eff * bin_ms / DAY, 2), "toExpiry": steps_d >= steps, **at(eff)})

    thr = EXHAUST_FRAC * budget
    crossed = cum >= thr
    ever = crossed.any(axis=1)
    first = np.where(ever, crossed.argmax(axis=1) + 1, steps + 1)
    prob = float(ever.mean())
    if committed >= thr:
        ex = {"probBeforeExpiry": 1.0, "medianTs": int(now), "p10Ts": int(now), "p90Ts": int(now), "alreadyExhausted": True}
    elif ever.any():
        q10, q50, q90 = np.percentile(first[ever], [10, 50, 90])
        ex = {"probBeforeExpiry": prob, "medianTs": int(now + q50 * bin_ms), "p10Ts": int(now + q10 * bin_ms), "p90Ts": int(now + q90 * bin_ms), "alreadyExhausted": False}
    else:
        ex = {"probBeforeExpiry": prob, "medianTs": None, "p10Ts": None, "p90Ts": None, "alreadyExhausted": False}

    stride = max(1, steps // 60)
    idx = list(range(stride, steps + 1, stride))
    if idx[-1] != steps:
        idx.append(steps)
    curve = [{"t": int(now + i * bin_ms), **{k: v for k, v in at(i).items() if k in ("p10", "p50", "p90")}} for i in idx]
    hist_cum = float(np.sum(hist))
    run_rate = hist_cum / max(1, elapsed) * DAY
    recent = float(np.sum(hist[-max(1, K // 3):])) / (max(1, K // 3) * bin_ms) * DAY
    cv = float(np.std(hist) / np.mean(hist)) if np.mean(hist) > 0 else None
    return {**base, "status": "ok", "dataQuality": "ok", "horizons": horizons, "exhaustion": ex, "curve": curve, "history": _history(series, now),
            "runRatePerDayCents": int(run_rate), "recentRatePerDayCents": int(recent),
            "volatilityCv": None if cv is None else round(cv, 3), "paths": cfg.paths, "intervalPercentiles": [lo, hi],
            "intervalScale": round(cfg.interval_scale, 3), "halfLifeFrac": cfg.half_life_frac}


def _history(series: list[tuple[int, int]], now: int, max_pts: int = 120) -> list[dict]:
    pts = [{"t": t, "committed": c} for t, c in series if t <= now]
    if len(pts) > max_pts:
        step = len(pts) / max_pts
        pts = [pts[int(i * step)] for i in range(max_pts - 1)] + [pts[-1]]
    return pts


# ---------------------------------------------------------------------------------------------- backtest

def committed_at(blocks: list[dict], t: int) -> int:
    s = committed_series([b for b in blocks if b["ts"] <= t])
    return s[-1][1] if s else 0


def _backtest_rows(sims, cfg: ForecastConfig, origins, horizon_frac) -> np.ndarray:
    rows = []
    for s in sims:
        m = s.mandate
        life = m["expiresAt"] - m["createdAt"]
        for o in origins:
            t0 = int(m["createdAt"] + o * life)
            t1 = int(t0 + horizon_frac * life)
            if t1 > m["expiresAt"]:
                continue
            f = forecast(m, s.truncated(t0), t0, cfg)
            if f["status"] != "ok":
                continue
            col = next((c for c in f["curve"] if c["t"] >= t1), f["curve"][-1])
            actual = committed_at(s.blocks, t1)
            now_c = f["committedCents"]
            run = now_c + (now_c / max(1, t0 - m["createdAt"])) * (t1 - t0)
            win = 0.25 * (t0 - m["createdAt"])
            recent = now_c + ((now_c - committed_at(s.blocks, int(t0 - win))) / max(1, win)) * (t1 - t0)
            B = m["budgetCents"]
            rows.append([actual / B, col["p10"] / B, col["p50"] / B, col["p90"] / B, run / B, recent / B, now_c / B])
    return np.asarray(rows, dtype=float).reshape(-1, 7)


def calibrate(sims, half_lives=(0.1, 0.25, 0.5, 1.0), origins=(0.3, 0.5, 0.7), horizon_frac=0.25, target=0.8, limit=220) -> tuple[ForecastConfig, dict]:
    """Choose the recency half-life by backtest MAE, then widen the intervals (split-conformal) so that the 10-90%
    band covers `target` of held-out outcomes. Fit on training mandates only; the test set never sees this."""
    sims = sims[:limit]
    best = None
    tried = {}
    for hl in half_lives:
        a = _backtest_rows(sims, ForecastConfig(paths=200, half_life_frac=hl), origins, horizon_frac)
        mae = float(np.mean(np.abs(a[:, 2] - a[:, 0])))
        tried[str(hl)] = mae
        if best is None or mae < best[0]:
            best = (mae, hl, a)
    _, hl, a = best
    actual, p10, p50, p90 = a[:, 0], a[:, 1], a[:, 2], a[:, 3]
    below = np.maximum(p50 - p10, 1e-6)
    above = np.maximum(p90 - p50, 1e-6)
    score = np.maximum((p50 - actual) / below, (actual - p50) / above)
    n = len(score)
    k = float(np.quantile(score, min(1.0, target * (n + 1) / n)))
    return ForecastConfig(half_life_frac=hl, interval_scale=max(1.0, min(k, 6.0))), {"halfLifeMae": tried, "chosenHalfLife": hl, "intervalScale": max(1.0, min(k, 6.0)), "calibrationRows": int(n)}


def backtest(sims, cfg: ForecastConfig = ForecastConfig(), origins=(0.3, 0.5, 0.7), horizon_frac=0.25) -> dict:
    """Rolling-origin backtest on simulated mandates. Errors are scaled by each mandate's budget so they compare."""
    a = _backtest_rows(sims, cfg, origins, horizon_frac)
    if not len(a):
        return {"n": 0}
    actual = a[:, 0]

    def err(col):
        e = a[:, col] - actual
        return {"mae": float(np.mean(np.abs(e))), "rmse": float(np.sqrt(np.mean(e ** 2)))}

    return {"n": int(len(a)), "unit": "fraction of budget", "horizonFractionOfLife": horizon_frac, "origins": list(origins),
            "bootstrapP50": err(2), "runRateBaseline": err(4), "recentRateBaseline": err(5), "noChangeBaseline": err(6),
            "intervalCoverage80": float(np.mean((actual >= a[:, 1]) & (actual <= a[:, 3]))),
            "intervalWidthMean": float(np.mean(a[:, 3] - a[:, 1])), "config": {"halfLifeFrac": cfg.half_life_frac, "intervalScale": cfg.interval_scale}}
