# Audit: what was wrong with LedgerTrue v0.1, and what changed

Audited from the zip, the Proof of Intent brief and the Ghost Balance plan. Each row says where the problem was, why it matters, and how it is rectified. "Test" names the automated check that now guards it.

## A. Idea versus code

| # | Finding | Fix | Test |
|---|---|---|---|
| A1 | **The headline idea was not built.** The brief promises mandates, a hash chain, agent rule checks, three-key approval, a Proof Card with QR, tamper detection and PayPal authorize/capture/void. The code only contained the Ghost Balance reconciler. | Built all of it: `shared/` (canonical JSON, signatures, rules, verifier), `src/proof/` (chain store, engine, gateways, AI goal check, demo agents). | `test/proof.test.js` (22) |
| A2 | The brief says "limits are enforced by deterministic code, AI only proposes". Nothing enforced that in code. | The AI goal check returns a flag that can only escalate to the owner. Hard checks (cap, merchant, budget, injection, restricted types) are pure functions that run first. | "a lying AI cannot raise a limit" |
| A3 | PayPal mapping was capture-only. The brief needs authorize (hold), capture (settle), void (release). | `PayPalClient` and `PayPalGateway` now implement Orders v2 `intent=AUTHORIZE`, `/authorize`, and Payments v2 `/authorizations/{id}/capture` and `/void`, with `PayPal-Request-Id` idempotency keys. | gateway tests (mocked PayPal) |

## B. Security

| # | Finding | Severity | Fix | Test |
|---|---|---|---|---|
| B1 | **`.env.example` contained what look like real PayPal and NVIDIA credentials.** | Critical | Replaced with empty placeholders. **You must rotate those keys** (PayPal Developer dashboard, build.nvidia.com): anything that has been in a zip or chat should be treated as leaked. | n/a |
| B2 | No authentication. Anyone could `POST /api/reset`, inject chaos, settle money or post events. | High | Roles: `operator`, `agent`, owner-by-signature, public. `DEMO_MODE=false` refuses to start without tokens (constant-time compare). Reset, chaos and demo routes are demo-only. | "auth: DEMO_MODE=false…" |
| B3 | `POST /api/events` accepted any `source`, including `paypal_poll`, the engine's source of truth. A caller could fake PayPal confirmation. | High | `source` is forced to `app` on that route. | "cannot be used to spoof" |
| B4 | Webhooks were silently accepted unsigned whenever `PAYPAL_WEBHOOK_ID` was empty, including in live mode. | High | Live mode always returns 503 without a webhook id and verifies every configured webhook; no unsigned bypass is supported. | "live mode refuses unsigned webhooks" |
| B5 | "Reset" truncated the persisted event log. An append-only audit log that a button can wipe is not an audit log. | Medium | Reset archives the file to `events.jsonl.<ts>.bak`. | "reset archives…" |
| B6 | The persisted log had no tamper evidence, despite being called immutable. | Medium | Mandate chains are hash-chained and guard-signed, re-verified on boot. A failing chain is quarantined and refuses new blocks. | "persist, reload and re-verify" |
| B7 | Static file guard used `startsWith` on a path (prefix-bypass risk). | Low | `path.relative` check. | "no path traversal" |
| B8 | No security headers, no rate limit, 500 errors echoed upstream messages. | Medium | CSP, `nosniff`, `frame-ancestors 'none'`, rate limiter, generic 500s, JSON-safe PayPal error handling. | "security headers…" |
| B9 | The old UI built HTML by string concatenation with `innerHTML`. Agent-written text is untrusted. | Medium | New UI has no `innerHTML`. Text only enters the DOM as text nodes. | UI run: zero console errors |
| B10 | Live PayPal could be combined with demo authentication or unsigned-webhook override. | High | Live PayPal now requires `DEMO_MODE=false`; unsigned live webhooks always fail, even if a legacy `ALLOW_UNSIGNED_WEBHOOKS` environment variable is set. | Live-mode startup and unsigned-webhook regression tests |
| B11 | Guard-key storage relied on POSIX mode bits, which do not enforce permissions on Windows. | Medium | Unix files are tightened to 0600 and ownership checked. Windows ACLs are made non-inheriting and restricted to the current identity, SYSTEM, and Administrators; existing keys are secured in place. | "chains persist, reload and re-verify" |

## C. Correctness

| # | Finding | Fix | Test |
|---|---|---|---|
| C1 | `toCents` used `Math.round(n*100)`: `"0.295"` became 29 and `1.005` became 100, silently losing money. | Decimal-string parsing with BigInt, rejects extra precision, exponents and negatives. | "toCents: exact decimal parsing" |
| C2 | Concurrent appends were only safe by accident of synchronous code. Hashing and signing are async. | Per-chain `Mutex`. The check, reservation and decision are one atomic step. 50 concurrent requests cannot exceed the budget. | "50 concurrent small requests" |
| C3 | The reconciler's sweep gave up silently after 3 tries. | Capture recovery retries up to 10 times and the UI says when a capture is still unconfirmed. | ghost test |
| C4 | Tail truncation: removing the last blocks of a hash chain leaves it self-consistent. | Receipts pin the head (index + hash). The verifier reports `HEAD` failures. | "removing the tail" |
| C5 | A forger could re-sign a rewritten chain with their own key. | Receipts pin the guard key fingerprint. The server publishes its key at `/.well-known/ledgertrue-guard.json`. | "forger who signs with their own guard key" |

## D. Frontend

| # | Finding | Fix |
|---|---|---|
| D1 | One 259-line HTML file, generic styling, no brand fit, a leftover "My notes" textarea. | Multi-view app (ES modules, no build step), PayPal-family navy and blue palette, own mark, dark mode, mobile layout, keyboard focus, reduced-motion support. |
| D2 | Nothing showed the product's core promise: that you can check it yourself. | Chain tape with in-browser verification, a tamper lab, a public verify page, QR Proof Card. |
| D3 | No place for the owner to sign anything. | Owner key generated in the browser (non-extractable) and used for mandate, approval and revoke. |

## F. Round 2: closing the gaps the scorecard named

| # | Gap | Fix | Test |
|---|---|---|---|
| F1 | A hash chain signed by one server only proves "our server says so". Whoever holds the guard key could rewrite history consistently. | **Anchors**: every block yields a guard-signed, hash-linked anchor, publishable via webhook or the public log. A rewrite or truncation that is internally perfect and re-signed with the real key is still caught against an earlier copy. | "catch a rewrite even when the forger holds the REAL guard key" |
| F2 | Receipts carried no evidence from the payment provider. | Settlements store a **witness**: a hash of PayPal's own reply (simulator marks itself `simulated`). Shown on the Proof Card and verify page. Honest limit: evidence, not a PayPal signature. | "witness: settlements record evidence" |
| F3 | Losing the browser key meant losing control of a mandate. | **Recoverable owner key** with a passphrase-encrypted backup (PBKDF2-SHA256 600k + AES-GCM, bound to the public key) and restore. Default stays non-extractable. | "owner key backup" + browser run |
| F4 | Verification needed the live server. | **Proof file** (chain + anchors) and `tools/verify-proof.mjs`: verify offline on any Node 20 machine. Verify page accepts a file. | "proof file ... verifies offline" |
| F5 | Pending PayPal approvals were lost on restart (E). | Persisted atomically to `PENDING_FILE`; a corrupt file never blocks boot. | "survive a restart" |
| F6 | Agents were only simulated. | **MCP connector** (`examples/mcp-server.mjs`): agent spends only through a mandate; a blocked request tells it not to work around the rule. | "mcp connector" |
| F7 | **My own bug, found in the browser run:** an unescaped apostrophe blanked the public verify page, and the unit tests did not notice. | Fixed, and a test now syntax-checks every browser module. | "every browser module parses" |
| F8 | Boot could anchor a chain that had been edited offline. | Quarantined chains are never anchored; the anchor log refuses to extend itself if it fails its own check. | "restart backfills anchors..." |

## G. Round 3: hackathon rules and responsible AI

| # | Gap | Fix | Test |
|---|---|---|---|
| G1 | No `LICENSE` file although the rules need a detectable open-source license. | MIT `LICENSE` added. | preflight |
| G2 | **Real keys were back in `.env.example`** (PayPal client id and secret, NVIDIA key) and a private `data/guard-key.json` sat in the shared zip. | `tools/preflight.mjs` scans every text file and fails on real-looking secrets, private keys, a missing license or a missing `.gitignore` entry, and never prints a value. Treat any key that was shared as leaked and rotate it. | "preflight: ... leaky copy fails without printing the secret" |
| G3 | **My doc claimed injected text was screened before any model; the code sent it to the model first.** | Goal check now skips the model entirely when the deterministic screen finds hijacking or restricted text, and strips markup from model notes. | "hostile text is never sent to a model" |
| G4 | AI summaries could in principle contain invented facts. | `shared/grounding.js`: model text with any number, ID, hash or link not in the facts is discarded for the deterministic text. Applied to both summaries. | "model text that invents a number is discarded" |
| G5 | No way to turn AI off. | `AI_DISABLED=true` removes every model call. | "kill switch" |
| G6 | The live PayPal path had no repeatable script. | `tools/sandbox-check.mjs` (hold, then capture or void; refuses live mode). The script logic is tested with a fake gateway. **It has not been run against real PayPal from this environment (no credentials, no network).** | "sandbox-check" |
| G7 | Submission material missing. | `docs/SUBMISSION.md`, `docs/VIDEO_SCRIPT.md`, `docs/RESPONSIBLE_AI.md`, `SECURITY.md`, README sections. Items only the entrant can supply are marked `TODO`. | preflight warns on each |

## E. Known limits (stated, not hidden)

- The live PayPal path is unit-tested against mocked responses. It has not been run against a real sandbox from this environment (no network, no credentials). Do one end-to-end sandbox run before the demo.
- PayPal sandbox may reject INR for cross-border accounts. The demo uses INR in the simulator and USD with PayPal (`DEMO_CURRENCY` overrides).
- A hash chain proves the record was not edited after the fact. It does not prove the guard is honest. Production would add an external transparency log and provider-signed receipts.
- Owner-key backup is optional. Clearing site data loses control of mandates signed only by an unbacked key; recovery does not migrate existing mandates to a newly generated key.
- Anchors are only as independent as where you copy them. With no `ANCHOR_WEBHOOK_URL` and no mirrored log they are signed but not external.
- PayPal evidence is a hash of PayPal's reply, not a signature from PayPal.
- A key created non-extractable cannot be backed up. Choosing a recoverable key creates a NEW key; mandates signed by the old key stay with the old key.
- Rate limits and the mutex are per process. Horizontal scale needs a shared store.
