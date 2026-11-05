# Scorecard for the full idea

> Note: the weights below come from the earlier Proof of Intent brief. The PayPal AI Hackathon judges on five equal criteria (Technological Implementation, Design, Potential Impact, Innovation/Idea, Presentation). `docs/SUBMISSION.md` and `docs/VIDEO_SCRIPT.md` are written against those.

Scored on the seven criteria and weights from your Proof of Intent brief (total 100). These are my own estimates, not a judge's score. I scored the idea and what is now built, and I tried not to flatter it.

| Criterion | Max | Brief self-score | **Now** | Why |
|---|---:|---:|---:|---|
| Innovation | 20 | 19 | **17** | Owner-signed mandates, deterministic rules that a stranger can replay in a browser, and AI that can only escalate is a strong combination. Signed spending mandates for agents are an emerging area with other efforts, so the novelty is the combination and the verifiability, not any single piece. |
| Technical depth | 15 | 13 | **15** | Signed anchors that catch even a re-signed insider rewrite, offline proof files, PayPal reply evidence, plus: event-sourced reconciler plus a signed hash chain, async-safe mutex, rule replay, head and guard-key pinning, ECDSA signing shared between server and browser, a hand-written QR encoder proven against OpenCV. |
| Feasibility | 15 | 13 | **13** | It runs: 100 automated tests plus a QR decode test, a full browser walkthrough with no console errors. Held back by the live PayPal path being tested only against mocks. |
| Impact | 15 | 14 | **12** | Owner key backup removes the worst usability trap, and `docs/PITCH.md` leads with a human story. Real pain (ghost balances, disputes, agents spending money), but agent payments are early and the cited statistics are vendor-sponsored. Judges weigh visceral consumer impact, and this is infrastructure. |
| PayPal + AI fit | 15 | 14 | **13** | A real MCP agent connector now exists and each settlement carries a hash of PayPal's reply. Authorize, capture and void map one-to-one onto hold, settle and release. AI is used honestly (advisory flag, injection-hardened prompt, plain-English summaries), but a judge who wants AI at the centre may want more. |
| Demo power | 10 | 10 | **9** | Five one-click scenarios, a chain you can watch verify and then break, a QR that opens a public check. Loses a point because a live PayPal sandbox capture is the one moment I could not rehearse. |
| Business potential | 10 | 9 | **6** | Per-event pricing to PSPs and agent platforms is plausible, but sales cycles are long and incumbents could add this. Say so before a judge does. |
| **Total** | **100** | **92** | **85** | |

**The code as you sent it** (only the Ghost Balance engine, with leaked keys, no auth, spoofable events and a generic UI) would score about **58**: strong reconciler, but it did not implement the idea it was pitched under.

## Done since the 82 estimate

Signed anchors with webhook publishing, PayPal reply evidence on settlements, recoverable owner key with encrypted backup, offline proof file and CLI verifier, persisted pending approvals, MCP agent connector, and a pitch and demo script. 100 automated tests.

## What is left, and only you can do it (about +5)

1. **One recorded live PayPal sandbox run**: hold, settle and release as chain blocks (+2 feasibility, demo). The live path is still only tested against mocks.
2. **Point `ANCHOR_WEBHOOK_URL` at somewhere you do not control** (a public GitHub repo via a small Action, a notary) and show the anchor on stage. Until then anchors are signed but not independent.
3. **A short test with two non-technical people** and one screenshot of a real agent (Claude Desktop with the MCP connector) being blocked (+1 impact, +1 fit).
4. **Rotate the leaked credentials** before any public submission (not scored, but disqualifying if missed).

## Honest pitch line

"We don't ask you to trust the payment or the agent. Every spend is a signed mandate, a rule decision and a PayPal result in a chain anyone can re-check in their own browser. And if someone edits history, you can watch it break."
