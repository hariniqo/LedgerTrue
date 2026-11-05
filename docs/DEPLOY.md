# Hosting for judges (optional)

The Devpost hosted URL is optional: judges can run LedgerTrue from the README in under a minute. Host it only if you can keep it up until judging ends (Dec 15, 2026).

## What a hosted copy can and cannot do
- The one-click scenarios and the "Run the demo" button need `DEMO_MODE=true`, and demo mode is **loopback-only by design**. Do not expose demo mode on a public host.
- A public host therefore runs with `DEMO_MODE=false`, an `OPERATOR_TOKEN` and an `AGENT_TOKEN`. Put a read-only walkthrough and the tokens in the Devpost "testing instructions" (the rules allow credentials there). Tell judges that the one-click demo runs locally.

## Steps (Render)
1. Push the repo to GitHub (public). Do not commit `.env` or `data/`.
2. New Blueprint on Render, pointing at `render.yaml`.
3. Set the secrets in the dashboard: `OPERATOR_TOKEN`, `AGENT_TOKEN`, and PayPal sandbox credentials. For real sandbox use, also set `PAYPAL_WEBHOOK_ID`.
4. Free tier has no persistent disk, so history resets on redeploy and the guard key is regenerated. That is fine for a demo; say so.
5. Open the URL, press **Operator access**, enter the token, create a mandate and run an agent request.

## Before you give judges the link
- Generate fresh tokens that you will rotate after judging.
- Use sandbox credentials only (`PAYPAL_ENV=sandbox`). The server refuses live PayPal with demo mode on.
