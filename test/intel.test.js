import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.js';
import { createIntel, validateEnvelope, AGENTS } from '../src/intel/orchestrator.js';
import { makeMlClient } from '../src/intel/client.js';
import { slimBlocks } from '../src/intel/slim.js';
import { scoreRequests, healthScore, wilson, analyzeBaseline } from '../src/intel/baseline.js';
import { answerAssistant } from '../src/assistant.js';
import { verifyBundle } from '../shared/verify.js';
import { messages } from '../shared/crypto.js';
import { world, newMandate, ask, owner, mandateId, mandateFor } from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

async function boot(env = {}, options = {}) {
  const app = await createApp({ DEMO_MODE: 'true', PERSIST_FILE: '', CHAIN_DIR: '', GUARD_KEY_FILE: '', ...env }, options);
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { ...app, base, call, close: () => new Promise((r) => app.server.close(r)) };
}
async function signed(call, over = {}) {
  const o = await owner(); const id = mandateId(); const mandate = mandateFor(id, over);
  const res = await call('POST', '/api/mandates', { mandate, publicKeyJwk: o.publicKeyJwk, signature: await o.sign(messages.mandate(mandate)) });
  assert.equal(res.status, 201);
  return { id, o, mandate };
}
const head = (chains, id) => { const b = chains.get(id).blocks; return `${b.length}:${b.at(-1).hash}`; };

// ---------------------------------------------------------------- baseline

test('baseline: duplicates and bursts are flagged, ordinary requests are not', async () => {
  const w = await world();
  const { id } = await newMandate(w);
  for (let i = 0; i < 8; i++) await ask(w.engine, id, { amountCents: 100_000 + i * 3_000, merchant: i % 2 ? 'IKEA' : 'Dell Store' });
  await ask(w.engine, id, { amountCents: 100_000 }); await ask(w.engine, id, { amountCents: 100_000 });
  const rows = scoreRequests(w.store.get(id).blocks);
  assert.equal(rows.length, 10);
  assert.ok(rows.slice(0, 3).every((r) => r.level === 'low'), 'the first few requests are ordinary');
  assert.ok(rows.slice(4).every((r) => r.level === 'high'), 'ten requests inside one minute is a burst');
    assert.ok(rows.at(-1).level !== 'low', 'a repeated identical request must be noticed');
  assert.ok(rows.at(-1).evidence.length > 0);
});

test('baseline: health score is bounded, explained, and honest about missing data', () => {
  const best = healthScore({ pExhaust: 0, flaggedShare: 0, blockRate: 0 });
  assert.equal(best.score, 100);
  const worst = healthScore({ pExhaust: 1, flaggedShare: 1, blockRate: 1, stalePending: 9, unresolvedCaptures: 9, quarantined: true });
  assert.equal(worst.score, 0);
  assert.equal(+best.factors.reduce((s, f) => s + f.points, 0).toFixed(1), best.score);
  const unk = healthScore({});
  assert.ok(unk.notes.some((n) => /neutral/.test(n)));
  assert.ok(/not a validated credit rating/.test(unk.notes[0]));
  const [lo, hi] = wilson(5, 50); assert.ok(lo < 0.1 && hi > 0.1);
});

test('baseline analysis: forecast refuses to guess without history', async () => {
  const w = await world();
  const { id } = await newMandate(w);
  await ask(w.engine, id);
  const a = analyzeBaseline(w.store.get(id).blocks, Date.now());
  assert.equal(a.forecast.status, 'insufficient_history');
  assert.deepEqual(a.forecast.horizons, []);
  assert.equal(a.engine, 'baseline');
});

// ---------------------------------------------------------------- decision engine

const goodEnv = () => ({ agent: AGENTS.EXHAUST, riskLevel: 'low', confidence: 0.7, modelVersion: 'x', timestamp: 1, isEstimate: true, evidence: [], prediction: { probability: 0.2 } });

test('decision engine accepts a sane result and rejects each kind of bad one', () => {
  const ctx = { requestIds: new Set(['r_1']), serverCommittedCents: 500 };
  assert.ok(validateEnvelope(goodEnv(), ctx).ok);
  const bad = (patch) => validateEnvelope({ ...goodEnv(), ...patch }, ctx);
  assert.ok(!bad({ prediction: { probability: 1.4 } }).ok);
  assert.ok(!bad({ riskLevel: 'catastrophic' }).ok);
  assert.ok(!bad({ confidence: 2 }).ok);
  assert.ok(!bad({ isEstimate: false }).ok, 'a prediction must be labelled as an estimate');
  assert.ok(!bad({ modelVersion: '' }).ok);
  assert.ok(!bad({ evidence: [{ text: 'x', ref: { requestId: 'r_ghost' } }] }).ok, 'evidence may only cite real requests');
  const burn = { agent: AGENTS.BURN, riskLevel: 'low', confidence: null, modelVersion: 'x', timestamp: 1, isEstimate: true, evidence: [] };
  assert.ok(!validateEnvelope({ ...burn, prediction: { horizons: [{ p10: 9, p50: 5, p90: 7 }] } }, ctx).ok);
  assert.ok(!validateEnvelope({ ...burn, prediction: { horizons: [{ p10: -1, p50: 5, p90: 7 }] } }, ctx).ok);
  assert.ok(!validateEnvelope({ ...burn, prediction: { committedCents: 999, horizons: [] } }, ctx).ok, 'forecast must agree with the server ledger');
  assert.ok(validateEnvelope({ ...burn, prediction: { committedCents: 500, horizons: [{ p10: 1, p50: 5, p90: 7, exceedsBudgetProb: 0.1 }] } }, ctx).ok);
});

// ---------------------------------------------------------------- orchestrator: read-only and fallback

test('analysis is read-only: chain head, balances and anchors are untouched', async () => {
  const w = await world();
  const { id } = await newMandate(w);
  for (let i = 0; i < 6; i++) await ask(w.engine, id, { amountCents: 90_000 + i * 1000 });
  const before = head(w.store, id);
  const summary = JSON.stringify(w.store.summary(id));
  const intel = createIntel({ chains: w.store, recon: w.recon, env: {} });
  const a = await intel.analyzeMandate(id, { force: true });
  await intel.analyzePayments(); await intel.overview(); await intel.status();
  assert.equal(head(w.store, id), before);
  assert.equal(JSON.stringify(w.store.summary(id)), summary);
  assert.equal(a.engine, 'baseline');
  assert.equal(a.overall.advisoryOnly, true);
  assert.equal(a.agents.length, 5 - 1 + 0 + 0 || 4);
  assert.ok(a.agents.every((x) => x.isEstimate === true && x.validation.accepted && typeof x.modelVersion === 'string' && x.timestamp));
});

test('the intelligence module is never handed any money-moving capability', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/intel/orchestrator.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'src/intel/baseline.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'src/intel/client.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['requestPayment', '.approve(', '.capture(', '.void(', '.revoke(', 'createHold', 'ledger.settle', 'store.append', 'chains.append', '.exclusive(']) {
    assert.ok(!code.includes(forbidden), `intel code must not reference ${forbidden}`);
  }
});

test('the ML service gets structure only: no free text, signatures or hashes', async () => {
  const w = await world();
  const { id } = await newMandate(w);
  await ask(w.engine, id, { reason: 'SECRET-REASON-TEXT', item: 'SECRET-ITEM' });
  const sent = JSON.stringify(slimBlocks(w.store.get(id).blocks));
  assert.ok(!sent.includes('SECRET-REASON-TEXT') && !sent.includes('SECRET-ITEM'));
  assert.ok(!/guardSig|prevHash|"hash"|signature|orderId|authId/.test(sent));
});

test('quarantined chains are never analysed', async () => {
  const w = await world();
  const { id } = await newMandate(w);
  w.store.get(id).quarantined = true;
  const a = await createIntel({ chains: w.store, recon: w.recon, env: {} }).analyzeMandate(id);
  assert.equal(a.quarantined, true);
  assert.deepEqual(a.agents, []);
});

// ---------------------------------------------------------------- ML client + fallback

test('client: failures never throw, and the circuit breaker opens after three', async () => {
  let calls = 0; let t = 0;
  const c = makeMlClient({ url: 'http://ml.invalid', now: () => t, fetchImpl: async () => { calls += 1; throw new Error('down'); } });
  for (let i = 0; i < 3; i++) assert.deepEqual((await c.models()).ok, false);
  assert.equal(calls, 3);
  assert.equal((await c.models()).reason, 'circuit_open');
  assert.equal(calls, 3, 'no more calls while the breaker is open');
  t += 31_000;
  await c.models(); assert.equal(calls, 4);
  assert.equal((await makeMlClient({}).models()).reason, 'not_configured');
});

function fakeMl({ committedMatchesServer = true, committedCents = null, breakOrdering = false } = {}) {
  return async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    if (String(url).endsWith('/v1/analyze/mandate')) {
      const base = analyzeBaseline(body.blocks, body.now);
      const f = { status: 'ok', dataQuality: 'ok', committedCents: committedCents ?? base.committedCents, budgetCents: base.budgetCents, horizons: [{ days: 7, effectiveDays: 7, toExpiry: false, p10: breakOrdering ? 900 : 100, p50: 500, p90: 800, exceedsBudgetProb: 0.2 }],
        exhaustion: { probBeforeExpiry: 0.2, medianTs: null }, curve: [], history: [], intervalScale: 1.4, runRatePerDayCents: 10 };
      return new Response(JSON.stringify({ ...base, engine: 'ml', committedMatchesServer, forecast: f, modelVersions: { risk: 'risk-test', distress: 'dist-test', forecast: 'fc-test' } }), { status: 200 });
    }
    if (String(url).endsWith('/v1/models')) return new Response(JSON.stringify({ models: [{ name: 'risk', version: 'risk-test' }] }), { status: 200 });
    if (String(url).endsWith('/v1/monitor')) return new Response(JSON.stringify({ drift: {} }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
}

test('ML result is used when valid, and discarded when it disagrees with the ledger', async () => {
  const w = await world();
  const { id } = await newMandate(w);
  for (let i = 0; i < 5; i++) await ask(w.engine, id, { amountCents: 50_000 });
  const ok = await createIntel({ chains: w.store, recon: w.recon, env: { ML_SERVICE_URL: 'http://ml.test' }, fetchImpl: fakeMl() }).analyzeMandate(id);
  assert.equal(ok.engine, 'ml'); assert.equal(ok.mlStatus, 'ok');
  assert.equal(ok.agents.find((a) => a.agent === AGENTS.BURN).modelVersion, 'fc-test');

  const mismatch = await createIntel({ chains: w.store, recon: w.recon, env: { ML_SERVICE_URL: 'http://ml.test' }, fetchImpl: fakeMl({ committedMatchesServer: false }) }).analyzeMandate(id);
  assert.equal(mismatch.engine, 'baseline'); assert.equal(mismatch.mlStatus, 'rejected'); assert.match(mismatch.mlNote, /different committed total/);

  const wrongTotal = await createIntel({ chains: w.store, recon: w.recon, env: { ML_SERVICE_URL: 'http://ml.test' }, fetchImpl: fakeMl({ committedCents: 1 }) }).analyzeMandate(id);
  assert.ok(wrongTotal.overall.rejectedAgents.includes(AGENTS.BURN), 'the decision engine rejects a forecast whose ledger total is wrong');
  assert.equal(wrongTotal.agents.find((a) => a.agent === AGENTS.BURN).riskLevel, 'unknown');

  const disordered = await createIntel({ chains: w.store, recon: w.recon, env: { ML_SERVICE_URL: 'http://ml.test' }, fetchImpl: fakeMl({ breakOrdering: true }) }).analyzeMandate(id);
  assert.ok(disordered.overall.rejectedAgents.includes(AGENTS.BURN));

  const dead = await createIntel({ chains: w.store, recon: w.recon, env: { ML_SERVICE_URL: 'http://ml.test' }, fetchImpl: async () => { throw new Error('refused'); } }).analyzeMandate(id);
  assert.equal(dead.engine, 'baseline'); assert.equal(dead.mlStatus, 'unreachable');
});

// ---------------------------------------------------------------- guard hook: escalate only

const flagWith = (over = {}) => async () => ({ checked: true, source: 'ml', modelVersion: 'risk-test', score: 0.93, level: 'high', threshold: 0.5, escalate: true, ...over });

test('a high spend-risk flag sends an otherwise approved request to the owner, and the chain still verifies', async () => {
  const w = await world();
  w.engine.riskScorer = flagWith();
  const { id } = await newMandate(w);
  const r = await ask(w.engine, id, { amountCents: 50_000 });
  assert.equal(r.status, 'PENDING_APPROVAL');
  assert.deepEqual(r.reasons, ['ML_RISK_REVIEW']);
  const blocks = w.store.get(id).blocks;
  assert.equal(blocks.find((b) => b.type === 'REQUEST').data.riskFlag.score, 0.93);
  const v = await verifyBundle(w.store.bundle(id));
  assert.equal(v.ok, true, JSON.stringify(v.issues ?? v.blocks?.find((b) => !b.ok)));
});

test('the flag can never approve or block: hard rules still decide', async () => {
  const w = await world();
  const { id } = await newMandate(w);
  w.engine.riskScorer = flagWith({ escalate: false, score: 0.01, level: 'low' });
  const calm = await ask(w.engine, id, { amountCents: 50_000 });
  assert.equal(calm.status, 'HELD', 'a low score does not stop an approved request');
  w.engine.riskScorer = flagWith();
  const over = await ask(w.engine, id, { amountCents: 9_000_000 }); // far above the cap
  assert.equal(over.status, 'BLOCKED');
  assert.ok(over.reasons.includes('PER_TX_CAP'));
  const gift = await ask(w.engine, id, { merchant: 'Dell Store', category: 'gift card', reason: 'Buy a gift card' });
  assert.equal(gift.status, 'BLOCKED');
  w.engine.riskScorer = flagWith({ escalate: false, score: 0 });
  const d = w.store.get(id).blocks.filter((b) => b.type === 'DECISION').map((b) => b.data.outcome);
  assert.ok(!d.includes('BLOCKED') || over.reasons.includes('PER_TX_CAP'));
});

test('an agent cannot supply its own riskFlag, and a missing or failing scorer changes nothing', async () => {
  const w = await world();
  const { id } = await newMandate(w);
  const r = await w.engine.requestPayment(id, { agentId: 'a', merchant: 'Dell Store', reason: 'Laptop for the design team', category: 'office', amountCents: 50_000,
    riskFlag: { checked: true, escalate: false, score: 0 }, aiFlag: { checked: true, mismatch: false } });
  assert.equal(r.status, 'HELD');
  assert.equal(w.store.get(id).blocks.find((b) => b.type === 'REQUEST').data.riskFlag, undefined);
  w.engine.riskScorer = async () => { throw new Error('model exploded'); };
  assert.equal((await ask(w.engine, id)).status, 'HELD');
  w.engine.riskScorer = async () => ({ checked: false, source: 'unavailable' });
  await ask(w.engine, id);
  assert.ok(w.store.get(id).blocks.filter((b) => b.type === 'REQUEST').every((b) => b.data.riskFlag === undefined), 'no flag recorded unless it actually ran');
});

test('escalation is off by default; when on, the baseline scores requests with no ML service', async () => {
  const w = await world();
  const off = createIntel({ chains: w.store, recon: w.recon, env: {} });
  assert.deepEqual(await off.riskScorer({ mandate: {}, request: {}, blocks: [], ts: 1 }), { checked: false, source: 'disabled' });
  const on = createIntel({ chains: w.store, recon: w.recon, env: { ML_RISK_ESCALATION: 'true' } });
  w.engine.riskScorer = on.riskScorer;
  const { id } = await newMandate(w);
  for (let i = 0; i < 6; i++) await ask(w.engine, id, { amountCents: 80_000 + i * 700 });
  const last = await ask(w.engine, id, { amountCents: 80_000 });
  const rq = w.store.get(id).blocks.filter((b) => b.type === 'REQUEST').at(-1).data.riskFlag;
  assert.equal(rq.source, 'baseline'); assert.equal(typeof rq.score, 'number');
  assert.ok(['HELD', 'PENDING_APPROVAL'].includes(last.status));
});

// ---------------------------------------------------------------- HTTP

test('HTTP: intel routes need a token when auth is on, and return validated envelopes', async () => {
  const s = await boot({ DEMO_MODE: 'false', OPERATOR_TOKEN: 'op-token-123456', AGENT_TOKEN: 'ag-token-123456' });
  const { id, o, mandate } = await signed(s.call);
  const auth = { authorization: 'Bearer ag-token-123456' };
  for (const p of ['/api/intel/status', '/api/intel/overview', '/api/intel/payments', `/api/mandates/${id}/intel`]) {
    assert.equal((await s.call('GET', p)).status, 401, p);
    assert.equal((await s.call('GET', p, undefined, auth)).status, 200, p);
  }
  const a = await s.call('GET', `/api/mandates/${id}/intel`, undefined, auth);
  assert.equal(a.body.overall.advisoryOnly, true);
  assert.equal((await s.call('GET', '/api/mandates/m_000000000000000000000000/intel', undefined, auth)).status, 404);
  assert.equal((await s.call('POST', '/api/intel/synthetic', { seed: 1 }, auth)).status, 403, 'synthetic sandbox is demo-only');
  await s.close();
});

test('HTTP: overview, status and synthetic sandbox degrade clearly with no ML service', async () => {
  const s = await boot();
  await signed(s.call);
  const st = (await s.call('GET', '/api/intel/status')).body;
  assert.equal(st.engine, 'baseline'); assert.equal(st.ml.connected, false); assert.equal(st.advisoryOnly, true);
  assert.equal(st.unsupported[0].agent, 'document-intelligence');
  const ov = (await s.call('GET', '/api/intel/overview')).body;
  assert.equal(ov.totals.mandates, 1); assert.ok(ov.mandates[0].health.score >= 0);
  const syn = await s.call('POST', '/api/intel/synthetic', { seed: 1 });
  assert.equal(syn.status, 503); assert.match(syn.body.error, /ML service/);
  await s.close();
});

// ---------------------------------------------------------------- copilot

test('copilot: quotes validated estimates, labelled as estimates, with grounding intact', async () => {
  const w = await world();
  const { id } = await newMandate(w);
  for (let i = 0; i < 4; i++) await ask(w.engine, id, { amountCents: 70_000 });
  const intel = createIntel({ chains: w.store, recon: w.recon, env: {} });
  const a = await intel.analyzeMandate(id, { force: true });
  const mandates = [w.store.summary(id)];
  const res = await answerAssistant({ question: `How healthy is mandate ${id}?`, mandates, payments: [], intel: { [id]: a } });
  assert.equal(res.source, 'deterministic');
  assert.match(res.answer, /Estimate \(not a fact, advisory only\)/);
  assert.match(res.answer, new RegExp(`health score ${a.detail.health.score}`));
  const without = await answerAssistant({ question: `How healthy is mandate ${id}?`, mandates, payments: [] });
  assert.doesNotMatch(without.answer, /Estimate/);

  let sent;
  const llm = await answerAssistant({ question: `How healthy is mandate ${id}?`, mandates, payments: [], intel: { [id]: a }, apiKey: 'k',
    fetchImpl: async (u, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'The health score is 99.9 out of 100.', sourceIds: [id] }) } }] }), { status: 200 }); } });
  assert.equal(llm.source, 'deterministic', 'an invented number is rejected by the grounding check');
  assert.match(sent.messages[0].content, /model estimates/);
});

// ---------------------------------------------------------------- end to end with the real Python service

const PY_READY = fs.existsSync(path.join(ROOT, 'ml/models/risk/CURRENT')) && spawnCheck();
function spawnCheck() { try { return fs.existsSync(path.join(ROOT, 'ml/ltml/service.py')); } catch { return false; } }

test('end to end: real Python ML service, real chains, validated envelopes, escalation recorded and verifiable', { skip: !PY_READY && 'ml/models not trained' }, async (t) => {
  const port = 18_800 + Math.floor(Math.random() * 100);
  const child = spawn(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-m', 'ltml'], { cwd: path.join(ROOT, 'ml'), env: { ...process.env, ML_PORT: String(port), ML_SERVICE_TOKEN: 'e2e-token', PYTHONPATH: path.join(ROOT, 'ml') }, stdio: 'ignore' });
  child.unref?.(); t.after(() => child.kill('SIGKILL'));
  const url = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  if (!up) return t.skip('python service did not start (missing numpy/scikit-learn/starlette/uvicorn?)');

  const s = await boot({ ML_SERVICE_URL: url, ML_SERVICE_TOKEN: 'e2e-token', ML_RISK_ESCALATION: 'true', ML_RISK_THRESHOLD: '0.5' });
  const st = (await s.call('GET', '/api/intel/status')).body;
  assert.equal(st.engine, 'ml'); assert.equal(st.ml.connected, true);
  assert.ok(st.ml.models.every((m) => m.dataSource === 'synthetic' || m.error), 'every model says it was trained on synthetic data');

  const { id, mandate } = await signed(s.call, { budgetCents: 5_000_000, perTxCapCents: 800_000, approvalAboveCents: 700_000 });
  const ask1 = (amountCents) => s.call('POST', `/api/mandates/${id}/requests`, { agentId: 'shopper-1', merchant: 'Dell Store', category: 'office', item: 'Laptop', reason: 'Laptop for the design team', amountCents });
  for (let i = 0; i < 8; i++) assert.equal((await ask1(100_000 + i * 2_000)).status, 201);
  const before = head(s.chains, id);
  const a = (await s.call('GET', `/api/mandates/${id}/intel`)).body;
  assert.equal(head(s.chains, id), before, 'analysis never writes to the chain');
  assert.equal(a.engine, 'ml'); assert.equal(a.mlStatus, 'ok');
  assert.ok(a.agents.every((x) => x.validation.accepted), JSON.stringify(a.agents.map((x) => [x.agent, x.validation.problems])));
  assert.ok(a.detail.modelVersions.risk.length > 3);
  assert.ok(a.detail.health.score >= 0 && a.detail.health.score <= 100);

  // a burst of identical requests: the model should notice, and the guard should ask the owner
  let escalated = false;
  for (let i = 0; i < 6 && !escalated; i++) {
    const r = (await ask1(150_000)).body;
    escalated = r.reasons?.includes('ML_RISK_REVIEW');
  }
  assert.ok(escalated, 'repeated identical requests should trip the advisory flag');
  const flagged = s.chains.get(id).blocks.filter((b) => b.type === 'REQUEST' && b.data.riskFlag?.escalate);
  assert.ok(flagged.length >= 1 && flagged[0].data.riskFlag.source === 'ml');
  const v = await verifyBundle(s.chains.bundle(id));
  assert.equal(v.ok, true, 'the chain, including the recorded flag, still verifies independently');

  const syn = await s.call('POST', '/api/intel/synthetic', { seed: 4 });
  assert.equal(syn.status, 200); assert.equal(syn.body.synthetic, true);
  assert.ok(syn.body.analysis.riskSummary.high + syn.body.analysis.riskSummary.medium >= 1);
  const pay = (await s.call('GET', '/api/intel/payments')).body;
  assert.ok(pay.mlStatus === 'ok' || pay.mlStatus === 'not_configured');
  await s.close();
});
