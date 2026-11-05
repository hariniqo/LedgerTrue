// Intelligence orchestrator: five logical agents + one central decision engine.
//
// ADVISORY ONLY. This module reads chain blocks and payment events. It is never handed the engine's mutators
// (requestPayment, approve, capture, void, revoke), the gateway, or the ledger writer, so it cannot move money,
// change a balance, or edit the audit chain. test/intel.test.js proves the chain head is unchanged after analysis.
import { slimBlocks, slimEvents } from './slim.js';
import { makeMlClient } from './client.js';
import { analyzeBaseline, paymentRules, scoreRequests } from './baseline.js';

const LEVELS = ['unknown', 'low', 'medium', 'high'];
const rank = (l) => LEVELS.indexOf(l);
const maxLevel = (ls) => ls.reduce((a, b) => (rank(b) > rank(a) ? b : a), 'low');
const num = (x) => typeof x === 'number' && Number.isFinite(x);
const prob = (x) => x == null || (num(x) && x >= 0 && x <= 1);

export const AGENTS = {
  FRAUD: 'fraud-intelligence',
  BURN: 'burn-forecast',
  EXHAUST: 'exhaustion-risk',
  RECON: 'ghost-early-warning',
  BEHAVIOUR: 'agent-reliability',
};
export const UNSUPPORTED = [{ agent: 'document-intelligence', reason: 'Invoice and receipt extraction is out of scope: LedgerTrue has no invoice documents in its data model, and no OCR model was trained or evaluated.' }];

/** Central decision engine: validate one agent envelope against the authoritative chain. Never throws. */
export function validateEnvelope(env, ctx) {
  const problems = [];
  if (!Object.values(AGENTS).includes(env.agent)) problems.push('unknown agent');
  if (!LEVELS.includes(env.riskLevel)) problems.push('invalid risk level');
  if (env.confidence != null && !(num(env.confidence) && env.confidence >= 0 && env.confidence <= 1)) problems.push('confidence out of range');
  if (typeof env.modelVersion !== 'string' || !env.modelVersion) problems.push('missing model version');
  if (!num(env.timestamp)) problems.push('missing timestamp');
  if (env.isEstimate !== true) problems.push('prediction not labelled as an estimate');
  for (const ev of env.evidence ?? []) {
    if (ev.ref?.requestId && ctx.requestIds && !ctx.requestIds.has(ev.ref.requestId)) problems.push(`evidence cites unknown request ${String(ev.ref.requestId).slice(0, 20)}`);
    if (ev.ref?.paymentId && ctx.paymentIds && !ctx.paymentIds.has(ev.ref.paymentId)) problems.push(`evidence cites unknown payment ${String(ev.ref.paymentId).slice(0, 24)}`);
    if (typeof ev.text !== 'string' || ev.text.length > 400) problems.push('evidence text invalid');
  }
  const p = env.prediction ?? {};
  if (env.agent === AGENTS.FRAUD) {
    for (const f of p.flagged ?? []) if (!prob(f.score) || (ctx.requestIds && !ctx.requestIds.has(f.requestId))) problems.push('flagged request invalid');
  }
  if (env.agent === AGENTS.BURN) {
    for (const h of p.horizons ?? []) {
      const xs = [h.p10, h.p50, h.p90].filter((x) => x != null);
      if (xs.some((x) => !num(x) || x < 0) || (h.p10 != null && h.p90 != null && !(h.p10 <= h.p50 && h.p50 <= h.p90)) || !prob(h.exceedsBudgetProb)) problems.push('forecast horizon invalid');
    }
    if (p.exhaustion && !prob(p.exhaustion.probBeforeExpiry)) problems.push('exhaustion probability invalid');
    if (num(p.committedCents) && num(ctx.serverCommittedCents) && p.committedCents !== ctx.serverCommittedCents) problems.push('forecast committed total differs from the server ledger');
  }
  if (env.agent === AGENTS.EXHAUST && !prob(p.probability)) problems.push('probability invalid');
  if (env.agent === AGENTS.RECON) {
    for (const x of p.payments ?? []) if (!prob(x.attentionProbability) || !prob(x.moneyMovedProbability)) problems.push('payment probability invalid');
  }
  return { ok: problems.length === 0, problems };
}

function reject(env, problems) {
  return { ...env, prediction: null, riskLevel: 'unknown', confidence: null, evidence: [], recommendedAction: 'This result failed validation and is not shown. Rely on the deterministic rules.',
    dataQuality: { status: 'rejected', notes: problems }, validation: { accepted: false, problems } };
}

const dq = (status, notes = []) => ({ status, notes });
const priorityEvidence = (list, n = 5) => list.slice(0, n);

export function createIntel({ chains, recon, env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), unresolved = () => 0 } = {}) {
  const client = makeMlClient({ url: env.ML_SERVICE_URL, token: env.ML_SERVICE_TOKEN, timeoutMs: Number(env.ML_SERVICE_TIMEOUT_MS) || 4000, fetchImpl, now });
  const threshold = Number(env.ML_RISK_THRESHOLD) || 0.5;
  const escalation = String(env.ML_RISK_ESCALATION ?? 'false') === 'true';
  const cache = new Map(); // mandateId -> { key, at, result }
  const CACHE_MS = 10_000;
  const history = []; // last analyses, for monitoring (counts only, no content)
  let modelsCache = { at: 0, value: null };

  const mandateCtx = (id) => {
    const chain = chains.get(id);
    const s = chains.summary(id);
    return { chain, summary: s, serverCommitted: s.budgetCents - s.availableCents, requestIds: new Set(Object.keys(chain.state.requests)) };
  };
  const unresolvedFor = (id) => { try { return Number(unresolved(id)) || 0; } catch { return 0; } };

  function envelopes(id, a, ctx, ts) {
    const engine = a.engine;
    const mv = (k) => `${a.modelVersions?.[k] ?? 'n/a'}`;
    const out = [];
    const scored = a.requests ?? [];
    const flagged = scored.filter((r) => r.level !== 'low').sort((x, y) => y.score - x.score);
    const recent = scored.slice(-50);
    const top = flagged[0];
    out.push({
      agent: AGENTS.FRAUD, inputRef: { kind: 'mandate', id, headIndex: ctx.chain.blocks.length - 1 },
      prediction: { scored: a.riskSummary?.scored ?? 0, high: a.riskSummary?.high ?? 0, medium: a.riskSummary?.medium ?? 0, maxScore: a.riskSummary?.maxScore ?? 0,
        flagged: flagged.slice(0, 20).map((r) => ({ requestId: r.requestId, agentId: r.agentId, amountCents: r.amountCents, merchant: r.merchant, score: r.score, level: r.level, outcome: r.outcome ?? null })) },
      riskLevel: scored.length ? maxLevel(recent.map((r) => r.level)) : 'unknown',
      confidence: flagged.length ? +(flagged.reduce((s, r) => s + (r.confidence ?? 0.5), 0) / flagged.length).toFixed(2) : null,
      evidence: priorityEvidence(flagged.flatMap((r) => (r.evidence ?? []).slice(0, 1).map((e) => ({ kind: 'request', text: e.text, ref: { requestId: r.requestId }, score: r.score })))),
      modelVersion: mv('risk'), engine, timestamp: ts, isEstimate: true,
      recommendedAction: top ? `Review request ${top.requestId} (${top.level} spend risk) before approving similar requests. This is a prompt to look, not a finding of fraud.` : 'No unusual spending behaviour detected in recent requests.',
      dataQuality: scored.length === 0 ? dq('insufficient_history', ['No requests yet.']) : scored.slice(-1)[0]?.dataQuality === 'cold_start' ? dq('cold_start', ['Some agents have fewer than 5 prior requests, so scores are less certain.']) : dq('ok'),
    });
    const f = a.forecast ?? {};
    const ex = f.exhaustion;
    const burnLevel = f.status !== 'ok' ? 'unknown' : ex?.probBeforeExpiry != null ? (ex.probBeforeExpiry >= 0.6 ? 'high' : ex.probBeforeExpiry >= 0.3 ? 'medium' : 'low') : ex?.projectedBeforeExpiry ? 'medium' : 'low';
    out.push({
      agent: AGENTS.BURN, inputRef: { kind: 'mandate', id, headIndex: ctx.chain.blocks.length - 1 },
      prediction: { status: f.status, committedCents: f.committedCents, budgetCents: f.budgetCents, horizons: f.horizons ?? [], exhaustion: ex ?? null, runRatePerDayCents: f.runRatePerDayCents ?? null, volatilityCv: f.volatilityCv ?? null, intervalScale: f.intervalScale ?? null },
      riskLevel: burnLevel, confidence: f.status === 'ok' && engine === 'ml' ? 0.8 : null,
      evidence: f.status === 'ok' ? [{ kind: 'forecast', text: `Average spend ${Math.round((f.runRatePerDayCents ?? 0))} minor units per day; ${f.intervalScale ? '80% interval calibrated on held-out backtests' : 'straight-line projection, no interval'}.` }] : [{ kind: 'forecast', text: f.note ?? 'Not enough history.' }],
      modelVersion: mv('forecast'), engine, timestamp: ts, isEstimate: true,
      recommendedAction: burnLevel === 'high' ? 'At the current pace the budget is likely to run out before expiry. Consider topping up the mandate or lowering the per-payment cap.' : burnLevel === 'medium' ? 'Watch the pace of spending.' : 'Spending pace is within the budget.',
      dataQuality: dq(f.dataQuality ?? 'ok', f.note ? [f.note] : []),
    });
    const d = a.distress ?? {};
    out.push({
      agent: AGENTS.EXHAUST, inputRef: { kind: 'mandate', id, headIndex: ctx.chain.blocks.length - 1 },
      prediction: { status: d.status, probability: d.probability ?? null, alreadyExhausted: Boolean(d.alreadyExhausted), forecastProbability: d.forecastProbability ?? null, agreement: d.agreement ?? null, algorithm: d.algorithm ?? null, projectedUtilAtExpiry: d.projectedUtilAtExpiry ?? null },
      riskLevel: d.status === 'ok' ? d.level : 'unknown', confidence: d.status === 'ok' && engine === 'ml' ? (d.agreement === false ? 0.5 : 0.75) : null,
      evidence: (d.contributions ?? []).map((c) => ({ kind: 'driver', text: `${c.group}: ${c.contribution >= 0 ? 'raises' : 'lowers'} the estimate by ${Math.abs(Math.round(c.contribution * 100))} points` })),
      modelVersion: mv('distress'), engine, timestamp: ts, isEstimate: true,
      recommendedAction: d.level === 'high' ? 'Budget exhaustion before expiry looks likely. Decide now whether to extend the budget.' : d.level === 'medium' ? 'Exhaustion is possible. Re-check after the next few requests.' : 'No early warning.',
      dataQuality: dq(d.status === 'ok' ? 'ok' : (d.status ?? 'unknown'), d.agreement === false ? ['The classifier and the forecast disagree by more than 25 points.'] : []),
    });
    const beh = a.behaviour ?? [];
    out.push({
      agent: AGENTS.BEHAVIOUR, inputRef: { kind: 'mandate', id, headIndex: ctx.chain.blocks.length - 1 },
      prediction: { agents: beh }, riskLevel: beh.some((x) => x.label === 'unreliable') ? 'high' : beh.some((x) => x.label === 'watch') ? 'medium' : beh.length ? 'low' : 'unknown',
      confidence: null, evidence: beh.filter((x) => x.label === 'unreliable' || x.label === 'watch').map((x) => ({ kind: 'agent', text: `${x.agent}: ${x.blocked} of ${x.requests} requests blocked by rules (95% interval ${Math.round(x.blockRateInterval95[0] * 100)}-${Math.round(x.blockRateInterval95[1] * 100)}%)` })),
      modelVersion: 'wilson-interval-1', engine: 'statistics', timestamp: ts, isEstimate: true,
      recommendedAction: beh.some((x) => x.label === 'unreliable') ? 'An agent keeps hitting hard rules. Check its instructions or remove it from the mandate.' : 'Agent behaviour is within expectations.',
      dataQuality: beh.every((x) => x.label === 'insufficient_data') ? dq('insufficient_history', ['Fewer than 5 requests per agent.']) : dq('ok'),
    });
    return out;
  }

  function decide(envs, ctx) {
    const vctx = { requestIds: ctx.requestIds, serverCommittedCents: ctx.serverCommitted };
    const results = envs.map((e) => { const v = validateEnvelope(e, vctx); return v.ok ? { ...e, validation: { accepted: true, problems: [] } } : reject(e, v.problems); });
    const accepted = results.filter((r) => r.validation.accepted);
    const level = accepted.length ? maxLevel(accepted.map((r) => r.riskLevel).filter((l) => l !== 'unknown')) : 'unknown';
    const recs = [...new Set(accepted.filter((r) => rank(r.riskLevel) >= rank('medium')).map((r) => r.recommendedAction))];
    return { agents: results, overall: { riskLevel: level, advisoryOnly: true, recommendations: recs, rejectedAgents: results.filter((r) => !r.validation.accepted).map((r) => r.agent) } };
  }

  async function analyzeMandate(id, { force = false } = {}) {
    const ctx = mandateCtx(id);
    const ts = now();
    const head = ctx.chain.blocks.at(-1)?.hash ?? '';
    const key = `${head}|${client.enabled}`;
    const hit = cache.get(id);
    if (!force && hit && hit.key === key && ts - hit.at < CACHE_MS) return hit.result;
    if (ctx.chain.quarantined) {
      const result = { mandateId: id, asOf: ts, engine: 'none', quarantined: true, agents: [], overall: { riskLevel: 'unknown', advisoryOnly: true, recommendations: [], rejectedAgents: [] }, note: 'This chain failed its integrity check, so no analysis is run on it.' };
      cache.set(id, { key, at: ts, result });
      return result;
    }
    const blocks = ctx.chain.blocks;
    let raw = null; let mlStatus = client.enabled ? 'unavailable' : 'not_configured'; let mlNote = null;
    if (client.enabled) {
      const r = await client.analyzeMandate({ blocks: slimBlocks(blocks), now: ts, context: { serverCommittedCents: ctx.serverCommitted, quarantined: false, unresolvedCaptures: unresolvedFor(id) } });
      if (r.ok && r.data.committedMatchesServer !== false) { raw = r.data; mlStatus = 'ok'; }
      else if (r.ok) { mlStatus = 'rejected'; mlNote = 'The ML service computed a different committed total than the ledger, so its output was discarded.'; }
      else mlStatus = r.reason;
    }
    raw ??= analyzeBaseline(blocks, ts, { quarantined: false });
    const decided = decide(envelopes(id, raw, ctx, ts), ctx);
    const result = { mandateId: id, asOf: ts, engine: raw.engine, mlStatus, mlNote, headIndex: blocks.length - 1, ...decided,
      detail: { requests: raw.requests, forecast: raw.forecast, distress: raw.distress, behaviour: raw.behaviour, health: raw.health, riskSummary: raw.riskSummary, committedCents: raw.committedCents, budgetCents: raw.budgetCents, modelVersions: raw.modelVersions } };
    cache.set(id, { key, at: ts, result });
    history.push({ at: ts, engine: raw.engine, high: raw.riskSummary?.high ?? 0, scored: raw.riskSummary?.scored ?? 0, rejected: decided.overall.rejectedAgents.length });
    if (history.length > 200) history.shift();
    return result;
  }

  async function analyzePayments() {
    const ts = now();
    const snaps = recon ? recon.list() : [];
    const items = snaps.slice(0, 100).map((p) => ({ paymentId: p.paymentId, engineState: p.state, events: slimEvents(recon.store.rawFor(p.paymentId)) })).filter((p) => p.events.length);
    const paymentIds = new Set(items.map((p) => p.paymentId));
    let payments; let engine = 'baseline'; let version = 'baseline-rules-1'; let mlStatus = client.enabled ? 'unavailable' : 'not_configured';
    if (client.enabled && items.length) {
      const r = await client.analyzePayments({ payments: items, now: ts });
      if (r.ok) { payments = r.data.payments; engine = 'ml'; version = r.data.modelVersion; mlStatus = 'ok'; } else mlStatus = r.reason;
    }
    payments ??= items.map((p) => paymentRules(p, p.events, ts));
    const worst = maxLevel(payments.map((p) => p.level));
    const top = [...payments].filter((p) => p.level !== 'low').sort((a, b) => (b.attentionProbability ?? 0) - (a.attentionProbability ?? 0));
    const env = {
      agent: AGENTS.RECON, inputRef: { kind: 'payments', count: items.length }, prediction: { payments },
      riskLevel: items.length ? worst : 'unknown', confidence: engine === 'ml' ? 0.7 : null,
      evidence: top.slice(0, 5).flatMap((p) => (p.evidence ?? []).slice(0, 1).map((e) => ({ kind: 'payment', text: e.text, ref: { paymentId: p.paymentId } }))),
      modelVersion: version, engine, timestamp: ts, isEstimate: true,
      recommendedAction: top[0] ? `Hold fulfilment and block customer retries for ${top[0].paymentId} until PayPal confirms. The reconciler stays authoritative.` : 'No payment needs special attention.',
      dataQuality: items.length ? dq('ok') : dq('insufficient_history', ['No payments yet.']),
    };
    const v = validateEnvelope(env, { paymentIds });
    return { asOf: ts, mlStatus, agent: v.ok ? { ...env, validation: { accepted: true, problems: [] } } : reject(env, v.problems) };
  }

  async function overview() {
    const ids = chains.ids().slice(0, 50);
    const rows = [];
    for (const id of ids) {
      const a = await analyzeMandate(id);
      const s = chains.summary(id);
      const d = a.detail;
      rows.push({ id, title: s.title, currency: s.currency, quarantined: Boolean(a.quarantined), revoked: s.revoked, riskLevel: a.overall.riskLevel, engine: a.engine,
        health: d?.health ? { score: d.health.score, band: d.health.band } : null, flagged: d?.riskSummary?.high ?? 0, medium: d?.riskSummary?.medium ?? 0,
        exhaustionLevel: d?.distress?.level ?? null, exhaustionProbability: d?.distress?.probability ?? null, rejectedAgents: a.overall.rejectedAgents.length });
    }
    const pay = await analyzePayments();
    return { asOf: now(), mandates: rows, payments: { riskLevel: pay.agent.riskLevel, mlStatus: pay.mlStatus, flagged: (pay.agent.prediction?.payments ?? []).filter((p) => p.level !== 'low').length, total: pay.agent.inputRef.count },
      totals: { mandates: rows.length, highRisk: rows.filter((r) => r.riskLevel === 'high').length, flaggedRequests: rows.reduce((s, r) => s + r.flagged, 0), avgHealth: rows.filter((r) => r.health).length ? +(rows.reduce((s, r) => s + (r.health?.score ?? 0), 0) / rows.filter((r) => r.health).length).toFixed(1) : null } };
  }

  async function status() {
    const ts = now();
    if (ts - modelsCache.at > 10_000) {
      let value = { connected: false, reason: client.enabled ? 'unreachable' : 'not_configured' };
      if (client.enabled) {
        const [m, mon] = await Promise.all([client.models(), client.monitor()]);
        if (m.ok) value = { connected: true, models: m.data.models, drift: mon.ok ? mon.data.drift : null };
        else value = { connected: false, reason: m.reason };
      }
      modelsCache = { at: ts, value };
    }
    const ml = modelsCache.value;
    const rejected = history.filter((h) => h.rejected > 0).length;
    return { advisoryOnly: true, engine: ml.connected ? 'ml' : 'baseline', ml, baseline: { available: true, description: 'Deterministic rules, no training, no probabilities.' },
      escalation: { enabled: escalation, threshold, note: escalation ? 'A high spend-risk score adds an owner-approval step. It can never approve or block.' : 'Off. Scores are shown but never change a decision.' },
      unsupported: UNSUPPORTED, monitoring: { analysesRun: history.length, analysesWithRejectedAgents: rejected, lastAnalysisAt: history.at(-1)?.at ?? null } };
  }

  /** Hook for the guard: one advisory flag recorded on the REQUEST block. Can only ask the owner to look. */
  async function riskScorer({ mandate, request, blocks, ts }) {
    if (!escalation) return { checked: false, source: 'disabled' };
    try {
      const cand = { requestId: request.requestId, agentId: request.agentId, merchant: request.merchant, amountCents: request.amountCents };
      if (client.enabled) {
        const r = await client.scoreRequest({ blocks: slimBlocks(blocks), candidate: cand, ts });
        if (r.ok && num(r.data.score)) {
          const score = +Number(r.data.score).toFixed(4);
          return { checked: true, source: 'ml', modelVersion: String(r.data.modelVersion ?? ''), score, level: r.data.level, threshold, escalate: score >= threshold };
        }
      }
      const rows = scoreRequests(blocks, cand, ts);
      const last = rows.at(-1);
      return { checked: true, source: 'baseline', modelVersion: 'baseline-rules-1', score: +last.score.toFixed(4), level: last.level, threshold: 0.8, escalate: last.level === 'high' };
    } catch {
      return { checked: false, source: 'error' };
    }
  }

  const cached = (id) => cache.get(id)?.result ?? null;
  async function synthetic(seed = 1) {
    if (!client.enabled) return { ok: false, reason: 'not_configured' };
    const s = await client.synthetic(seed);
    if (!s.ok) return { ok: false, reason: s.reason };
    const a = await client.analyzeMandate({ blocks: s.data.blocks, now: s.data.now, context: {} });
    if (!a.ok) return { ok: false, reason: a.reason };
    return { ok: true, synthetic: true, note: s.data.note, analysis: a.data };
  }

  return { analyzeMandate, analyzePayments, overview, status, riskScorer, cached, synthetic, client, escalation, threshold };
}
