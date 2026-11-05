# Demo video run sheet (under 3 minutes)

Prepare and rehearse before recording so the finished video stays below 3:00. Record the real sandbox transaction's terminal result; do not record credentials or the `.env` file. The timed order below shows all five required points.

## Before recording

1. Use Node.js 20 or newer. In the project folder, create a local `.env` with PayPal sandbox credentials and `PAYPAL_ENV=sandbox`. Never put keys in the recording or commit `.env`.
2. Set `NVIDIA_API_KEY` locally, keep `AI_DISABLED=false`, and start the app with `npm start`. Confirm the model-backed summary works before recording; if the UI says the summary was built without AI, do not claim it was AI-generated.
3. Use a PayPal sandbox buyer account to rehearse the hold and capture. The checker refuses live PayPal. Approve the order in the sandbox in a window that is not recorded; return to the terminal to show the hold and capture output.
4. Have a copy of the demo proof file ready for editing during the tamper segment. Keep the original unchanged.

## Timed run sheet

| Time | Action |
|---|---|
| 0:00–0:08 | Introduce LedgerTrue and the claim: payment intent and outcome can be independently checked. |
| 0:08–0:45 | In a terminal, run `node tools/sandbox-check.mjs`. Approve the order with the sandbox buyer off-camera, then show the terminal reporting the hold and capture. This is the real sandbox transaction, not the simulator. |
| 0:45–1:20 | In the app, run **Purchase drifts from the goal**. Show the goal-drift escalation, then open **Proof Card** and click **Write a plain-English summary**. Show the AI-generated label/source. If it falls back to a deterministic summary, disclose that and do not call it AI-generated. |
| 1:20–1:38 | Return home and run **Hijacked agent buys a gift card**. Show that the injection attempt is blocked by rules before any model call. |
| 1:38–2:25 | Return to the drift mandate's **Proof Card**. Show its QR code and verified status, download the proof file, then run `node tools/verify-proof.mjs "<path-to-downloaded-proof.json>"` from the project folder. Show `AUTHENTIC` and the successful exit. |
| 2:25–2:50 | Make a copy of that proof file, edit a request amount in the copy, and run `node tools/verify-proof.mjs "<path-to-tampered-proof.json>"`. Show `FAILED` and the non-zero exit; keep the original file intact. |
| 2:50–2:58 | Close with the project name and the public repository URL. |

Keep the final edit under 3:00. Keep third-party logos and copyrighted music out of the video.
