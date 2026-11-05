# Security scorecard

## Assessment scope

This is a point-in-time engineering assessment of the checked-out source and
automated tests, not a penetration test, production certification, or guarantee
of security. The rubric is weighted to 100 points; a point is awarded only for
a control evidenced below. Tests that mock PayPal do not count as a real
sandbox run.

| Category | Score | Evidence for awarded points | Deductions / remaining exposure |
|---|---:|---|---|
| Authentication and authorization | 7/10 | `src/security.js` compares bearer tokens with `timingSafeEqual`; non-demo startup requires separate operator and agent tokens. `src/server.js` gates agent requests, operator settlement actions, and demo-only helpers. Owner approvals/revocations are signature-checked by the proof engine. | Demo mode is deliberately open for local demonstrations. Static bearer tokens have no expiry or built-in rotation/revocation mechanism. |
| API security | 11/15 | `src/server.js` caps request bodies, applies a per-IP write limiter, validates route/method matches, serves files with a path-relative traversal check, and returns generic internal errors. `src/security.js` supplies CSP, anti-framing, MIME-sniffing, referrer, and permissions headers. Regression tests cover headers, traversal, oversized/bad requests, and unauthorized writes. | The rate limiter and mandate cap are process-local. There is no shared abuse-control store or enforced TLS inside the application; production must use a correctly configured HTTPS reverse proxy. |
| PayPal integration and webhooks | 10/15 | `src/paypal.js` uses OAuth, sandbox by default, documented hold/capture/void endpoints, and idempotency request IDs. Live configuration cannot start in demo mode; live webhooks require a configured webhook ID and successful PayPal signature verification. Tests cover invalid and valid verification responses and the sandbox script refuses live mode. | The sandbox run has not been performed against real PayPal; the webhook regression uses mocked PayPal responses. PayPal reply evidence is hashed, not a provider-signed receipt. |
| Cryptography and key management | 8/10 | `shared/` signs and verifies proof blocks; `src/proof/` validates chains on load, quarantines invalid chains, and records signed anchors. `tools/verify-proof.mjs` supports offline verification. `src/proof/guardKeys.js` enforces Unix 0600/ownership and a restricted, verified Windows ACL without rotating or deleting an existing key. Tests cover tampering, truncation, guard-key permission correction, and offline proof verification. | The guard key is a local file rather than a KMS/HSM-managed key. External anchor mirroring is optional, so local-only anchors do not independently protect against a fully compromised host. |
| Auditability and recovery | 8/10 | Persisted chains are re-verified at boot; damaged chains are quarantined. Reset archives the reconciliation log instead of truncating it. Anchors are hash-linked and signed, and pending approvals persist across restarts. Tests exercise restart, tampering, reset, and anchor behavior. | Local persistence and anchors are not an independent append-only service. Backups and recovery of machine-held guard keys remain operator responsibilities. |
| Frontend security | 9/10 | `public/` avoids `innerHTML`, `outerHTML`, `document.write`, and `eval`; agent/model text is rendered as text. CSP is configured, and the test suite syntax-checks browser modules and verifies proof files offline. | The browser test is not a full browser-based XSS or CSP integration assessment. PayPal must be permitted by the CSP for checkout, increasing the trusted third-party surface. |
| AI and prompt-injection controls | 7/10 | `src/proof/goalCheck.js` screens known hostile/restricted text before model calls, treats model output as advisory, validates output shape, and falls back on heuristic errors. Deterministic rules—not the model—control payment decisions; `AI_DISABLED=true` removes model calls. Tests cover injection screening, hallucination grounding, model failures, and the kill switch. | Pattern screening cannot detect every semantic injection. Goal and purchase-request fields are sent to NVIDIA when enabled; provider retention/processing guarantees and comprehensive data minimization have not been independently verified. |
| Privacy | 3/5 | AI is optional and can be disabled. Model inputs are limited to the goal and purchase request fields used by the goal check; secrets are not placed in `.env.example`. | No independently verified provider data-retention terms or organization-wide retention/deletion controls are established here. Avoid sending personal or sensitive data to the model. |
| Supply chain | 4/5 | The runtime dependency graph is empty and locked in `package-lock.json`; `npm audit --omit=dev` reported zero known vulnerabilities. `.github/workflows/security.yml` pins checkout/setup-node actions by commit SHA and tests Node 20 on Ubuntu and Windows. | No provenance/SBOM attestation or external action-policy enforcement is configured. A clean dependency audit does not assess application-code vulnerabilities. |
| Production deployment | 3/10 | Live mode requires non-demo authentication and webhook configuration. `SECURITY.md` documents the need for HTTPS termination and KMS/HSM use; CI covers Windows and Ubuntu. | No production deployment or real sandbox transaction was verified. TLS is not enforced by the app; horizontal scaling needs shared state/rate limiting; external anchors, operational monitoring, key rotation, and a production threat review are not implemented. |
| **Total** | **70/100** | **Evidence is the source, tests, and checks listed in this table; no points are awarded for unverified production behavior.** | **Not a security certification. The release preflight must pass on the exact publication copy.** |

## Current release blockers

- The local ignored `data/guard-key.json` is an existing private runtime key.
  Keep it intact locally; exclude the `data/` directory from the public
  publication copy. Do not copy the key into a release archive.
- `docs/SUBMISSION.md` contains entrant-only TODOs. Complete them with verified
  details before submission.
- Complete and record a real PayPal sandbox run, and verify production-like
  HTTPS, key storage, and external anchor behavior before treating the service
  as production-ready.

## Verification boundaries

Automated tests establish the exercised code paths only. Mocked integrations,
static review, and `npm audit` do not establish that the app is safe against all
attacks or correctly configured in a deployment.
