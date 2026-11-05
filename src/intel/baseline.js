// Rule-based baseline. Same output shape as the ML service, no dependencies, always available.
// It is deliberately simple and labelled "baseline-rules" everywhere it appears: no training, no probabilities.
import { emptyState, applyBlock } from '../../shared/rules.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const EXHAUST = 0.9;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };

export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = k / n; const d = 1 + (z * z) / n; const c = p + (z * z) / (2 * n);
  const r = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - r) / d), Math.min(1, (c + r) / d)];
}

export const HEALTH_WEIGHTS = { runway: 0.30, anomaly: 0.25, discipline: 0.15, approvals: 0.10, settlement: 0.10, integrity: 0.10 };
const HEALTH_LABELS = {
  runway: 'Budget runway (chance of lasting to expiry)', anomaly: 'Unusual spend (share of recent requests flagged)',
  discipline: 'Rule discipline (share of requests blocked by rules)', approvals: 'Approval backlog (requests waiting on the owner)',
  settlement: 'Settlement certainty (captures awaiting PayPal confirmation)', integrity: 'Chain integrity',
};

export function healthScore({ pExhaust = null, flaggedShare = 0, blockRate = 0, stalePending = 0, unresolvedCaptures = 0, quarantined = false }) {
  const v = {
    runway: pExhaust == null ? 0.7 : 1 - pExhaust,
    anomaly: 1 - Math.min(1, flaggedShare * 5), discipline: 1 - Math.min(1, blockRate * 2),
    approvals: 1 - Math.min(1, stalePending / 3), settlement: 1 - Math.min(1, unresolvedCaptures / 2), integrity: quarantined ? 0 : 1,
  };
  const factors = Object.entries(v).map(([k, value]) => ({ factor: k, label: HEALTH_LABELS[k], weight: HEALTH_WEIGHTS[k], value: +value.toFixed(4), points: +(100 * HEALTH_WEIGHTS[k] * value).toFixed(2), maxPoints: +(100 * HEALTH_WEIGHTS[k]).toFixed(2) }));
  const score = +factors.reduce((s, f) => s + f.points, 0).toFixed(1);
  const notes = ['Weights are set by hand and shown above. This is an explanatory index, not a validated credit rating.'];
  if (pExhaust == null) notes.push('Runway used a neutral 70% because there is not enough spending history to forecast yet.');
  return { score, band: score >= 80 ? 'healthy' : score >= 60 ? 'watch' : 'at_risk', factors, notes };
}

/** Score every REQUEST block from information available before it. Returns [{requestId,..., score, level, evidence}]. */
export function scoreRequests(blocks, candidate = null, candidateTs = null) {
  const state = emptyState();
  const hist = new Map();
  const all = [];
  const out = [];
  const rowFor = (req, ts) => {
    const a = hist.get(req.agentId) ?? { logs: [], ts: [], merchants: new Map(), recent: [] };
    const m = state.mandate;
    const la = Math.log(Math.max(1, req.amountCents));
    const n = a.logs.length;
    const prior = n >= 3 ? a.logs : all.length >= 3 ? all : null;
    let z = 0;
    if (prior) { const med = median(prior); const mad = median(prior.map((x) => Math.abs(x - med))); z = clamp((la - med) / (1.4826 * mad + 0.15), -8, 12); }
    const last10 = a.ts.filter((t) => ts - t <= 10 * 60_000).length;
    const dup = a.recent.filter((r) => ts - r.ts <= DAY && r.merchant === req.merchant && r.amt === req.amountCents).length;
    const sim = a.recent.filter((r) => ts - r.ts <= DAY && Math.abs(r.amt - req.amountCents) <= 0.02 * req.amountCents).length;
    const isNew = n >= 3 && !a.merchants.has(req.merchant);
    const parts = [
      [clamp(z / 6, 0, 1), `Amount is ${z.toFixed(1)} robust deviations above this agent's usual ticket (${Math.round((req.amountCents / m.perTxCapCents) * 100)}% of the per-payment cap)`],
      [clamp(last10 / 5, 0, 1), `${last10} earlier request(s) by this agent in the last 10 minutes`],
      [clamp(dup / 2, 0, 1), `Same merchant and amount already requested ${dup} time(s) in 24 hours`],
      [clamp(sim / 4, 0, 1), `${sim} near-identical amount(s) from this agent in 24 hours`],
      [isNew ? 0.6 : 0, `First time this agent pays ${req.merchant}`],
    ];
    const best = parts.reduce((x, y) => (y[0] > x[0] ? y : x));
    const score = +best[0].toFixed(3);
    const level = score >= 0.8 ? 'high' : score >= 0.5 ? 'medium' : 'low';
    return { requestId: req.requestId, agentId: req.agentId, ts, amountCents: req.amountCents, merchant: req.merchant, score, noveltyPercentile: null, level, priorRequests: n,
      confidence: +Math.min(0.9, 0.3 + 0.12 * n).toFixed(2) * 0.8, dataQuality: n < 5 ? 'cold_start' : 'ok', evidence: level === 'low' ? [] : [{ group: 'rule', contribution: score, text: best[1] }] };
  };
  const remember = (req, ts) => {
    const a = hist.get(req.agentId) ?? { logs: [], ts: [], merchants: new Map(), recent: [] };
    a.logs.push(Math.log(Math.max(1, req.amountCents))); a.ts.push(ts);
    a.merchants.set(req.merchant, (a.merchants.get(req.merchant) ?? 0) + 1);
    a.recent.push({ ts, amt: req.amountCents, merchant: req.merchant });
    hist.set(req.agentId, a); all.push(Math.log(Math.max(1, req.amountCents)));
  };
  for (const b of blocks) {
    if (b.type === 'REQUEST') { out.push(rowFor(b.data, b.ts)); remember(b.data, b.ts); }
    applyBlock(state, b);
  }
  if (candidate && state.mandate) out.push(rowFor(candidate, candidateTs));
  return out;
}

export function committedSeries(blocks) {
  const s = emptyState(); const out = []; let last = 0;
  for (const b of blocks) {
    applyBlock(s, b);
    const c = s.settledCents + s.heldCents + s.reservedCents;
    if (c !== last) { out.push([b.ts, c]); last = c; }
  }
  return out;
}

function baselineForecast(mandate, blocks, now) {
  const { createdAt, expiresAt, budgetCents } = mandate;
  const series = committedSeries(blocks.filter((b) => b.ts <= now));
  const committed = series.at(-1)?.[1] ?? 0;
  const base = { engine: 'baseline-linear', committedCents: committed, budgetCents, asOf: now, expiresAt, history: series.slice(-120).map(([t, c]) => ({ t, committed: c })), curve: [], binHours: null };
  if (now >= expiresAt) return { ...base, status: 'expired', dataQuality: 'mandate_expired', horizons: [], exhaustion: null };
  const elapsed = Math.max(1, now - createdAt);
  if (elapsed < 6 * HOUR || series.length < 4) return { ...base, status: 'insufficient_history', dataQuality: 'insufficient_history', horizons: [], exhaustion: null, note: 'Needs at least 6 hours and 4 spend events for a projection.' };
  const rate = committed / elapsed; // cents per ms since creation
  const remaining = expiresAt - now;
  const horizons = [7, 30, 90].map((d) => {
    const span = Math.min(d * DAY, remaining);
    const p50 = Math.round(committed + rate * span);
    return { days: d, effectiveDays: +(span / DAY).toFixed(2), toExpiry: d * DAY >= remaining, p10: null, p50, p90: null, exceedsBudgetProb: null, projectedExceedsBudget: p50 >= budgetCents };
  });
  const thr = EXHAUST * budgetCents;
  const crossAt = committed >= thr ? now : rate > 0 ? now + (thr - committed) / rate : null;
  const will = crossAt != null && crossAt <= expiresAt;
  return { ...base, status: 'ok', dataQuality: 'ok', horizons, runRatePerDayCents: Math.round(rate * DAY),
    exhaustion: { probBeforeExpiry: null, projectedBeforeExpiry: will, medianTs: will ? Math.round(crossAt) : null, p10Ts: null, p90Ts: null, alreadyExhausted: committed >= thr },
    curve: [{ t: now, p10: null, p50: committed, p90: null }, { t: expiresAt, p10: null, p50: Math.round(committed + rate * remaining), p90: null }],
    note: 'Straight-line projection of the average spending rate. No probability or interval: that needs the ML service.' };
}

export function agentReliability(blocks, flaggedIds = new Set()) {
  const s = emptyState(); blocks.forEach((b) => applyBlock(s, b));
  const cap = s.mandate?.perTxCapCents || 1;
  const per = new Map();
  for (const r of Object.values(s.requests)) {
    const a = per.get(r.agentId) ?? { agent: r.agentId, requests: 0, blocked: 0, needsOwner: 0, rejected: 0, voided: 0, settled: 0, flagged: 0, ratio: 0 };
    a.requests += 1; a.ratio += r.amountCents / cap;
    const dec = blocks.find((b) => b.type === 'DECISION' && b.data.requestId === r.id)?.data.outcome;
    if (dec === 'BLOCKED') a.blocked += 1;
    if (dec === 'NEEDS_APPROVAL') a.needsOwner += 1;
    if (r.status === 'REJECTED') a.rejected += 1;
    if (r.status === 'VOIDED') a.voided += 1;
    if (r.status === 'SETTLED') a.settled += 1;
    if (flaggedIds.has(r.id)) a.flagged += 1;
    per.set(r.agentId, a);
  }
  return [...per.values()].map((a) => {
    const [lo, hi] = wilson(a.blocked, a.requests);
    const label = a.requests < 5 ? 'insufficient_data' : lo > 0.3 ? 'unreliable' : hi < 0.15 ? 'reliable' : 'watch';
    return { agent: a.agent, requests: a.requests, blocked: a.blocked, needsOwner: a.needsOwner, rejected: a.rejected, voided: a.voided, settled: a.settled, flagged: a.flagged,
      blockRate: a.blocked / a.requests, blockRateInterval95: [+lo.toFixed(4), +hi.toFixed(4)], meanTicketToCap: +(a.ratio / a.requests).toFixed(4), label };
  }).sort((x, y) => y.requests - x.requests);
}

export function analyzeBaseline(blocks, now, { quarantined = false, unresolvedCaptures = 0 } = {}) {
  const s = emptyState(); blocks.filter((b) => b.ts <= now).forEach((b) => applyBlock(s, b));
  const m = s.mandate;
  const scored = scoreRequests(blocks);
  for (const r of scored) { const q = s.requests[r.requestId]; r.outcome = q?.outcome ?? blocks.find((b) => b.type === 'DECISION' && b.data.requestId === r.requestId)?.data.outcome ?? null; r.status = q?.status ?? null; }
  const high = scored.filter((r) => r.level === 'high');
  const recent = scored.slice(-50);
  const flaggedRecent = recent.filter((r) => r.level !== 'low').length;
  const forecast = baselineForecast(m, blocks, now);
  const committed = s.settledCents + s.heldCents + s.reservedCents;
  let distress = { status: 'not_applicable' };
  if (now >= m.expiresAt) distress = { status: 'expired' };
  else if (committed >= EXHAUST * m.budgetCents) distress = { status: 'ok', probability: null, level: 'high', alreadyExhausted: true, contributions: [], algorithm: 'rule' };
  else if (Object.keys(s.requests).length >= 3 && forecast.status === 'ok') {
    const projected = (forecast.horizons.at(-1).p50) / m.budgetCents;
    distress = { status: 'ok', probability: null, level: projected >= 1 ? 'high' : projected >= 0.8 ? 'medium' : 'low', alreadyExhausted: false, projectedUtilAtExpiry: +projected.toFixed(3), contributions: [], algorithm: 'rule' };
  } else distress = { status: 'insufficient_history' };
  const reqs = Object.values(s.requests);
  const blocked = reqs.filter((r) => r.outcome === 'BLOCKED').length;
  const stale = reqs.filter((r) => r.status === 'PENDING_APPROVAL' && now - r.ts > DAY).length;
  const pEx = distress.level === 'high' && distress.status === 'ok' ? 1 : distress.level === 'medium' ? 0.5 : distress.level === 'low' ? 0.1 : null;
  const health = healthScore({ pExhaust: pEx, flaggedShare: recent.length ? flaggedRecent / recent.length : 0, blockRate: reqs.length ? blocked / reqs.length : 0, stalePending: stale, unresolvedCaptures, quarantined });
  if (pEx != null) health.notes.push('Runway used a coarse rule-based level (no probability without the ML service).');
  return {
    engine: 'baseline', asOf: now, committedCents: committed, budgetCents: m.budgetCents, committedMatchesServer: null,
    modelVersions: { risk: 'baseline-rules-1', distress: 'baseline-rules-1', forecast: 'baseline-linear-1' },
    requests: scored.slice(-300), riskSummary: { scored: scored.length, high: high.length, medium: scored.filter((r) => r.level === 'medium').length, maxScore: scored.reduce((x, r) => Math.max(x, r.score), 0), highIds: high.map((r) => r.requestId).slice(0, 50) },
    forecast, distress, behaviour: agentReliability(blocks, new Set(high.map((r) => r.requestId))), health,
  };
}

/** Ghost-balance rule of thumb on a payment timeline (no probabilities). */
export function paymentRules(p, events, now) {
  const types = new Set(events.filter((e) => !e.duplicate).map((e) => e.type));
  const timeout = types.has('CLIENT.TIMEOUT') || types.has('CLIENT.ERROR');
  const confirmed = types.has('PAYMENT.CAPTURE.COMPLETED');
  const silent = now - Math.max(...events.map((e) => e.receivedAt ?? e.ts)) >= 8000;
  const attention = (timeout && !confirmed && silent) || ['RECONCILE', 'UNKNOWN'].includes(p.engineState);
  return { paymentId: p.paymentId, engineState: p.engineState, attentionProbability: null, moneyMovedProbability: null, level: attention ? 'medium' : 'low',
    evidence: attention ? [{ group: 'rule', contribution: null, text: timeout && !confirmed ? 'The app recorded a timeout and PayPal has not confirmed anything yet' : `The reconciler shows ${p.engineState}` }] : [], eventsSeen: events.length };
}
