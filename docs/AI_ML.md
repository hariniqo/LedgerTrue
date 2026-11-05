# LedgerTrue AI/ML layer

Advisory intelligence added on top of the signed mandate ledger and the Ghost Balance reconciler. Nothing here approves a payment, changes a limit, writes to a chain or moves money.

## 1. Read this first

- **Every model is trained on simulated data.** There is no real customer history and no real fraud label in this repository. Metrics show that the pipeline works and beats its baselines on data with known structure. They are not production performance, and the models are not production-ready.
- Outputs are estimates. Each carries `isEstimate: true`, a model version, a confidence (or `null`), evidence and a data-quality flag.
- The product works with no Python at all. A deterministic rule baseline produces the same output shape.
- Out of scope, and not faked: document intelligence (invoice/receipt OCR). LedgerTrue has no invoice documents in its data model. `/api/intel/status` reports it as unsupported.

## 2. Architecture

```
 browser  ->  Node server (src/server.js)  ->  guard / ProofEngine  ->  signed chains (source of truth)
                  |                                   ^
                  | read-only                         | escalate-only flag (ML_RISK_REVIEW, soft check)
                  v                                   |
          src/intel/orchestrator.js  --slim.js-->  client.js (bearer token, 1.5s timeout, circuit breaker)
             5 agents + decision engine                       |
             baseline.js (fallback)                           v
                                              ml/ltml/service.py (Starlette, 127.0.0.1:8808)
                                              risk, distress, recon, forecast models (SHA-256 verified)
```

| Agent | Question | ML engine | Baseline |
|---|---|---|---|
| fraud-intelligence | Is this request unusual for this agent? | HGB + isotonic, plus IsolationForest novelty | burst, duplicate, amount-vs-history rules |
| burn-forecast | Will spend reach the budget by expiry? | recency-weighted bootstrap, conformal-scaled p10/p50/p90 | none (refuses without history) |
| exhaustion-risk | Probability the budget runs out | logistic regression + isotonic (beat GBM on validation) | straight-line |
| ghost-early-warning | Which payments need attention? | HGB attention and money-moved models | state-machine rules |
| agent-reliability | How reliable is each agent? | Wilson intervals | same |

The **central decision engine** (`validateEnvelope`) rejects any agent output with bad enums, probabilities outside 0..1, evidence citing request ids that do not exist, out-of-order forecast quantiles, or a committed total that differs from the server ledger. Rejected agents show as `unknown` and are listed in the trace. A mismatching ML response is discarded and the baseline is used.

### Safety properties (each has a test in `test/intel.test.js`)
1. Read-only: chain head and summaries are identical before and after analysis. Intel source files contain no reference to request/approve/capture/void/revoke or ledger writers.
2. Escalate-only: a high score adds the soft check `ML_RISK_REVIEW`, which can only turn an approved request into `NEEDS_APPROVAL`. It never blocks and never approves. Hard rules still decide.
3. Not forgeable: the flag is built by the server. A `riskFlag` in an agent's request body is ignored.
4. Replay-safe: the flag is recorded in the REQUEST block and the verifier replays it. Old chains replay unchanged because the check exists only when a flag was recorded.
5. Data minimisation: `slim.js` removes free text, signatures, hashes and PayPal ids before anything leaves Node.
6. Graceful degradation: ML down, slow or tampered means baseline, never an error to the user.

## 3. Model inventory

| Model | Purpose | Algorithm | Test PR-AUC | Artifact |
|---|---|---|---|---|
| risk | request anomaly prior | HistGradientBoosting + isotonic, IsolationForest novelty | 0.732 | `ml/models/risk/<ver>` |
| distress | budget exhaustion | logistic regression + isotonic | 0.696 | `ml/models/distress/<ver>` |
| recon | payment attention, money moved | HistGradientBoosting | 0.699 / 0.964 | `ml/models/recon/<ver>` |
| forecast | burn bands | bootstrap + conformal scale | MAE 0.118 vs 0.128 run-rate | `ml/models/forecast/<ver>` |

Artifacts are joblib files with a manifest; the loader refuses a SHA-256 mismatch. A promotion gate requires each model to beat its baseline and not regress more than 0.02 against the live version. Full numbers, confidence intervals, calibration and slices: `ml/reports/evaluation.md`.

## 4. Evaluation: what the numbers do and do not say
- Temporal split by mandate (60/15/25), no look-ahead in features, one feature code path for training and serving.
- Risk: PR-AUC 0.732 vs rule baseline 0.386 and random 0.051. At the high threshold: precision 0.77, recall 0.64, false-positive rate 1.0%.
- Recall by injected type at the high threshold: duplicate 1.00, structuring 1.00, burst 0.76, off-hours 0.25, **spike 0.11, rare merchant 0.02**. Those two are weak and left weak; the simulator was not tuned to hide it.
- Forecast interval coverage 78.8% against an 80% target (57.5% before conformal scaling).
- Recon: the slice "after timeout, before PayPal speaks" shows no lift over base rate. The 84% money-moved base rate is a simulator assumption.
- Anomalies are injected by the same code that defines "normal", so real-world recall will differ. The first job with real data is to re-measure.

## 5. API

Node (agent role required when tokens are set): `GET /api/intel/status`, `/api/intel/overview`, `/api/intel/payments`, `/api/mandates/:id/intel`; `POST /api/intel/synthetic` (demo mode only, labelled synthetic).

ML service: `GET /healthz`, `/v1/models`, `/v1/monitor`; `POST /v1/analyze/mandate`, `/v1/analyze/payments`, `/v1/score/request`, `/v1/synthetic/mandate`.

## 6. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ML_SERVICE_URL` | unset | Enables the ML engine. Unset means baseline only. |
| `ML_SERVICE_TOKEN` | unset | Bearer token. Required by the service for non-loopback binding. |
| `ML_SERVICE_TIMEOUT_MS` | 1500 | Per-call timeout. |
| `ML_RISK_ESCALATION` | false | When true, scores can add `ML_RISK_REVIEW`. |
| `ML_RISK_THRESHOLD` | 0.5 | Score at or above this escalates (baseline uses 0.8). |
| `ML_PORT` / `ML_HOST` | 8808 / 127.0.0.1 | Service bind address. |

## 7. Run, train, deploy
```
pip install -r ml/requirements.txt          # numpy pandas scikit-learn scipy joblib pydantic starlette uvicorn
npm run ml:data                              # regenerate payment simulation via the real reconciler
npm run ml:train                             # trains, evaluates, applies the promotion gate (exit 2 on fail)
npm run ml:serve                             # service on 127.0.0.1:8808
ML_SERVICE_URL=http://127.0.0.1:8808 npm start
npm test && npm run ml:test
```
Model files are tied to the scikit-learn version that trained them (`requirements.txt` pins it); after changing the version, retrain with `npm run ml:train`.

Deployment: run the service on a private network next to the Node server; set a long random `ML_SERVICE_TOKEN` on both; never expose it publicly. A `render.yaml` entry is provided as an **untested** starting point. Retraining: train to a new version, review `reports/evaluation.md`, let the gate decide, keep the previous version for rollback (`CURRENT` pointer).

## 8. Security assessment
- Service refuses to bind off loopback without a token; 2 MB body cap, 5000-block cap; chains validated before use.
- Model files are integrity-checked before loading (joblib is pickle: treat the models directory as trusted code and keep it write-protected).
- No secrets are sent to the service; only slimmed structure. Logs do not contain request bodies.
- Prompt injection: no LLM reads agent text for scoring. The copilot only quotes validated estimates and its grounding check still rejects invented numbers.
- Residual risk: an adversarial agent can shape its spending to stay under the model's radar. Hard limits, not the model, are the control.

## 9. Known limitations
Simulated training data only; weak spike and rare-merchant recall; forecasts need 6 time bins and 4 events; no concept-drift retraining automation (PSI is reported, not acted on); health score weights are hand-set; FastAPI, XGBoost, LightGBM and statsmodels were not installable in the build environment, so the service uses Starlette and scikit-learn; no document intelligence.

## 10. Production readiness checklist
- [ ] Re-train and re-evaluate on real, consented, labelled data; replace the simulated claims in the report
- [ ] Agree an owner-reviewed false-positive budget before turning `ML_RISK_ESCALATION` on
- [ ] Private networking and a real secret for `ML_SERVICE_TOKEN`
- [ ] Alerting on PSI `significant_shift` and on `analysesWithRejectedAgents`
- [ ] Model registry on durable storage with backups; rollback drill
- [ ] Independent security review and load test of the service
