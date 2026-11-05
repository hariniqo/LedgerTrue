"""Train, evaluate and (if the gate passes) promote every model.

    python -m ltml.train                       # defaults: seed 7, 700 simulated mandates, data/recon_sim.jsonl
    python -m ltml.train --seed 11 --mandates 1000 --no-promote

Everything here learns from SIMULATED data (see ltml/synth.py and tools/gen-recon-dataset.mjs). The report says so
on its first line, and so does every manifest. Exit code 2 means the promotion gate failed.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import scipy
import sklearn

from . import __version__, distress as dm, features as F, forecast as fc, recon as rc, registry, risk as rk, synth
from .common import bootstrap_ci, brier, ece, pr_auc, prf_at, reliability, roc_auc, threshold_for_fpr
from .monitor import reference_edges

DATA_NOTE = ("SIMULATED DATA. Mandate streams come from ml/ltml/synth.py with anomalies injected by construction; payment streams "
             "come from tools/gen-recon-dataset.mjs and are labelled by the real reconciler. There is no real fraud and no real "
             "customer history here, so these numbers show the pipeline works, not how it performs in production.")
ROOT = Path(__file__).resolve().parent.parent


def _split(n: int) -> tuple[range, range, range]:
    a, b = int(n * 0.6), int(n * 0.75)
    return range(0, a), range(a, b), range(b, n)


def _rule_risk_score(X: np.ndarray) -> np.ndarray:
    ix = {n: i for i, n in enumerate(F.REQUEST_FEATURES)}
    c = lambda name, d: np.clip(X[:, ix[name]] / d, 0, 1)
    parts = [c("z_amount_agent", 6.0), c("req_last_10m", 5.0), c("dup_24h", 2.0), c("similar_amount_24h", 4.0),
             0.6 * X[:, ix["merchant_new_for_agent"]], c("hour_dist", 12.0) * (X[:, ix["agent_n_prior"]] > 1.6)]
    return np.max(parts, axis=0)


def train_risk(sims, seed: int) -> tuple[rk.RiskModel, dict]:
    tr, va, te = _split(len(sims))

    def collect(idx):
        Xs, ys, kinds, meta = [], [], [], []
        for i in idx:
            rows = F.request_rows(sims[i].blocks)
            Xs.append(F.matrix(rows))
            for r in rows:
                lab = sims[i].labels.get(r["requestId"])
                ys.append(int(lab is not None))
                kinds.append(lab)
            meta.extend(rows)
        return np.vstack(Xs), np.array(ys), kinds

    Xtr, ytr, _ = collect(tr)
    Xva, yva, _ = collect(va)
    Xte, yte, kte = collect(te)
    m = rk.RiskModel(seed).fit(Xtr, ytr, Xva, yva)
    pva, pte = m.proba(Xva), m.proba(Xte)
    m.thresholds = {"medium": threshold_for_fpr(yva, pva, 0.03), "high": threshold_for_fpr(yva, pva, 0.005)}
    nov = m.novelty(Xte)
    rule = _rule_risk_score(Xte)
    ix = F.REQUEST_FEATURES.index("agent_n_prior")
    warm = np.expm1(Xte[:, ix]) >= 5
    by_type = {}
    for t in synth.ANOMALY_TYPES:
        sel = np.array([k == t for k in kte])
        if sel.any():
            by_type[t] = {"n": int(sel.sum()), "recallAtHigh": float(np.mean(pte[sel] >= m.thresholds["high"])), "recallAtMedium": float(np.mean(pte[sel] >= m.thresholds["medium"]))}
    metrics = {
        "split": {"train": len(Xtr), "validation": len(Xva), "test": len(Xte), "anomalyRate": {"train": float(ytr.mean()), "test": float(yte.mean())}},
        "test": {"prAuc": pr_auc(yte, pte), "prAucCI95": bootstrap_ci(yte, pte, pr_auc), "rocAuc": roc_auc(yte, pte), "brier": brier(yte, pte), "ece": ece(yte, pte),
                 "atHigh": prf_at(yte, pte, m.thresholds["high"]), "atMedium": prf_at(yte, pte, m.thresholds["medium"]),
                 "reliability": reliability(yte, pte)},
        "baselines": {"ruleScore": {"prAuc": pr_auc(yte, rule), "rocAuc": roc_auc(yte, rule)},
                      "isolationForestOnly": {"prAuc": pr_auc(yte, nov), "rocAuc": roc_auc(yte, nov)},
                      "randomPrAuc": float(yte.mean())},
        "byAnomalyType": by_type,
        "warmVsColdStart": {"warmPrAuc": pr_auc(yte[warm], pte[warm]), "coldPrAuc": pr_auc(yte[~warm], pte[~warm]), "coldShare": float(1 - warm.mean())},
    }
    return m, {"metrics": metrics, "reference": reference_edges(Xtr, F.REQUEST_FEATURES)}


def _checkpoints(sims, idx, fracs=(0.25, 0.5, 0.75)):
    X, y, meta = [], [], []
    for i in idx:
        s = sims[i]
        m = s.mandate
        life = m["expiresAt"] - m["createdAt"]
        for f in fracs:
            t0 = int(m["createdAt"] + f * life)
            sub = s.truncated(t0)
            feats = F.checkpoint_features(sub, t0)
            if feats["util"] >= 0.9:  # already exhausted: nothing to warn about
                continue
            X.append([feats[k] for k in F.CHECKPOINT_FEATURES])
            y.append(int(s.exhausted))
            meta.append((i, t0))
    return np.asarray(X, float), np.asarray(y), meta


def train_distress(sims, seed: int, fc_cfg=None) -> tuple[dm.DistressModel, dict]:
    tr, va, te = _split(len(sims))
    Xtr, ytr, _ = _checkpoints(sims, tr)
    Xva, yva, _ = _checkpoints(sims, va)
    Xte, yte, mte = _checkpoints(sims, te)
    m = dm.DistressModel(seed).fit(Xtr, ytr, Xva, yva)
    pva, pte = m.proba(Xva), m.proba(Xte)
    m.thresholds = {"medium": float(np.quantile(pva, 1 - max(yva.mean(), 0.05) * 1.5)), "high": threshold_for_fpr(yva, pva, 0.10)}
    m.thresholds["medium"] = min(m.thresholds["medium"], m.thresholds["high"])
    base = m.baseline_proba(Xte)
    heur = dm.DistressModel.heuristic(Xte, m.features)
    # the statistical forecast's own opinion, scored on the same checkpoints
    pf = []
    for (i, t0) in mte:
        f = fc.forecast(sims[i].mandate, sims[i].truncated(t0), t0, fc_cfg or fc.ForecastConfig())
        pf.append(f["exhaustion"]["probBeforeExpiry"] if f["status"] == "ok" else np.nan)
    pf = np.asarray(pf)
    ok = ~np.isnan(pf)
    metrics = {
        "split": {"train": len(Xtr), "validation": len(Xva), "test": len(Xte), "exhaustedRate": {"train": float(ytr.mean()), "test": float(yte.mean())}},
        "algorithm": m.algorithm, "validationBrier": m.candidate_brier,
        "test": {"prAuc": pr_auc(yte, pte), "prAucCI95": bootstrap_ci(yte, pte, pr_auc), "rocAuc": roc_auc(yte, pte), "brier": brier(yte, pte), "ece": ece(yte, pte),
                 "atHigh": prf_at(yte, pte, m.thresholds["high"]), "reliability": reliability(yte, pte)},
        "baselines": {"logisticRegression": {"prAuc": pr_auc(yte, base), "rocAuc": roc_auc(yte, base), "brier": brier(yte, base)},
                      "projectedUtilHeuristic": {"prAuc": pr_auc(yte, heur), "rocAuc": roc_auc(yte, heur), **{k: v for k, v in prf_at(yte, heur, 0.5).items() if k in ("precision", "recall", "f1")}},
                      "bootstrapForecastProbability": {"prAuc": pr_auc(yte[ok], pf[ok]), "rocAuc": roc_auc(yte[ok], pf[ok]), "brier": brier(yte[ok], pf[ok]), "coverage": float(ok.mean())},
                      "randomPrAuc": float(yte.mean())},
    }
    return m, {"metrics": metrics, "reference": reference_edges(Xtr, F.CHECKPOINT_FEATURES)}


def train_recon(samples: list[dict], seed: int) -> tuple[rc.ReconModel, dict]:
    tr, va, te = _split(len(samples))
    def rows(idx):
        X, Y, g, k = rc.build_rows([samples[i] for i in idx])
        return X, Y, np.asarray(k)
    Xtr, Ytr, _ = rows(tr)
    Xva, Yva, _ = rows(va)
    Xte, Yte, kte = rows(te)
    m = rc.ReconModel(seed).fit(Xtr, Ytr, Xva, Yva)
    ix = {n: i for i, n in enumerate(F.RECON_FEATURES)}
    out = {"split": {"trainRows": len(Xtr), "validationRows": len(Xva), "testRows": len(Xte), "trainPayments": len(tr), "testPayments": len(te)}}
    for t in rc.TARGETS:
        p = m.proba(Xte, t)
        y = Yte[t]
        out[t] = {"prAuc": pr_auc(y, p), "prAucCI95": bootstrap_ci(y, p, pr_auc), "baseRateBrier": float(y.mean() * (1 - y.mean())), "rocAuc": roc_auc(y, p), "brier": brier(y, p), "ece": ece(y, p), "positiveRate": float(y.mean()),
                  "at0.5": prf_at(y, p, 0.5), "reliability": reliability(y, p)}
    # baselines the model must beat
    states_ok = sum(Xte[:, ix[f"state_{s}"]] for s in ("SUCCESS", "VERIFIED", "PARTIALLY_REFUNDED", "DISPUTED", "REFUNDED", "REVERSED"))
    out["baselines"] = {
        "moneyMoved_engineStateOnly": {"prAuc": pr_auc(Yte["moneyMoved"], states_ok), "rocAuc": roc_auc(Yte["moneyMoved"], states_ok)},
        "attention_timeoutWithoutConfirmation": {"prAuc": pr_auc(Yte["attention"], Xte[:, ix["has_timeout"]] * (1 - Xte[:, ix["has_complete"]])),
                                                 **{k: v for k, v in prf_at(Yte["attention"], Xte[:, ix["has_timeout"]] * (1 - Xte[:, ix["has_complete"]]), 0.5).items() if k in ("precision", "recall", "f1")}},
    }
    # the case that matters most: the app timed out and PayPal has said nothing yet
    sel = (Xte[:, ix["has_timeout"]] == 1) & (Xte[:, ix["n_webhook"]] == 0) & (Xte[:, ix["n_poll"]] == 0)
    if sel.sum() >= 20:
        p = m.proba(Xte[sel], "moneyMoved")
        y = Yte["moneyMoved"][sel]
        out["afterTimeoutBeforePayPal"] = {"rows": int(sel.sum()), "moneyMovedRate": float(y.mean()), "prAuc": pr_auc(y, p), "brier": brier(y, p), "baseRateBrier": float(y.mean() * (1 - y.mean())),
                                           "engineStateWouldSay": "UNKNOWN (no money-movement information)"}
    by_k = {}
    for kk in (1, 2, 3, 4):
        s = kte == kk
        if s.sum() >= 30:
            by_k[str(kk)] = {"rows": int(s.sum()), "attentionPrAuc": pr_auc(Yte["attention"][s], m.proba(Xte[s], "attention"))}
    out["byEventsSeen"] = by_k
    return m, {"metrics": out, "reference": reference_edges(Xtr, F.RECON_FEATURES)}


def _env() -> dict:
    return {"python": sys.version.split()[0], "numpy": np.__version__, "scikit-learn": sklearn.__version__, "scipy": scipy.__version__, "ltml": __version__}


def _md(report: dict) -> str:
    r, d, c, f = report["risk"], report["distress"], report["recon"], report["forecast"]
    L = [f"# LedgerTrue model evaluation", "", f"> {DATA_NOTE}", "", f"Generated {report['generatedAt']}, seed {report['seed']}, {report['mandates']} simulated mandates, {report['payments']} simulated payments.", ""]
    L += ["## 1. Spend risk (supervised prior + isolation-forest novelty)", "",
          f"Temporal split by mandate (train first 60%, validation next 15%, test last 25%). Test rows: {r['split']['test']}, anomaly rate {r['split']['anomalyRate']['test']:.1%}.", "",
          "| Model | PR-AUC | ROC-AUC |", "|---|---|---|",
          f"| Gradient boosting + isotonic (deployed) | {r['test']['prAuc']:.3f} (95% CI {r['test']['prAucCI95'][0]:.2f}-{r['test']['prAucCI95'][1]:.2f}) | {r['test']['rocAuc']:.3f} |",
          f"| Hand-written rule score | {r['baselines']['ruleScore']['prAuc']:.3f} | {r['baselines']['ruleScore']['rocAuc']:.3f} |",
          f"| Isolation forest alone (unsupervised) | {r['baselines']['isolationForestOnly']['prAuc']:.3f} | {r['baselines']['isolationForestOnly']['rocAuc']:.3f} |",
          f"| Random | {r['baselines']['randomPrAuc']:.3f} | 0.500 |", "",
          "| Operating point | Threshold | Precision | Recall | F1 | False-positive rate |", "|---|---|---|---|---|---|"]
    for k, lab in (("atHigh", "High (guard escalation)"), ("atMedium", "Medium")):
        o = r["test"][k]
        L.append(f"| {lab} | {o['threshold']:.3f} | {o['precision']:.3f} | {o['recall']:.3f} | {o['f1']:.3f} | {o['falsePositiveRate']:.4f} |")
    L += ["", f"Calibration on test: Brier {r['test']['brier']:.4f}, ECE {r['test']['ece']:.4f}.", "", "Recall by injected anomaly type:", "", "| Type | n | recall @ high | recall @ medium |", "|---|---|---|---|"]
    for t, v in r["byAnomalyType"].items():
        L.append(f"| {t} | {v['n']} | {v['recallAtHigh']:.2f} | {v['recallAtMedium']:.2f} |")
    w = r["warmVsColdStart"]
    L += ["", f"Agents with fewer than 5 prior requests ({w['coldShare']:.0%} of test rows) are scored with less certainty: PR-AUC {w['coldPrAuc']:.3f} cold vs {w['warmPrAuc']:.3f} warm.", ""]
    L += ["## 2. Budget burn forecast (recency-weighted bootstrap)", "",
          f"Rolling-origin backtest on {f['n']} (mandate, origin) pairs, horizon {f['horizonFractionOfLife']:.0%} of the mandate's life. Errors are fractions of the budget.", "",
          "| Method | MAE | RMSE |", "|---|---|---|"]
    for k, lab in (("bootstrapP50", "Bootstrap median (deployed)"), ("runRateBaseline", "Run-rate since start"), ("recentRateBaseline", "Recent-quarter run-rate"), ("noChangeBaseline", "No change")):
        L.append(f"| {lab} | {f[k]['mae']:.4f} | {f[k]['rmse']:.4f} |")
    L += ["", f"80% prediction interval covers {f['intervalCoverage80']:.1%} of outcomes on the test set (target 80%); mean width {f['intervalWidthMean']:.2f} of budget. "
          f"Before conformal calibration it covered {f['uncalibratedTest']['intervalCoverage80']:.1%}. Chosen half-life {f['calibration']['chosenHalfLife']}, interval scale {f['calibration']['intervalScale']:.2f}, fitted on training and validation mandates only.", ""]
    L += ["## 3. Budget exhaustion early warning", "",
          f"Checkpoints at 25/50/75% of life, excluding mandates already at 90% committed. Test rows {d['split']['test']}, exhausted rate {d['split']['exhaustedRate']['test']:.1%}.", "",
          "| Model | PR-AUC | ROC-AUC | Brier |", "|---|---|---|---|",
          f"| {d['algorithm']} + isotonic (deployed, chosen on validation) | {d['test']['prAuc']:.3f} (95% CI {d['test']['prAucCI95'][0]:.2f}-{d['test']['prAucCI95'][1]:.2f}) | {d['test']['rocAuc']:.3f} | {d['test']['brier']:.4f} |"]
    b = d["baselines"]
    L += [f"| Logistic regression (uncalibrated baseline) | {b['logisticRegression']['prAuc']:.3f} | {b['logisticRegression']['rocAuc']:.3f} | {b['logisticRegression']['brier']:.4f} |",
          f"| Bootstrap forecast P(exhaust) | {b['bootstrapForecastProbability']['prAuc']:.3f} | {b['bootstrapForecastProbability']['rocAuc']:.3f} | {b['bootstrapForecastProbability']['brier']:.4f} |",
          f"| Projected-utilisation >= 90% rule | {b['projectedUtilHeuristic']['prAuc']:.3f} | {b['projectedUtilHeuristic']['rocAuc']:.3f} | n/a |",
          f"| Random | {b['randomPrAuc']:.3f} | 0.500 | n/a |", "", f"Calibration on test: ECE {d['test']['ece']:.4f}.", ""]
    L += ["## 4. Ghost-balance early warning (labels from the real reconciler)", "",
          f"{c['split']['trainPayments']} training payments, {c['split']['testPayments']} test payments ({c['split']['testRows']} test rows: one per delivered event, plus a post-silence row).", "",
          "| Target | PR-AUC | ROC-AUC | Brier | ECE | Positive rate |", "|---|---|---|---|---|---|"]
    for t in rc.TARGETS:
        v = c[t]
        L.append(f"| {t} | {v['prAuc']:.3f} (CI {v['prAucCI95'][0]:.2f}-{v['prAucCI95'][1]:.2f}) | {v['rocAuc']:.3f} | {v['brier']:.4f} | {v['ece']:.4f} | {v['positiveRate']:.1%} |")
    bl = c["baselines"]
    L += ["", f"Baselines: engine-state-only moneyMoved PR-AUC {bl['moneyMoved_engineStateOnly']['prAuc']:.3f}; rule 'timeout and no confirmation' for attention PR-AUC {bl['attention_timeoutWithoutConfirmation']['prAuc']:.3f} (precision {bl['attention_timeoutWithoutConfirmation']['precision']:.2f}, recall {bl['attention_timeoutWithoutConfirmation']['recall']:.2f})."]
    if "afterTimeoutBeforePayPal" in c:
        a = c["afterTimeoutBeforePayPal"]
        L += ["", f"Hardest case, app timed out and PayPal has said nothing ({a['rows']} test rows): money actually moved in {a['moneyMovedRate']:.1%} of them; "
              f"the engine itself can only say UNKNOWN here. Model PR-AUC {a['prAuc']:.3f}, Brier {a['brier']:.4f}, versus a constant base-rate Brier of {a['baseRateBrier']:.4f}. "
              "In this slice the model adds essentially nothing over the base rate, and that base rate is an assumption of the simulator (most timeouts are slow captures that later succeed), not a measured PayPal statistic. Do not quote it as one."]
    L += ["", "## 5. Not evaluated", "", "- Real-world fraud detection: no real labelled data exists.",
          "- Invoice / receipt OCR: out of scope for this product (no invoices in the data model).",
          "- Deep learning: not used; the data is small and tabular, and gradient boosting plus explicit baselines is the honest choice.",
          "- XGBoost / LightGBM / statsmodels: not installable in the build environment. sklearn's HistGradientBoosting is the same family of model.", ""]
    return "\n".join(L)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--mandates", type=int, default=700)
    ap.add_argument("--recon-data", default=str(ROOT / "data" / "recon_sim.jsonl"))
    ap.add_argument("--out", default=str(registry.MODELS_DIR))
    ap.add_argument("--report", default=str(ROOT / "reports"))
    ap.add_argument("--no-promote", action="store_true")
    a = ap.parse_args(argv)
    t0 = time.time()
    out = Path(a.out)

    print(f"[1/5] simulating {a.mandates} mandates (seed {a.seed})")
    sims = synth.portfolio(a.seed, a.mandates)
    print("[2/5] spend risk")
    risk_m, risk_i = train_risk(sims, a.seed)
    print("[3/5] forecast backtest + exhaustion")
    tr, va, te = _split(len(sims))
    fc_cfg, fc_cal = fc.calibrate([sims[i] for i in list(tr) + list(va)])
    fc_metrics = fc.backtest([sims[i] for i in te], fc_cfg)
    fc_metrics["calibration"] = fc_cal
    fc_metrics["uncalibratedTest"] = {k: v for k, v in fc.backtest([sims[i] for i in te]).items() if k in ("intervalCoverage80", "intervalWidthMean")}
    dist_m, dist_i = train_distress(sims, a.seed, fc_cfg)
    print("[4/5] ghost-balance early warning")
    samples = rc.load_samples(a.recon_data)
    rec_m, rec_i = train_recon(samples, a.seed)

    report = {"note": DATA_NOTE, "generatedAt": time.strftime("%Y-%m-%d %H:%M:%SZ", time.gmtime()), "seed": a.seed, "mandates": a.mandates, "payments": len(samples),
              "risk": risk_i["metrics"], "forecast": fc_metrics, "distress": dist_i["metrics"], "recon": rec_i["metrics"], "environment": _env()}

    # promotion gate: each deployed model must beat its simple baseline, and must not regress against the live version
    def prev_metric(name: str, getter):
        mf = registry.manifest(name, root=out)
        try:
            return getter(mf["metrics"]) if mf else None
        except (KeyError, TypeError):
            return None

    checks = []
    def gate(name, new, baseline, prev):
        ok_base = new > baseline
        ok_prev = prev is None or new >= prev - 0.02
        checks.append({"model": name, "newPrAuc": round(new, 4), "baselinePrAuc": round(baseline, 4), "livePrAuc": None if prev is None else round(prev, 4), "pass": bool(ok_base and ok_prev)})
    gate("risk", risk_i["metrics"]["test"]["prAuc"], max(risk_i["metrics"]["baselines"]["ruleScore"]["prAuc"], risk_i["metrics"]["baselines"]["randomPrAuc"]), prev_metric("risk", lambda m: m["test"]["prAuc"]))
    gate("distress", dist_i["metrics"]["test"]["prAuc"], dist_i["metrics"]["baselines"]["randomPrAuc"], prev_metric("distress", lambda m: m["test"]["prAuc"]))
    gate("recon", rec_i["metrics"]["attention"]["prAuc"], rec_i["metrics"]["attention"]["positiveRate"], prev_metric("recon", lambda m: m["attention"]["prAuc"]))
    passed = all(c["pass"] for c in checks)
    report["promotionGate"] = {"passed": passed, "checks": checks}
    promote = passed and not a.no_promote

    base_manifest = {"dataSource": "synthetic", "dataNote": DATA_NOTE, "seed": a.seed, "environment": _env()}
    print(f"[5/5] saving (promote={promote})")
    fv = registry.save("forecast", fc_cfg, {**base_manifest, "metrics": fc_metrics, "features": [], "reference": {}}, root=out, promote=promote)
    print(f"   forecast: {fv}")
    for name, model, info, extra in (
        ("risk", risk_m, risk_i, {"features": risk_m.features, "thresholds": risk_m.thresholds, "trainedOnMandates": a.mandates}),
        ("distress", dist_m, dist_i, {"features": dist_m.features, "thresholds": dist_m.thresholds, "trainedOnMandates": a.mandates}),
        ("recon", rec_m, rec_i, {"features": rec_m.features, "thresholds": rec_m.thresholds, "trainedOnPayments": len(samples)}),
    ):
        v = registry.save(name, model, {**base_manifest, **extra, "metrics": info["metrics"], "reference": info["reference"]}, root=out, promote=promote)
        print(f"   {name}: {v}")
    rep = Path(a.report)
    rep.mkdir(parents=True, exist_ok=True)
    (rep / "evaluation.json").write_text(json.dumps(report, indent=2))
    (rep / "evaluation.md").write_text(_md(report))
    print(f"done in {time.time() - t0:.0f}s; report: {rep / 'evaluation.md'}")
    if not passed:
        print("PROMOTION GATE FAILED:", json.dumps(checks))
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
