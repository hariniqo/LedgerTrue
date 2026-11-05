# Security

LedgerTrue handles payment intent, so keys matter.

- **Secrets live only in `.env`** (gitignored). Never in `.env.example`, never in a zip you share. If a key was ever shared, rotate it.
- `data/guard-key.json` is the server's signing key. Unix permissions are restricted to 0600; Windows uses a protected ACL granting access only to the current identity, SYSTEM, and local Administrators. Existing files are secured before reading; permission failures stop startup. Use a KMS or HSM in production.
- Use PayPal **sandbox** credentials for demos. Live mode is not production-certified; it requires `DEMO_MODE=false`, operator/agent tokens, and `PAYPAL_WEBHOOK_ID`. Live unsigned webhooks are always refused. `tools/sandbox-check.mjs` refuses to run against live PayPal.
- Run `node tools/preflight.mjs` before publishing. It fails on real-looking keys, a missing license and a missing `.gitignore` entry, and never prints a secret.
- `DEMO_MODE=false` requires `OPERATOR_TOKEN` and `AGENT_TOKEN`; the server will not start without them.
- An unset or invalid `DEMO_MODE` is production mode and fails closed. Set `DEMO_MODE=true` only for local demos; when the demo has no tokens, the bundled server binds to `127.0.0.1`.
- `POST /api/events` accepts only app-reported order initiation, payment attempt, client timeout, and client error. Capture/refund/dispute outcomes must come from PayPal webhooks with valid signatures or PayPal API polling.
- Live PayPal cannot run with demo mode enabled. Live webhooks require a configured webhook ID and valid PayPal signature; `ALLOW_UNSIGNED_WEBHOOKS` is not supported.
- AI can never move money or raise a limit (see `docs/RESPONSIBLE_AI.md`). `AI_DISABLED=true` removes every model call.

To report a vulnerability, open a private security advisory on the repository, or email the maintainers listed there. Please do not post exploits in public issues.
