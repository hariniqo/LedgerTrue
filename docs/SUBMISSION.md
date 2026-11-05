# Devpost submission text (PayPal AI Hackathon)

Fill every `TODO(me)` yourself. These details require information only you can provide.

## Links
- Public code repository: TODO(me) paste your public GitHub URL (make the repository public and show the MIT license in its About section)
- Demo video (YouTube, public, under 3 minutes): TODO(me) paste the public YouTube URL
- Hosted demo (optional): TODO(me) provide the hosted URL, or write `none`/leave blank. Judges can also run it from the README.

## Tagline
Don't just trust the payment. Verify the intent.

## Inspiration
AI agents now spend money for people, and payments sometimes fail halfway: PayPal takes the money but the checkout times out. In both cases nobody can easily prove what was allowed, what was asked and what actually happened.

## What it does
- A person or company signs a **spending mandate** (budget, allowed merchants, expiry, goal) in their own browser.
- An AI agent asks to spend through it. **Plain code decides** (budget, caps, merchant list, injection screening). The AI can only flag a doubtful purchase so the owner is asked.
- Approved requests become a **PayPal hold** (authorize). Settling is a **capture**; releasing is a **void**.
- Every step is written to a **hash-chained, signed ledger**. A **Proof Card** with a QR code lets anyone re-check the whole story in their own browser, with no login. Editing any record visibly breaks it.
- Signed **anchors** let anyone copy chain heads somewhere the operator cannot edit.
- A **reconciliation engine** handles the Ghost Balance: the capture reply is lost but the money moved. LedgerTrue asks PayPal and settles exactly once.

## Try it in 2 minutes (for judges)
1. Needs Node 20+. No account, key or install of packages is required.
2. `cp .env.example .env` (this explicitly enables the loopback-only demo), then `npm test` and `npm start`.
3. Open http://localhost:3000 and press **Run the demo**: a teen's AI shopping agent buys notebooks (approved, PayPal hold), gets hijacked by text on a product page (blocked by code), and asks for a gaming headset (sent to the parent to sign).
4. Open the **Proof Card** tab, then **Chain and verify**, press **Verify**, then use the Tamper lab to edit one amount and watch the chain break.
5. Optional real PayPal sandbox: put sandbox credentials in `.env` and run `node tools/sandbox-check.mjs`.

## How we use PayPal (sandbox)
Orders v2 with `intent=AUTHORIZE`, order authorize, Payments v2 capture and void, `PayPal-Request-Id` idempotency keys, webhook signature verification, and order polling for reconciliation. Without credentials the same flows run against a built-in simulator that is labelled as a simulator in the app and in the proof file. Run `node tools/sandbox-check.mjs` for one real sandbox hold and capture.

## How we use AI
Three advisory uses: a goal-drift flag on purchase requests, plain-English summaries of a mandate, and reconciliation notes. AI cannot approve, block, raise a limit or move money. Model text is only shown if every number, ID and link in it exists in the underlying facts; otherwise a deterministic version is shown. `AI_DISABLED=true` removes all model calls. A zero-dependency **MCP server** lets any MCP agent (for example Claude Desktop) spend only through a mandate. See `docs/RESPONSIBLE_AI.md`.

## How we built it
Node 20 with no runtime dependencies, Web Crypto (ECDSA P-256, SHA-256), ES modules in the browser with no build step, a hand-written QR encoder, a per-mandate mutex so concurrent agents cannot overspend, and JSONL persistence re-verified on boot. The same verifier runs on the server, in the browser and in a CLI (`tools/verify-proof.mjs`).

## What was significantly updated during the submission period
The Ghost Balance reconciliation engine existed before the submission period. TODO(me) provide the date of its first commit, checked against Git history. Added or rebuilt since: the whole Proof of Intent layer (mandates, signed chain, rules engine, owner approvals, Proof Card, tamper lab, public verify page), PayPal authorize/capture/void, anchors and the offline proof file, PayPal reply evidence on settlements, owner-key backup, an MCP agent connector, the responsible-AI guard, security hardening, and the automated test suite. `docs/AUDIT.md` lists every change and why. Added for the AI layer: a trained-model service (spend risk, burn forecast with conformal intervals, exhaustion risk, payment early warning), a validating multi-agent orchestrator with a rule-based fallback, an escalate-only guard check that is replayed by the verifier, an Intelligence dashboard and an evaluation report (`docs/AI_ML.md`). All models are trained on simulated data and say so everywhere.

## Challenges
- Making limits enforceable when an agent can lie or be hijacked: limits live in deterministic code and the verifier replays them.
- Making "edit the log" detectable even by whoever runs the server: signed anchors and a pinned head.
- Not letting AI text invent facts: the grounding check.

## Accomplishments
- 121 Node tests and 26 Python tests are included, with no dependencies to install.
- A forgery that re-signs a rewritten chain with the real guard key is still caught against an earlier anchor (tested).
- The public verify page and the CLI verify a downloaded file with no server.

## Honest limitations
- The PayPal path is tested against mocked responses in the automated tests. TODO(me) state whether you completed a real PayPal sandbox run and, if yes, when; otherwise state that no real sandbox run was completed.
- Anchors are only independent if copied somewhere the operator cannot edit.
- PayPal evidence on settlements is a hash of PayPal's reply, not a PayPal signature.
- Prototype for sandbox use; not audited for real money.

## What's next
Hosted anchor receiver, key rotation for owners, more payment rails, and a user study with non-technical people.

## Built with
Node.js, Web Crypto, PayPal Orders and Payments APIs (sandbox), NVIDIA NIM (optional), Model Context Protocol. TODO(me) state whether you actually used a sponsor tool; name only tools you truly used, or state `none`.

## Prize categories to consider
Best Use of Agentic Commerce, Best Use of PayPal + AI, Most Impactful. Only choose a sponsor prize if you actually use that sponsor's tool.

## Team
TODO(me) provide every team member's name and identify the Representative; confirm the Representative meets the eligibility rules.
