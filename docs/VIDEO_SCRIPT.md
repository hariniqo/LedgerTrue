# Demo video script (target 2:40, hard limit 3:00, public on YouTube)

Rules: under 3 minutes, footage of the project running, public on YouTube, no third-party logos or copyrighted music (use your own voice, or no music). Never show `.env`, API keys or the `data/` folder. Record at 1080p. Say "simulator" on camera whenever you show the simulator.

Criteria this targets: Technological Implementation, Design, Potential Impact, Innovation, Presentation (equal weight).

## Run sheet

| Time | On screen | Say (adapt to your own words) | Caption | Criterion |
|---|---|---|---|---|
| 0:00 to 0:12 | Home screen, hero card | "AI agents are starting to spend our money. When something goes wrong, nobody can prove what was allowed, what was asked and what happened. LedgerTrue lets anyone check." | Spending you can prove | Impact, Presentation |
| 0:12 to 0:45 | Press **Run the demo** (teen scenario). Open the mandate, scroll the three requests | "A parent gives a teen's AI helper a small school budget. Notebooks: approved and put on hold. A product page hides an instruction to buy a gift card: blocked by code before any AI is asked. A gaming headset: sent to the parent to sign." | Approve. Block. Ask the human. | Innovation, Design |
| 0:45 to 1:05 | Point at the "AI advisory only, cannot move money" chip, then the rule checks on the blocked request | "The AI can only flag or explain. The limits are plain code anyone can replay." | AI cannot move money | Innovation, Impact |
| 1:05 to 1:45 | **Real PayPal sandbox:** `node tools/sandbox-check.mjs`; approve as the sandbox buyer off-camera; show the terminal reporting hold, then capture | "This is the real PayPal sandbox: authorize places a hold, capture settles it, void releases it, with idempotency keys on every call." | PayPal sandbox: AUTHORIZE, capture, void | Technological Implementation |
| 1:45 to 2:00 | Run **Capture times out** | "The reply was lost but the money moved. LedgerTrue asks PayPal and settles exactly once." | Ghost Balance, settled once | Technological Implementation |
| 2:00 to 2:30 | Proof Card: show Verified and QR; then **Chain and verify**, Tamper lab: halve an amount, press Verify, watch it fail at that block; Restore | "Anyone can check the whole story in their own browser, with no login. Edit one number and it breaks, at exactly that block." | Edit one number. It breaks. | Innovation, Presentation |
| 2:30 to 2:40 | Terminal: `node tools/verify-proof.mjs proof.json` prints AUTHENTIC; then home screen with repo URL | "It also verifies offline from a file. Open source, MIT." | github.com/<your-repo> | Presentation |

## Shot list (record separately, then cut)
1. Home hero (clean data folder, light theme).
2. Teen scenario run, then the Activity tab with the three requests visible without scrolling.
3. Rule checks expanded on the gift-card request.
4. Terminal with the sandbox run (blur or crop anything that is not the result).
5. Ghost scenario Activity tab.
6. Chain and verify: Verify green, Tamper lab break (red), Restore, Verify green.
7. Proof Card with QR; phone scan optional.
8. Terminal: verify-proof AUTHENTIC.

## Before you record
- Do the real sandbox run once as a rehearsal. If the real run fails, show the simulator and say so on screen. Never imply a real transaction that did not happen.
- If `NVIDIA_API_KEY` is on, show the AI summary; if the UI says it was built without AI, say that. Do not claim AI wrote it.
- Start with a fresh, empty data folder so the home screen has no clutter.
- Do not show tokens, `.env`, or the `data/` folder. Rotate any key that appeared on screen.
- Trim to under 3:00 including the end card. Upload as Public (not Unlisted).
