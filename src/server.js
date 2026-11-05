import http from 'node:http';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventStore } from './eventStore.js';
import { Reconciler } from './reconciler.js';
import { PayPalClient, mapWebhook, mapOrder, makePayPalOracle } from './paypal.js';
import { SimPayPal, runScenario, SCENARIO_LIST } from './scenarios.js';
import { explain } from './explainer.js';
import { answerAssistant } from './assistant.js';
import { DEFAULT_NVIDIA_BASE_URL, DEFAULT_NVIDIA_MODEL, NvidiaRequestError, nvidiaChatCompletion } from './nvidia.js';
import { ValidationError, T } from './events.js';
import { toCents } from './money.js';
import { makeAuth, makeLimiter, securityHeaders } from './security.js';
import { loadGuard } from './proof/guardKeys.js';
import { ChainStore, ChainError } from './proof/chainStore.js';
import { ProofEngine } from './proof/engine.js';
import { SimGateway, PayPalGateway } from './proof/gateway.js';
import { runDemo, DEMO_SCENARIOS } from './proof/demo.js';
import { explainChain } from './proof/chainExplainer.js';
import { AnchorLog } from './proof/anchors.js';
import { attachNotifier } from './notify.js';
import { makeProof } from '../shared/anchors.js';
import { createIntel } from './intel/orchestrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const SHARED = path.join(ROOT, 'shared');

// Minimal .env loader (no dependency).
function loadEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] in process.env) continue;
    let v = m[2];
    const q = v[0] === '"' || v[0] === "'" ? v[0] : '';
    if (q) { const end = v.indexOf(q, 1); v = end > 0 ? v.slice(1, end) : v.slice(1); }
    else v = v.replace(/\s+#.*$/, '').trim(); // unquoted: strip inline "# comment"
    process.env[m[1]] = v;
  }
}

const decodeParam = (s) => { try { return decodeURIComponent(s); } catch { throw new HttpError(400, 'bad URL encoding'); } };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
const TEXT_EXT = new Set(['.html', '.js', '.css', '.svg', '.json']);
const APP_EVENT_TYPES = new Set([T.ORDER_INITIATED, T.PAYMENT_ATTEMPTED, T.CLIENT_TIMEOUT, T.CLIENT_ERROR]);

export async function createApp(env = process.env, { nvidiaFetchImpl = globalThis.fetch } = {}) {
  const auth = makeAuth(env);
  const limiter = makeLimiter({ windowMs: 10_000, max: Number(env.RATE_LIMIT_PER_10S) || 120 });
  const readLimiter = makeLimiter({ windowMs: 10_000, max: Number(env.RATE_LIMIT_READ_PER_10S) || 600 });
  // Behind a reverse proxy (Render, nginx) every client shares the proxy's address. Set TRUST_PROXY=true ONLY when a
  // proxy you control sets X-Forwarded-For; the last hop is the one your proxy appended, so it is the one we trust.
  const trustProxy = String(env.TRUST_PROXY ?? 'false') === 'true';
  const clientKey = (req) => {
    if (trustProxy) {
      const parts = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts.at(-1);
    }
    return String(req.socket.remoteAddress);
  };
  const maxMandates = Number(env.MAX_MANDATES) || 500;

  const paypal = new PayPalClient({
    clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_CLIENT_SECRET,
    env: env.PAYPAL_ENV || 'sandbox', webhookId: env.PAYPAL_WEBHOOK_ID || '',
  });
  const sim = new SimPayPal();
  const live = paypal.configured;
  if (live) {
    // Fail loudly instead of silently: a truncated Client ID or wrong secret makes every payment call fail later.
    if (String(env.PAYPAL_CLIENT_ID).length < 40) console.warn(`PayPal: PAYPAL_CLIENT_ID is only ${String(env.PAYPAL_CLIENT_ID).length} characters; real Client IDs are ~80. It looks truncated or is a placeholder.`);
    paypal.token().then(() => console.log(`PayPal: ${paypal.env} credentials accepted.`), (e) => console.warn(`PayPal: ${e.message}. Check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET match the same ${paypal.env} app. Clear both to fall back to the simulator.`));
  }
  if (live && paypal.env === 'live' && auth.demo) {
    throw new Error('Live PayPal requires DEMO_MODE=false and operator/agent tokens');
  }
  const store = new EventStore({ file: env.PERSIST_FILE || null });
  const oracle = live ? makePayPalOracle(paypal) : sim.oracle;
  const recon = new Reconciler({ store, oracle, verifyAfterMs: Number(env.VERIFY_AFTER_MS) || 8000 });
  for (const e of EventStore.readLog(store.file)) recon.ingest(e, { persist: false });

  // --- Proof of Intent ---
  // Kill switch: AI_DISABLED=true removes every model call. The product still works, with deterministic text only.
  const aiModel = env.AI_MODEL || env.NVIDIA_MODEL || undefined;
  const aiBase = env.AI_BASE_URL || env.NVIDIA_BASE_URL || undefined;
  const aiKey = env.AI_DISABLED === 'true' ? '' : (env.AI_API_KEY || env.NVIDIA_API_KEY || '');
  const guard = await loadGuard(env.GUARD_KEY_FILE || null);
  const chains = new ChainStore({ dir: env.CHAIN_DIR || null, guard });
  const boot = await chains.load();
  const anchors = new AnchorLog({ file: env.ANCHOR_FILE || null, guard, webhookUrl: env.ANCHOR_WEBHOOK_URL || '' });
  const anchorBoot = await anchors.load();
  // Backfill: any block written before the log existed (or lost in a crash) gets anchored now, so coverage has no gaps.
  for (const id of chains.ids()) {
    const have = new Set(anchors.forMandate(id).map((a) => a.headIndex));
    if (chains.get(id).quarantined) continue; // never vouch for a chain that failed its own check
    const blocks = chains.get(id).blocks;
    const last = blocks.at(-1);
    if (last && !have.has(last.index) && !anchors.broken) await anchors.record(id, last);
  }
  const gateway = live ? new PayPalGateway(paypal) : new SimGateway(sim);
  const currency = env.DEMO_CURRENCY || (live ? 'USD' : 'INR');
  let engine; // assigned below; the intelligence layer only gets a read-only callback into it
  const intel = createIntel({ chains, recon, env, fetchImpl: nvidiaFetchImpl, unresolved: (id) => [...(engine?.unknownCaptures.keys() ?? [])].filter((k) => k.startsWith(`${id}:`)).length });
  engine = new ProofEngine({
    riskScorer: intel.riskScorer,
    store: chains, gateway, recon,
    ai: { apiKey: aiKey, model: aiModel, baseUrl: aiBase },
    captureTimeoutMs: Number(env.CAPTURE_TIMEOUT_MS) || 8000,
    stateFile: env.PENDING_FILE || null,
  });
  engine.on('block', ({ mandateId, block }) => { anchors.record(mandateId, block).catch((e) => console.error('anchor failed:', e.message)); });
  attachNotifier(engine, { url: env.NOTIFY_URL, publicUrl: env.PUBLIC_URL });

  const captureIndex = new Map();
  const clients = new Set();
  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (event, data) => clients.forEach((c) => send(c, event, data));

  const stats = () => ({
    ledger: recon.ledger.summaries(),
    invariants: recon.ledger.invariants(),
    payments: recon.snapshots.size,
    mode: live ? `PayPal ${paypal.env}` : 'simulator',
    explainer: aiKey ? 'nvidia' : 'fallback',
  });

  recon.on('raw', (record) => broadcast('raw', record));
  recon.on('payment', ({ snapshot, entries }) => broadcast('payment', { snapshot, entries, stats: stats() }));
  recon.on('reset', () => broadcast('reset', stats()));
  engine.on('block', ({ mandateId, block, summary }) => broadcast('block', { mandateId, block, summary }));

  const timer = setInterval(() => { recon.sweep().catch(() => {}); engine.sweepUnknown().catch(() => {}); }, 2000);
  const beat = setInterval(() => clients.forEach((c) => c.write(': ping\n\n')), 20_000);
  timer.unref?.(); beat.unref?.();

  // ---------- helpers ----------
  const readBody = (req, limit = 200_000) => new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new ValidationError('invalid JSON')); } });
    req.on('error', reject);
  });
  const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const need = (req, role) => { if (!auth.can(req, role)) throw new HttpError(401, `${role} token required`); };
  const needDemo = () => { if (!auth.demo) throw new HttpError(403, 'disabled: DEMO_MODE is off'); };
  const mandateOr404 = (id) => { if (!chains.has(id)) throw new HttpError(404, 'mandate not found'); return id; };

  // ---------- routes ----------
  // [method, pattern, handler]. Patterns use :name segments.
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler });
  };

  route('GET', '/api/config', async (req, res) => json(res, 200, {
    mode: live ? `PayPal ${paypal.env}` : 'simulator',
    paypalClientId: live ? paypal.clientId : null, // public by design: the PayPal JS SDK needs it
    currency, demo: auth.demo, authRequired: !auth.open,
    guard: { keyId: guard.keyId, publicKeyJwk: guard.publicKeyJwk },
    explainer: aiKey ? 'nvidia' : 'deterministic',
    webhookVerified: Boolean(paypal.webhookId),
    boot: { chains: boot.loaded, quarantined: boot.quarantined },
    anchors: anchors.status(),
  }));

  route('GET', '/.well-known/ledgertrue-guard.json', async (req, res) => json(res, 200, { keyId: guard.keyId, publicKeyJwk: guard.publicKeyJwk }));

  // The whole anchor log, public on purpose: mirror it somewhere the operator cannot edit (a public repo, a notary).
  route('GET', '/.well-known/ledgertrue-anchors.json', async (req, res) => json(res, 200, { guard: { keyId: guard.keyId, publicKeyJwk: guard.publicKeyJwk }, status: anchors.status(), entries: anchors.entries }));

  // --- mandates ---
  route('GET', '/api/mandates', async (req, res) => json(res, 200, chains.ids().map((id) => chains.summary(id)).sort((a, b) => b.createdAt - a.createdAt)));

  route('POST', '/api/mandates', async (req, res) => {
    if (chains.ids().length >= maxMandates) throw new HttpError(429, 'mandate limit reached on this server');
    const block = await engine.createMandate(await readBody(req));
    json(res, 201, { mandateId: block.mandateId, summary: chains.summary(block.mandateId) });
  });

  route('GET', '/api/mandates/:id', async (req, res, { id }) => json(res, 200, { summary: chains.summary(mandateOr404(id)), bundle: chains.bundle(id), pending: engine.pendingFor(id) }));
  route('GET', '/api/mandates/:id/bundle', async (req, res, { id }) => json(res, 200, chains.bundle(mandateOr404(id))));
  // Portable proof file: the chain plus the anchors that cover it. Verifiable offline (tools/verify-proof.mjs or the verify page).
  route('GET', '/api/mandates/:id/proof', async (req, res, { id }) => { await anchors.idle(); json(res, 200, makeProof({ bundle: chains.bundle(mandateOr404(id)), anchors: anchors.forMandate(id), anchorHead: anchors.head() })); });

  route('POST', '/api/mandates/:id/requests', async (req, res, { id }) => {
    need(req, 'agent');
    json(res, 201, await engine.requestPayment(mandateOr404(id), await readBody(req)));
  });

  route('POST', '/api/mandates/:id/requests/:rid/approval', async (req, res, { id, rid }) => {
    json(res, 200, await engine.approve(mandateOr404(id), rid, await readBody(req)));
  });

  route('POST', '/api/mandates/:id/requests/:rid/paypal-authorize', async (req, res, { id, rid }) => {
    const { orderId } = await readBody(req);
    json(res, 200, await engine.completePayPalHold(mandateOr404(id), rid, String(orderId ?? '')));
  });

  route('POST', '/api/mandates/:id/requests/:rid/capture', async (req, res, { id, rid }) => {
    need(req, 'operator');
    const { amountCents } = await readBody(req);
    json(res, 200, await engine.capture(mandateOr404(id), rid, { amountCents }));
  });

  route('POST', '/api/mandates/:id/requests/:rid/void', async (req, res, { id, rid }) => {
    need(req, 'operator');
    const { reason } = await readBody(req);
    json(res, 200, await engine.void(mandateOr404(id), rid, { reason }));
  });

  route('POST', '/api/mandates/:id/revoke', async (req, res, { id }) => {
    const block = await engine.revoke(mandateOr404(id), await readBody(req));
    json(res, 200, { revoked: true, index: block.index });
  });

  route('POST', '/api/mandates/:id/explain', async (req, res, { id }) => {
    json(res, 200, await explainChain(chains.bundle(mandateOr404(id)).blocks, { apiKey: aiKey, model: aiModel, baseUrl: aiBase }));
  });

  // --- demo ---
  route('GET', '/api/demo/scenarios', async (req, res) => json(res, 200, DEMO_SCENARIOS));
  route('POST', '/api/demo/:name', async (req, res, { name }) => {
    needDemo(); need(req, 'operator');
    if (!DEMO_SCENARIOS[name]) throw new HttpError(404, 'unknown scenario');
    const { mandateId } = await readBody(req);
    json(res, 200, await runDemo(name, { engine, mandateId: mandateOr404(String(mandateId ?? '')), gateway }));
  });

  // --- reconciliation engine (original routes) ---
  route('GET', '/api/state', async (req, res) => json(res, 200, { payments: recon.list(), stats: stats(), scenarios: SCENARIO_LIST }));

  route('POST', '/api/assistant/chat', async (req, res) => {
    need(req, 'agent');
    const body = await readBody(req, 5_000);
    if (typeof body.question !== 'string' || !body.question.trim() || body.question.length > 1000) {
      throw new HttpError(400, 'question must contain 1 to 1000 characters');
    }
    const history = body.history ?? [];
    if (!Array.isArray(history) || history.length > 6 || history.some((item) => !item
      || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string'
      || !item.content.trim() || item.content.length > 500)) {
      throw new HttpError(400, 'history must contain up to 6 valid messages of at most 500 characters each');
    }
    const answer = await answerAssistant({
      question: body.question,
      history,
      mandates: chains.ids().map((id) => chains.summary(id)).sort((a, b) => b.createdAt - a.createdAt),
      payments: recon.list(),
      intel: Object.fromEntries(chains.ids().map((id) => [id, intel.cached(id)]).filter(([, v]) => v && !v.quarantined)),
      apiKey: aiKey,
      model: aiModel,
      baseUrl: aiBase,
      providerDisabled: env.AI_DISABLED === 'true',
      fetchImpl: nvidiaFetchImpl,
    });
    json(res, 200, answer);
  });

  route('POST', '/api/assistant/health', async (req, res) => {
    need(req, 'agent');
    const model = aiModel || DEFAULT_NVIDIA_MODEL;
    if (env.AI_DISABLED === 'true' || !aiKey) {
      return json(res, 503, {
        ok: false,
        provider: 'nvidia',
        model,
        providerStatus: env.AI_DISABLED === 'true' ? 'disabled' : 'not_configured',
      });
    }
    try {
      const response = await nvidiaChatCompletion({
        apiKey: aiKey,
        model,
        baseUrl: aiBase,
        messages: [
          { role: 'system', content: 'This is a harmless service health check. Reply with a short greeting.' },
          { role: 'user', content: 'Say hello to LedgerTrue.' },
        ],
        fetchImpl: nvidiaFetchImpl,
        maxTokens: 512,
        timeoutMs: 30_000,
      });
      return json(res, 200, { ok: true, provider: 'nvidia', model, response });
    } catch (error) {
      console.warn('NVIDIA NIM health check failed.', {
        status: error.status ?? null,
        code: error.code ?? error.name ?? 'Error',
      });
      return json(res, 503, {
        ok: false,
        provider: 'nvidia',
        model,
        providerStatus: error instanceof NvidiaRequestError ? error.code : 'request_failed',
        upstreamStatus: error instanceof NvidiaRequestError ? error.status : null,
        error: error.message,
      });
    }
  });

  // --- intelligence (advisory only: read-only analysis of chains and payment events) ---
  route('GET', '/api/intel/status', async (req, res) => { need(req, 'agent'); json(res, 200, await intel.status()); });
  route('GET', '/api/intel/overview', async (req, res) => { need(req, 'agent'); json(res, 200, await intel.overview()); });
  route('GET', '/api/intel/payments', async (req, res) => { need(req, 'agent'); json(res, 200, await intel.analyzePayments()); });
  route('GET', '/api/mandates/:id/intel', async (req, res, { id }) => { need(req, 'agent'); json(res, 200, await intel.analyzeMandate(mandateOr404(id))); });
  route('POST', '/api/intel/synthetic', async (req, res) => {
    needDemo(); need(req, 'operator');
    const { seed = 1 } = await readBody(req, 1000);
    const out = await intel.synthetic(Number.isInteger(seed) ? seed : 1);
    if (!out.ok) return json(res, 503, { error: out.reason === 'not_configured' ? 'The ML service is not configured (set ML_SERVICE_URL).' : `The ML service is unavailable (${out.reason}).` });
    json(res, 200, out);
  });

  route('GET', '/api/events', async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });

  // Your own checkout server reports what it did here (order created, charge attempted, timed out).
  route('POST', '/api/events', async (req, res) => {
    need(req, 'agent');
    const report = await readBody(req);
    if (!report || typeof report !== 'object' || Array.isArray(report) || !APP_EVENT_TYPES.has(report.type)) {
      throw new HttpError(400, 'app events may only report checkout initiation, attempt, timeout, or client error');
    }
    const out = recon.ingest({ ...report, source: 'app', ts: Date.now() });
    json(res, 202, { duplicate: out.duplicate, state: out.snapshot.state });
  });

  // Point your PayPal webhook at this URL.
  route('POST', '/api/webhooks/paypal', async (req, res) => {
    const event = await readBody(req, 1_000_000);
    const strict = paypal.env === 'live';
    if (!paypal.webhookId && strict) throw new HttpError(503, 'PAYPAL_WEBHOOK_ID is required in live mode: refusing unsigned webhooks');
    if (paypal.webhookId) {
      const v = await paypal.verifyWebhook(req.headers, event).catch(() => ({ verified: false }));
      if (!v.verified) throw new HttpError(401, 'signature verification failed');
    }
    const mapped = mapWebhook(event, captureIndex);
    if (!mapped) return json(res, 200, { ignored: true }); // 2xx so PayPal stops retrying events we don't model
    const out = recon.ingest(mapped);
    json(res, 200, { duplicate: out.duplicate, state: out.snapshot.state });
  });

  route('GET', '/api/payments', async (req, res) => json(res, 200, recon.list()));
  route('GET', '/api/ledger', async (req, res) => json(res, 200, { summary: recon.ledger.summaries(), invariants: recon.ledger.invariants(), entries: recon.ledger.entries.slice(-200).reverse() }));

  route('POST', '/api/chaos', async (req, res) => {
    needDemo(); need(req, 'operator');
    const { scenario = 'all', paced = true } = await readBody(req);
    runScenario(scenario, recon, sim, { paced }).catch((e) => console.error('scenario failed:', e.message));
    json(res, 202, { started: scenario });
  });

  route('POST', '/api/reset', async (req, res) => { needDemo(); need(req, 'operator'); recon.reset(); json(res, 200, { ok: true, note: 'log archived, not deleted' }); });

  route('GET', '/api/payments/:id', async (req, res, { id }) => {
    const snapshot = recon.get(decodeParam(id));
    if (!snapshot) throw new HttpError(404, 'not found');
    json(res, 200, { snapshot, timeline: recon.timeline(snapshot.paymentId) });
  });
  route('POST', '/api/payments/:id/explain', async (req, res, { id }) => {
    const snapshot = recon.get(decodeParam(id));
    if (!snapshot) throw new HttpError(404, 'not found');
    json(res, 200, await explain(snapshot, recon.timeline(snapshot.paymentId), { apiKey: aiKey, model: aiModel || DEFAULT_NVIDIA_MODEL, baseUrl: aiBase }));
  });
  route('POST', '/api/payments/:id/verify', async (req, res, { id }) => {
    need(req, 'operator');
    const pid = decodeParam(id);
    if (!recon.get(pid)) throw new HttpError(404, 'not found');
    const out = await recon.verify(pid);
    json(res, 200, out ? { state: out.snapshot.state } : { state: recon.get(pid).state, note: 'PayPal had no capture to report' });
  });

  // Sandbox helper: create + capture a real PayPal order, deliberately timing out the client to create a real Ghost Balance.
  route('POST', '/api/sandbox/ghost', async (req, res) => {
    needDemo();
    if (auth.open) throw new HttpError(401, 'operator token required');
    need(req, 'operator');
    if (paypal.env !== 'sandbox') throw new HttpError(403, 'sandbox-only endpoint');
    if (!live) throw new HttpError(400, 'PayPal credentials not configured');
    const { amount = 10, approvedOrderId } = await readBody(req);
    let amountCents;
    try { amountCents = toCents(amount); } catch (e) { throw new ValidationError(e.message); }
    const order = approvedOrderId ? { id: String(approvedOrderId) } : await paypal.createOrder({ amountCents });
    const t0 = Date.now();
    recon.ingest({ paymentId: order.id, type: T.ORDER_INITIATED, source: 'app', ts: t0, amountCents });
    if (!approvedOrderId) return json(res, 200, { orderId: order.id, approveUrl: order.links?.find((l) => l.rel === 'payer-action')?.href, next: 'Approve the order in the sandbox, then POST again with approvedOrderId' });
    recon.ingest({ paymentId: order.id, type: T.PAYMENT_ATTEMPTED, source: 'app', ts: Date.now(), amountCents });
    const timeoutMs = Number(env.CAPTURE_TIMEOUT_MS) || 8000;
    try {
      const result = await Promise.race([
        paypal.captureOrder(order.id),
        new Promise((_, rej) => setTimeout(() => rej(new Error('client timeout')), timeoutMs)),
      ]);
      const poll = mapOrder(result, order.id);
      if (poll) recon.ingest(poll);
      json(res, 200, { orderId: order.id, captured: true });
    } catch (e) {
      recon.ingest({ paymentId: order.id, type: T.CLIENT_TIMEOUT, source: 'app', ts: Date.now(), ref: e.message });
      json(res, 200, { orderId: order.id, captured: 'unknown', note: 'Client gave up. LedgerTrue will poll PayPal.' });
    }
  });

  // ---------- static ----------
  const compressed = new Map();
  const serveFile = (req, res, base, rel) => {
    const file = path.resolve(base, rel);
    const within = path.relative(base, file);
    if (within.startsWith('..') || path.isAbsolute(within) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, securityHeaders()); return res.end('not found'); }
    // Speed: ETag so repeat loads are a cheap 304, and brotli/gzip (compressed once, cached in memory) for text assets.
    const st = fs.statSync(file);
    const ext = path.extname(file);
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const base_ = { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: etag, Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, securityHeaders({ ETag: etag, 'Cache-Control': 'no-cache' })); return res.end(); }
    const accept = String(req.headers['accept-encoding'] ?? '');
    const enc = TEXT_EXT.has(ext) && st.size > 1024 ? (/\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null) : null;
    if (!enc) { res.writeHead(200, securityHeaders(base_)); return fs.createReadStream(file).pipe(res); }
    const key = `${enc}:${file}:${etag}`;
    let body = compressed.get(key);
    if (!body) {
      const raw = fs.readFileSync(file);
      body = enc === 'br' ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }) : zlib.gzipSync(raw, { level: 6 });
      if (compressed.size > 200) compressed.clear();
      compressed.set(key, body);
    }
    res.writeHead(200, securityHeaders({ ...base_, 'Content-Encoding': enc, 'Content-Length': body.length }));
    res.end(body);
  };

  const server = http.createServer(async (req, res) => {
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    try {
      let url;
      try { url = new URL(req.url, 'http://x'); } catch { throw new HttpError(400, 'bad request URL'); }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.well-known/')) {
        for (const k of Object.entries(securityHeaders())) res.setHeader(k[0], k[1]);
        if (!(method === 'GET' ? readLimiter : limiter).check(clientKey(req))) throw new HttpError(429, 'too many requests, slow down');
        const hit = routes.find((r) => r.method === method && r.re.test(url.pathname));
        if (!hit) return json(res, 404, { error: 'not found' });
        const m = url.pathname.match(hit.re);
        const params = Object.fromEntries(hit.keys.map((k, i) => [k, decodeParam(m[i + 1])]));
        return await hit.handler(req, res, params);
      }
      if (method !== 'GET') { res.writeHead(405); return res.end(); }
      if (url.pathname.startsWith('/shared/')) return serveFile(req, res, SHARED, url.pathname.slice('/shared/'.length));
      if (/^\/verify\/m_[a-f0-9]{24}$/.test(url.pathname)) return serveFile(req, res, PUBLIC, 'verify.html');
      return serveFile(req, res, PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      if (e instanceof ValidationError) return json(res, 400, { error: e.message });
      if (e instanceof ChainError) return json(res, 409, { error: e.message });
      if (e?.status && e.status >= 400 && e.status < 500 && e.body) return json(res, 502, { error: 'PayPal rejected the request', detail: e.body.message ?? e.message });
      console.error('internal error:', e);
      json(res, 500, { error: 'internal error' }); // never leak stack traces or upstream messages
    }
  });
  server.on('close', () => { clearInterval(timer); clearInterval(beat); limiter.stop(); readLimiter.stop(); anchors.stop(); clients.forEach((c) => c.end()); });

  return { server, recon, sim, paypal, stats, engine, chains, guard, gateway, auth, boot, anchors, anchorBoot, intel };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  loadEnv();
  process.env.PERSIST_FILE ??= 'data/events.jsonl';
  process.env.CHAIN_DIR ??= 'data/chains';
  process.env.GUARD_KEY_FILE ??= 'data/guard-key.json';
  process.env.ANCHOR_FILE ??= 'data/anchors.jsonl';
  process.env.PENDING_FILE ??= 'data/pending.json';
  const { server, stats, boot, auth, guard, anchors } = await createApp();
  const port = Number(process.env.PORT) || 3000;
  for (const n of ['OPERATOR_TOKEN', 'AGENT_TOKEN']) {
    if (process.env[n] && process.env[n].length < 16) console.warn(`WARNING: ${n} is shorter than 16 characters. Use a long random value (node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))").`);
  }
  if (String(process.env.NODE_ENV) === 'production' && String(process.env.TRUST_PROXY ?? 'false') !== 'true') {
    console.warn('NOTE: behind a reverse proxy (e.g. Render) set TRUST_PROXY=true so rate limits apply per client, not per proxy.');
  }
  const host = auth.open ? '127.0.0.1' : (process.env.HOST || '0.0.0.0');
  server.listen(port, host, () => {
    const s = stats();
    console.log(`LedgerTrue running at http://localhost:${port}`);
    console.log(`  payments mode : ${s.mode}`);
    console.log(`  guard key     : ${guard.keyId}`);
    console.log(`  anchors       : ${anchors.entries.length} signed${anchors.webhookUrl ? ', pushed to ANCHOR_WEBHOOK_URL' : ' (set ANCHOR_WEBHOOK_URL to publish them off this server)'}${anchors.broken ? '  (LOG FAILED ITS CHECK)' : ''}`);
    console.log(`  chains loaded : ${boot.loaded}${boot.quarantined.length ? `  (QUARANTINED: ${boot.quarantined.map((q) => q.id).join(', ')})` : ''}`);
    console.log(`  auth          : ${auth.open ? 'open demo mode (set OPERATOR_TOKEN / AGENT_TOKEN to lock)' : 'token protected'}`);
    console.log(`  AI            : ${s.explainer === 'nvidia' ? `LLM on (advisory only): ${new URL(process.env.AI_BASE_URL || process.env.NVIDIA_BASE_URL || DEFAULT_NVIDIA_BASE_URL).hostname}, model ${process.env.AI_MODEL || process.env.NVIDIA_MODEL || DEFAULT_NVIDIA_MODEL}` : 'offline heuristics (set AI_API_KEY in .env to turn the LLM on)'}`);
  });
}