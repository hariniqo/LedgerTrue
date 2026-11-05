# Pitch and demo script

## The problem in one sentence
Payments fail silently, and AI agents now spend money on our behalf, so nobody can prove what was allowed, what was asked and what actually happened.

## The human story (open with this, not the architecture)
A parent gives a child's AI shopping agent a 2,000 rupee budget for school supplies. Three weeks later: where did every rupee go, and was the agent ever tricked? Today the answer is "trust the app". With LedgerTrue the parent signs the budget once, the agent can only spend through it, and anyone can re-check the whole story in their own browser.

Same shape for a small business giving an employee agent a monthly limit.

## Why it is different
- **Verify, do not trust.** The proof is a file. It works offline, with no account and no server.
- **AI cannot move money.** Hard limits are deterministic code. The AI goal check can only say "ask the human".
- **Even we cannot rewrite history.** Every block is anchored. Copy the anchors out and an insider rewrite, even one re-signed with our own key, fails verification.
- **PayPal evidence on every settlement** (a hash of PayPal's own reply), and the Ghost Balance reconciler settles exactly once when a reply is lost.

## 3-minute demo
1. (30s) Say the human story, then press **Run the demo** (the teen scenario): notebooks approved, a hijack hidden in a product page blocked by code, a gaming headset sent to the parent. For concurrency, also run "Three agents, one budget": one approved, two blocked, no overspend.
2. (30s) "Hijacked agent buys a gift card": blocked by code before any AI is asked. Mention the MCP connector: a real agent gets the same answer.
3. (40s) "Large purchase needs the owner": sign the exact decision in the browser.
4. (30s) "Capture times out": the Ghost Balance. PayPal is asked, the hold settles once.
5. (60s) **The moment to land:** Proof Card tab, scan the QR, show "authentic, N signed anchors match". Then Chain tab, Tamper lab: edit one amount, watch it break. Then `node tools/verify-proof.mjs proof.json` on a laptop with no server.

## Honest answers to judge questions
- *Why can't PayPal just add this?* They could. The point is neutrality: the receipt is verifiable by the user without trusting PayPal or us, and it works across payment rails. That is a real advantage and also a real risk; say both.
- *Is the anchor really independent?* Only if you copy it somewhere you do not control. Show the webhook target. Without it, say so.
- *Did PayPal sign the receipt?* No. We store a hash of PayPal's reply so anyone with account access can compare it. That is evidence, not a signature.
- *Is the live PayPal path tested?* Against mocks, plus the recorded sandbox run (do it before the demo).
- *What if the user loses the key?* Recoverable keys have an encrypted backup. A key created non-extractable cannot be backed up, and we say that in the app.
- *Business model?* Per-event pricing for payment providers and agent platforms. Long sales cycles; incumbents could copy the idea. We do not hide that.

## Why this should score well on each criterion (honest)
| Criterion | Our case | What would weaken it |
|---|---|---|
| Technological Implementation | Real PayPal Orders v2 AUTHORIZE, capture and void with idempotency keys, a signed hash chain, anchors, offline verifier, 121 tests, zero runtime dependencies | The live PayPal path is only as proven as the recorded sandbox run |
| Design | One-click demo on the first screen, a visible flow, Proof Card with QR, a tamper lab you can watch break | Not user-tested with non-technical people yet |
| Potential Impact | A human story (a parent and a child's agent) with a verifiable answer to "where did the money go" | Agent payments are early; see docs/IMPACT.md for the limits |
| Innovation / Idea | Owner-signed mandates, rules anyone can replay, AI that can only ask the human, proof that works offline | Others work on agent payment mandates; the novelty is the combination and the verifiability |
| Presentation | Timed 2:40 script, one story from start to finish | Only as good as the recorded video and a real sandbox moment |
