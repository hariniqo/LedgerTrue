# LedgerTrue: Proof of Intent

**Don't just trust the payment. Verify the intent.**

LedgerTrue lets a person or company give an AI agent a spending **mandate**: a budget, allowed merchants, an expiry and a goal, signed in the owner's own browser. Every request, rule check and PayPal result goes into a **hash-chained, signed ledger**. A **Proof Card** with a QR code lets anyone re-verify the whole story in their own browser, and editing any record visibly breaks it.

> **The claim:** even a fully hijacked AI agent cannot spend outside what the owner signed. Plain code decides every payment, and the AI is only advisory. This is tested in [`test/liveagent.test.js`](test/liveagent.test.js).

*Independent hackathon project. Not affiliated with or endorsed by PayPal.*

---

## See it in 60 seconds

You need Node 20 or newer. There is nothing to install.

```bash
cp .env.example .env   # turns on the loopback-only local demo
npm test               # 145 tests, zero dependencies
npm start              # open http://localhost:3000
```

Press **Run** on the first demo scenario. In order, you will see:

1. An AI buying agent makes a purchase inside its mandate. It is **approved** and becomes a PayPal hold.
2. The agent reads a page with hidden hijack text. Its request is **blocked by code**.
3. The agent asks for something expensive. It is **sent to the owner to sign**.

Then open the **Proof Card**, press **Verify**, and use the **Tamper lab** to edit one amount. Watch the chain break.

With no PayPal credentials, a built-in simulator runs the same flow and labels itself as a simulator. With no AI key, deterministic rules and text run instead, and the app says so.

---

## What it does

| Problem | LedgerTrue's answer |
|---|---|
| An agent can spend more than you intended | Signed **mandate**. Hard rules (budget, caps, merchants, expiry) block. Soft rules only escalate to the owner. |
| A hijacked agent asks for something odd | The rule engine is plain code that cannot be prompt-injected. AI can flag, never approve. |
| Nobody can prove afterward what was allowed | **Hash-chained, guard-signed ledger** with a public **Proof Card** and offline verifier. |
| The operator could rewrite history | Signed, hash-linked **anchors** you can copy somewhere the operator cannot edit. |
| PayPal took the money but the checkout timed out (the "Ghost Balance") | **Reconciler** asks PayPal and settles exactly once. |

### How a payment flows

```
Owner signs mandate (block 0)
  -> Agent asks (REQUEST) -> Guard replays rules (DECISION: approved / blocked / needs owner)
  -> [Owner signs the exact decision]      (APPROVAL)
  -> PayPal authorize = hold               (HOLD)      reduces available budget
  -> PayPal capture   = settled            (CAPTURE)
  -> or PayPal void   = released           (VOID)      budget restored
```

If the capture reply is lost, the reconciler polls PayPal and records one `CAPTURE` block (`via: reconciler-poll`) and one `RECON` note.

---

## How PayPal and AI are used

**PayPal (sandbox only).** Orders v2 with `intent=AUTHORIZE`, order authorize, Payments v2 capture and void, `PayPal-Request-Id` idempotency keys, webhook signature verification, and order polling for reconciliation. Each settlement stores a hash of PayPal's own reply as evidence. This is evidence, not a PayPal signature. No live transactions are part of the demo.

**AI (advisory only).** Three uses: a goal-drift flag that can only ask the owner, plain-English summaries of a mandate, and reconciliation notes. A read-only assistant answers questions from bounded records. AI text is shown only if every number, ID and link in it matches the real facts. Otherwise a deterministic version is shown. `AI_DISABLED=true` removes every model call. Details: [`docs/RESPONSIBLE_AI.md`](docs/RESPONSIBLE_AI.md).

**AI/ML intelligence layer (optional).** Spend-risk scores, budget burn forecasts with uncertainty bands, exhaustion probability and a health index, shown on the **Intelligence** page. It works with no setup using a rule baseline. Run the Python service for the trained models.

> **Honest limits:** the models are trained on **simulated data only**. The numbers in [`ml/reports/evaluation.md`](ml/reports/evaluation.md) show the pipeline works, not how it would perform on real fraud. The evaluation also reports weak spots, such as low recall on spikes and rare merchants. See [`docs/AI_ML.md`](docs/AI_ML.md).

---

## Architecture

| Area | Where | Idea |
|---|---|---|
| Rules | `shared/rules.js` | Pure functions with no clock and no I/O, so anyone can replay them. |
| Chain | `shared/verify.js`, `src/proof/chainStore.js` | Per-mandate append-only chain. Block hash is SHA-256 of canonical JSON, signed by the guard (ECDSA P-256). Stored as JSONL and re-verified on boot. |
| Owner signatures | `public/js/keys.js` | A non-extractable browser key signs the mandate, approvals (bound to the exact decision hash) and revocation. |
| Engine | `src/proof/engine.js` | Request, decision, approval, hold, capture, void, with a per-chain mutex so concurrent agents cannot overspend. |
| PayPal | `src/paypal.js`, `src/proof/gateway.js` | Authorize, capture, void with idempotency, plus a simulator gateway. |
| AI | `src/proof/goalCheck.js`, `chainExplainer.js`, `src/assistant.js` | Advisory only. Agent text is treated as untrusted. Deterministic fallback. |
| Anchors | `shared/anchors.js`, `src/proof/anchors.js` | Guard-signed, hash-linked anchor for every block. |
| Proof file | `GET /api/mandates/:id/proof`, `tools/verify-proof.mjs` | Chain and anchors in one file, verifiable in the browser or offline. |
| Owner key backup | `shared/keyBackup.js` | Passphrase-encrypted backup (PBKDF2 and AES-GCM) of a recoverable owner key. |
| Agent connector | `examples/mcp-server.mjs` | MCP server: any MCP agent spends only through a mandate and cannot override a block. |
| Reconciler | `src/reconciler.js`, `stateMachine.js`, `ledger.js` | Event-sourced payment state and a double-entry ledger. |
| ML service | `ml/ltml/` | Spend risk, forecast, exhaustion and recon models, trained on simulated data. |
| Frontend | `public/` | No build step, ES modules, no `innerHTML`. |

The runtime has **no npm dependencies**.

---

## Plug in a real agent (MCP)

```bash
LEDGERTRUE_URL=http://localhost:3000 MANDATE_ID=m_... AGENT_ID=my-agent node examples/mcp-server.mjs
```

Add it to Claude Desktop, Claude Code or any MCP client as a stdio server. Tools: `request_payment`, `check_budget`, `proof_link`. Set `AGENT_TOKEN` when the server runs with tokens.

## Verify a proof offline

```bash
node tools/verify-proof.mjs proof.json
node tools/verify-proof.mjs proof.json --guard <keyId> --anchors your-copy.json
```

To make history independent of the operator, copy the anchors somewhere you control. Set `ANCHOR_WEBHOOK_URL`, or run `node tools/anchor-mirror.mjs <server-url> mirror/anchors.json`. The mirror **fails if any earlier anchor changed or disappeared**. A chain rewritten after the anchors were copied fails verification, even if it was re-signed with the real guard key. The included workflow `.github/workflows/anchor-mirror.yml` does this every 15 minutes (set the `ANCHOR_URL` repository variable).

---

## Configuration

Copy `.env.example` to `.env`. **Never commit `.env` or `data/`** (both are gitignored). Run `node tools/preflight.mjs` before publishing.

**Real PayPal sandbox**

1. Create a sandbox app at developer.paypal.com and set `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` in `.env`.
2. PayPal sandbox may not accept INR, so USD is used when PayPal is configured (override with `DEMO_CURRENCY`).
3. Run `node tools/sandbox-check.mjs` for a hold, sandbox-buyer approval and capture, or `--void` to release instead. It refuses to run unless `PAYPAL_ENV=sandbox`.

**Turn the AI on** (any OpenAI-compatible provider, including NVIDIA NIM, Groq or Gemini):

```bash
AI_API_KEY=your-key
AI_BASE_URL=https://integrate.api.nvidia.com/v1
AI_MODEL=a-model-name-from-the-provider
```

The older `NVIDIA_*` variable names still work. The key stays on the server and is never sent to the browser. To check a real, harmless completion, POST `{}` to `/api/assistant/health` with the agent token.

**Run the ML service (optional):**

```bash
pip install -r ml/requirements.txt
npm run ml:data && npm run ml:train
npm run ml:serve         # then set ML_SERVICE_URL in .env
npm run ml:test          # 26 Python tests
```

Set `ML_RISK_ESCALATION=true` to let a high risk score ask the owner to review. It never blocks and never approves.

**Beyond a local demo:** set `DEMO_MODE=false` plus `OPERATOR_TOKEN` and `AGENT_TOKEN` (the server refuses to start without them). Live PayPal also needs `PAYPAL_ENV=live` and `PAYPAL_WEBHOOK_ID`, and the server refuses live PayPal while demo mode is on. Put it behind TLS and back up `data/`, including the guard key. Use a KMS in production. See [`docs/DEPLOY.md`](docs/DEPLOY.md).

---

## API (selected)

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/mandates` | owner signature | Create a mandate (signed block 0) |
| `GET /api/mandates/:id/bundle` | public | The chain, for verification |
| `GET /api/mandates/:id/proof` | public | Chain and anchors as one proof file |
| `POST /api/mandates/:id/requests` | agent | Agent asks to spend |
| `POST /api/mandates/:id/requests/:rid/approval` | owner signature | Approve or reject |
| `POST /api/mandates/:id/requests/:rid/capture` / `void` | operator | Settle or release |
| `POST /api/mandates/:id/revoke` | owner signature | Stop all new spending |
| `GET /verify/:id` | public | Verification page (what the QR opens) |
| `GET /.well-known/ledgertrue-guard.json` | public | The guard's public key |
| `/api/events`, `/api/webhooks/paypal`, `/api/payments/*` | as before | Reconciliation engine |

---

## Project status and honest limits

- **Tested:** 145 Node tests and 26 Python tests. Reviewed in [`SECURITY_SCORECARD.md`](SECURITY_SCORECARD.md) (self-assessed 70/100, not a certification).
- **Existing project, significantly updated:** the Ghost Balance reconciler pre-dates the submission period. Proof of Intent, PayPal authorize/capture/void, anchors, offline proofs, the MCP connector, the assistant and the hardening were added during it. Full list in [`docs/AUDIT.md`](docs/AUDIT.md).
- **Not claimed:** detecting every prompt injection (the guarantee is that code limits what a hijacked agent can do), production readiness, or provider-signed PayPal receipts.
- **Third-party services:** PayPal sandbox APIs, optional AI provider, and Google Fonts loaded by the browser.

## Read next

- [`docs/PITCH.md`](docs/PITCH.md): the one-sentence problem, a 3-minute demo script and honest answers to judge questions
- [`docs/RESPONSIBLE_AI.md`](docs/RESPONSIBLE_AI.md) and [`docs/AI_ML.md`](docs/AI_ML.md): AI limits, evaluation and data handling
- [`docs/AUDIT.md`](docs/AUDIT.md): every flaw found in v0.1 and how it was fixed
- [`docs/SUBMISSION.md`](docs/SUBMISSION.md): Devpost text

## License

MIT. See [LICENSE](LICENSE).
