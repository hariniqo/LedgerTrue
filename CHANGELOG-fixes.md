# Fixes applied to v1.6

- server: malformed request URL (e.g. `GET //`) no longer crashes the process; returns 400.
- server: bad percent-encoding returns 400 instead of 500.
- server: `.env` loader strips inline `# comments` and handles quoted values.
- server: rate limiting now also covers GET (RATE_LIMIT_READ_PER_10S, default 600) and is proxy-aware with TRUST_PROXY=true.
- security: open demo mode is refused when NODE_ENV=production; TOKEN_SECRET must be >= 16 chars; short-token warning at startup.
- anchors: webhook progress persists in `<ANCHOR_FILE>.published`; unacknowledged anchors are re-sent after a restart and retried every 60 s.
- ci: anchor-mirror workflow only pushes when there is a new commit.
- repo hygiene: removed .env, data/, guard key, caches, .bak, old model versions; added .gitattributes.
- tests: test/robustness.test.js (6 new tests). Suite: 145 tests, 0 failures.

## Home page speed
- No full-screen intro in open demo mode (it delayed the home page ~3 s). `?intro` in the URL plays it. Token mode keeps a shortened sign-in screen.
- First paint no longer waits for /api/config, the signing key, the SSE stream or the assistant; /api/config is requested once and in parallel with the home data.
- Only the home view loads up front; other pages, key dialog and assistant load on demand (55% less JS at first paint).
- Google Fonts no longer block rendering (loaded after first paint, system fonts show meanwhile).
- Static files: brotli/gzip + ETag/304 (app.css 33.7 KB -> 7.5 KB).
- Animations about 2-3x shorter; page changes show an instant "loading" fade; fast clicks can no longer render a stale page.

## Polish pass (MSME story)
- Demo story is now a small exporter's AI buying agent (packaging approved, fake-invoice gift card blocked, machine upgrade escalated). Budget scaled to a realistic supplier budget.
- Home page: "Why it matters" strip with sourced global MSME figures (World Bank, FBI IC3); `docs/IMPACT.md` updated with the same sources.
- Fixed: `payments is not defined` on the home page (a line break had been lost inside a comment).
- Fixed: step-number badges in the demo hero were misaligned.
- Fixed: `.env.example` held `your-...` placeholders that switched on token auth, a bad currency and fake PayPal/ML endpoints after `cp .env.example .env`. Secrets and optional URLs are now empty.
- Fixed: ML models were trained on scikit-learn 1.8.0 but `requirements.txt` pins 1.9.1, so a fresh install silently fell back to the baseline. Models retrained on 1.9.1.
- Fixed: end-to-end ML test could hang the suite; its health check now has a timeout.
- Packaging: the shipped zip no longer contains `.env`, `data/` keys or chains, or a nested duplicate project.
