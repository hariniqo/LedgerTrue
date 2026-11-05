# LedgerTrue model evaluation

> SIMULATED DATA. Mandate streams come from ml/ltml/synth.py with anomalies injected by construction; payment streams come from tools/gen-recon-dataset.mjs and are labelled by the real reconciler. There is no real fraud and no real customer history here, so these numbers show the pipeline works, not how it performs in production.

Generated 2026-11-05 13:09:49Z, seed 7, 700 simulated mandates, 2500 simulated payments.

## 1. Spend risk (supervised prior + isolation-forest novelty)

Temporal split by mandate (train first 60%, validation next 15%, test last 25%). Test rows: 7648, anomaly rate 5.1%.

| Model | PR-AUC | ROC-AUC |
|---|---|---|
| Gradient boosting + isotonic (deployed) | 0.732 (95% CI 0.69-0.77) | 0.948 |
| Hand-written rule score | 0.386 | 0.847 |
| Isolation forest alone (unsupervised) | 0.425 | 0.871 |
| Random | 0.051 | 0.500 |

| Operating point | Threshold | Precision | Recall | F1 | False-positive rate |
|---|---|---|---|---|---|
| High (guard escalation) | 0.250 | 0.773 | 0.635 | 0.697 | 0.0101 |
| Medium | 0.097 | 0.640 | 0.712 | 0.674 | 0.0216 |

Calibration on test: Brier 0.0215, ECE 0.0069.

Recall by injected anomaly type:

| Type | n | recall @ high | recall @ medium |
|---|---|---|---|
| spike | 47 | 0.11 | 0.28 |
| burst | 84 | 0.76 | 0.86 |
| rare_merchant | 44 | 0.02 | 0.09 |
| off_hours | 51 | 0.25 | 0.47 |
| duplicate | 50 | 1.00 | 1.00 |
| structuring | 116 | 1.00 | 1.00 |

Agents with fewer than 5 prior requests (25% of test rows) are scored with less certainty: PR-AUC 0.594 cold vs 0.756 warm.

## 2. Budget burn forecast (recency-weighted bootstrap)

Rolling-origin backtest on 496 (mandate, origin) pairs, horizon 25% of the mandate's life. Errors are fractions of the budget.

| Method | MAE | RMSE |
|---|---|---|
| Bootstrap median (deployed) | 0.1183 | 0.1753 |
| Run-rate since start | 0.1278 | 0.1889 |
| Recent-quarter run-rate | 0.1574 | 0.2717 |
| No change | 0.1588 | 0.2122 |

80% prediction interval covers 78.8% of outcomes on the test set (target 80%); mean width 0.40 of budget. Before conformal calibration it covered 57.5%. Chosen half-life 1.0, interval scale 1.47, fitted on training and validation mandates only.

## 3. Budget exhaustion early warning

Checkpoints at 25/50/75% of life, excluding mandates already at 90% committed. Test rows 476, exhausted rate 23.7%.

| Model | PR-AUC | ROC-AUC | Brier |
|---|---|---|---|
| logistic_regression + isotonic (deployed, chosen on validation) | 0.696 (95% CI 0.62-0.77) | 0.860 | 0.1119 |
| Logistic regression (uncalibrated baseline) | 0.749 | 0.871 | 0.1087 |
| Bootstrap forecast P(exhaust) | 0.715 | 0.843 | 0.1277 |
| Projected-utilisation >= 90% rule | 0.390 | 0.681 | n/a |
| Random | 0.237 | 0.500 | n/a |

Calibration on test: ECE 0.0298.

## 4. Ghost-balance early warning (labels from the real reconciler)

1500 training payments, 625 test payments (2745 test rows: one per delivered event, plus a post-silence row).

| Target | PR-AUC | ROC-AUC | Brier | ECE | Positive rate |
|---|---|---|---|---|---|
| attention | 0.699 (CI 0.67-0.73) | 0.876 | 0.0735 | 0.0085 | 18.0% |
| moneyMoved | 0.964 (CI 0.96-0.97) | 0.860 | 0.0638 | 0.0209 | 87.8% |

Baselines: engine-state-only moneyMoved PR-AUC 0.934; rule 'timeout and no confirmation' for attention PR-AUC 0.271 (precision 0.78, recall 0.15).

Hardest case, app timed out and PayPal has said nothing (69 test rows): money actually moved in 84.1% of them; the engine itself can only say UNKNOWN here. Model PR-AUC 0.852, Brier 0.1354, versus a constant base-rate Brier of 0.1340. In this slice the model adds essentially nothing over the base rate, and that base rate is an assumption of the simulator (most timeouts are slow captures that later succeed), not a measured PayPal statistic. Do not quote it as one.

## 5. Not evaluated

- Real-world fraud detection: no real labelled data exists.
- Invoice / receipt OCR: out of scope for this product (no invoices in the data model).
- Deep learning: not used; the data is small and tabular, and gradient boosting plus explicit baselines is the honest choice.
- XGBoost / LightGBM / statsmodels: not installable in the build environment. sklearn's HistGradientBoosting is the same family of model.
