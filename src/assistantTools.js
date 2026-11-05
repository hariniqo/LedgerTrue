import { fmt } from './money.js';

/**
 * Deterministic, read-only financial tools for the assistant.
 * The model may ASK for a tool; only this code does the arithmetic. All money is integer minor units, grouped per
 * currency (never mixed), and every figure the model may quote is present in the result as cents AND as display text.
 * Nothing here can approve, capture, refund, transfer, revoke or change a record.
 */

const UNAVAILABLE = 'Data unavailable — connect an authorised financial data source.';
const FUNDED = new Set(['SUCCESS', 'VERIFIED', 'PARTIALLY_REFUNDED']);
const CAPTURED = new Set(['SUCCESS', 'VERIFIED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'REVERSED', 'DISPUTED']);
const PERIODS = ['all', 'today', '7d', '30d', 'this_month'];
const DAY = 86_400_000;

const money = (cents, currency) => ({ cents, display: fmt(cents, currency), currency });

function periodFilter(period, now) {
  const p = PERIODS.includes(period) ? period : 'all';
  if (p === 'all') return { period: p, test: () => true };
  const d = new Date(now);
  const start = p === 'today' ? new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    : p === 'this_month' ? new Date(d.getFullYear(), d.getMonth(), 1).getTime()
      : now - (p === '7d' ? 7 : 30) * DAY;
  return { period: p, test: (x) => (x.firstEventTs ?? 0) >= start };
}

function byCurrency(payments, pick) {
  const out = new Map();
  for (const p of payments) {
    const cur = p.currency ?? 'USD';
    out.set(cur, (out.get(cur) ?? 0) + pick(p));
  }
  return [...out].map(([cur, cents]) => money(cents, cur));
}

const brief = (p) => ({
  paymentId: p.paymentId, state: p.state, amount: money(p.amountCents ?? 0, p.currency ?? 'USD'),
  confirmedByPayPalApi: Boolean(p.confirmed), ghostBalanceRecovery: Boolean(p.ghost), duplicatesAbsorbed: p.duplicates ?? 0,
  recommendedAction: p.recommended?.label ?? null,
});

const flagReasons = (p) => {
  const r = [];
  if (p.ghost) r.push('ghost-balance recovery');
  if (p.state === 'RECONCILE') r.push('conflicting signals, needs review');
  if (p.state === 'DISPUTED') r.push('open dispute');
  if (p.state === 'SUCCESS' && !p.confirmed) r.push('webhook-only success, not confirmed by PayPal API');
  for (const a of p.anomalies ?? []) if (a.severity !== 'info' && a.code !== 'GHOST_BALANCE') r.push(a.message);
  return [...new Set(r)];
};

export const TOOL_DEFINITIONS = [
  { name: 'get_payment_summary', description: 'Totals of payments in a period, per currency: captured, refunded, net received, pending, failed, disputed, and how much is confirmed by the PayPal API.', parameters: { type: 'object', properties: { period: { type: 'string', enum: PERIODS } }, additionalProperties: false } },
  { name: 'list_payments', description: 'Most recent payments, optionally filtered by state.', parameters: { type: 'object', properties: { state: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, additionalProperties: false } },
  { name: 'get_payment_detail', description: 'Full reconciled record for one payment ID (ORD-/CAP-/AUTH- style ID).', parameters: { type: 'object', properties: { paymentId: { type: 'string' } }, required: ['paymentId'], additionalProperties: false } },
  { name: 'find_duplicates', description: 'Payments where duplicate deliveries were absorbed, and possible repeat charges (same amount and currency within 10 minutes). Repeat charges are heuristic estimates.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'find_flagged_payments', description: 'Payments that need attention: ghost balances, reconcile conflicts, disputes, unconfirmed webhook-only successes, warning anomalies.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'get_reconciliation_status', description: 'How many payments are confirmed, awaiting review, recovered after a timeout, or only webhook-reported.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'get_mandate_budgets', description: 'Every mandate with budget, settled, held, available and percent of budget used.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'generate_financial_report', description: 'One combined report: payment summary, flagged payments, reconciliation status and mandate budgets.', parameters: { type: 'object', properties: { period: { type: 'string', enum: PERIODS } }, additionalProperties: false } },
  { name: 'compare_bank_statement', description: 'Compare bank statement records with PayPal settlements.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
];

export function runTool(name, args, { payments = [], mandates = [], intel = {}, now = Date.now() } = {}) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  switch (name) {
    case 'get_payment_summary': {
      const { period, test } = periodFilter(a.period, now);
      const ps = payments.filter(test);
      if (!ps.length) return { period, available: false, message: payments.length ? `No payments in period "${period}".` : UNAVAILABLE };
      const funded = ps.filter((p) => CAPTURED.has(p.state));
      const states = {};
      for (const p of ps) states[p.state] = (states[p.state] ?? 0) + 1;
      return {
        period, available: true, paymentCount: ps.length, countByState: states,
        definitions: 'captured = amount of payments that were captured; netReceived = captured minus refunds; confirmedByPayPalApi counts only payments the PayPal API confirmed, webhook-only successes are separate.',
        captured: byCurrency(funded, (p) => p.amountCents ?? 0),
        refunded: byCurrency(ps, (p) => p.refundedCents ?? 0),
        netReceived: byCurrency(ps.filter((p) => FUNDED.has(p.state) || p.state === 'REFUNDED'), (p) => (p.amountCents ?? 0) - (p.refundedCents ?? 0)),
        confirmedByPayPalApi: byCurrency(ps.filter((p) => p.confirmed && FUNDED.has(p.state)), (p) => p.amountCents ?? 0),
        webhookOnlyUnconfirmed: byCurrency(ps.filter((p) => p.state === 'SUCCESS' && !p.confirmed), (p) => p.amountCents ?? 0),
        pending: byCurrency(ps.filter((p) => ['INITIATED', 'PROCESSING', 'PENDING', 'UNKNOWN'].includes(p.state)), (p) => p.amountCents ?? 0),
        failed: byCurrency(ps.filter((p) => p.state === 'FAILED'), (p) => p.amountCents ?? 0),
        disputed: byCurrency(ps.filter((p) => p.state === 'DISPUTED'), (p) => p.amountCents ?? 0),
      };
    }
    case 'list_payments': {
      const limit = Math.min(Math.max(Number.isInteger(a.limit) ? a.limit : 5, 1), 10);
      const state = typeof a.state === 'string' ? a.state.toUpperCase() : null;
      const ps = payments.filter((p) => !state || p.state === state).slice(0, limit);
      return ps.length ? { available: true, count: ps.length, payments: ps.map(brief) } : { available: false, message: payments.length ? 'No payments match.' : UNAVAILABLE };
    }
    case 'get_payment_detail': {
      const id = String(a.paymentId ?? '').trim().toLowerCase();
      const p = payments.find((x) => x.paymentId.toLowerCase() === id);
      if (!p) return { available: false, message: `No LedgerTrue record with ID ${String(a.paymentId ?? '').slice(0, 40)}.` };
      return { available: true, ...brief(p), refunded: money(p.refundedCents ?? 0, p.currency ?? 'USD'), flags: flagReasons(p), anomalies: (p.anomalies ?? []).filter((x) => x.severity !== 'info').map((x) => x.message), transitions: (p.timeline ?? []).length };
    }
    case 'find_duplicates': {
      const absorbed = payments.filter((p) => (p.duplicates ?? 0) > 0);
      const sorted = [...payments].filter((p) => p.amountCents).sort((x, y) => (x.firstEventTs ?? 0) - (y.firstEventTs ?? 0));
      const groups = [];
      for (let i = 0; i < sorted.length; i++) {
        const g = [sorted[i]];
        for (let j = i + 1; j < sorted.length && (sorted[j].firstEventTs ?? 0) - (sorted[i].firstEventTs ?? 0) <= 600_000; j++) {
          if (sorted[j].amountCents === sorted[i].amountCents && sorted[j].currency === sorted[i].currency) g.push(sorted[j]);
        }
        if (g.length > 1 && !groups.some((x) => x.some((p) => g.includes(p)))) groups.push(g);
      }
      if (!payments.length) return { available: false, message: UNAVAILABLE };
      return {
        available: true,
        duplicateDeliveriesAbsorbed: { paymentCount: absorbed.length, totalDeliveries: absorbed.reduce((n, p) => n + p.duplicates, 0), payments: absorbed.slice(0, 10).map((p) => ({ paymentId: p.paymentId, duplicates: p.duplicates })) },
        possibleRepeatCharges: { isEstimate: true, groupCount: groups.length, groups: groups.slice(0, 5).map((g) => ({ amount: money(g[0].amountCents, g[0].currency ?? 'USD'), paymentIds: g.map((p) => p.paymentId) })) },
      };
    }
    case 'find_flagged_payments': {
      if (!payments.length) return { available: false, message: UNAVAILABLE };
      const flagged = payments.map((p) => ({ p, reasons: flagReasons(p) })).filter((x) => x.reasons.length);
      return { available: true, flaggedCount: flagged.length, totalPayments: payments.length, flagged: flagged.slice(0, 10).map(({ p, reasons }) => ({ ...brief(p), reasons })), note: 'Rule-based flags from reconciliation, not a fraud verdict.' };
    }
    case 'get_reconciliation_status': {
      if (!payments.length) return { available: false, message: UNAVAILABLE };
      const n = (f) => payments.filter(f).length;
      return {
        available: true, totalPayments: payments.length,
        confirmedByPayPalApi: n((p) => p.confirmed), awaitingReview: n((p) => p.state === 'RECONCILE'),
        ghostBalanceRecoveries: n((p) => p.ghost), webhookOnlyUnconfirmed: n((p) => p.state === 'SUCCESS' && !p.confirmed),
        disputed: n((p) => p.state === 'DISPUTED'), pendingOrUnknown: n((p) => ['INITIATED', 'PROCESSING', 'PENDING', 'UNKNOWN'].includes(p.state)),
      };
    }
    case 'get_mandate_budgets': {
      if (!mandates.length) return { available: false, message: 'No mandates exist yet.' };
      return {
        available: true, mandateCount: mandates.length,
        mandates: mandates.slice(0, 20).map((m) => {
          const cur = m.currency ?? 'USD';
          const est = intel[m.id]?.detail;
          return {
            id: m.id, title: m.title, status: m.revoked ? 'revoked' : 'active', quarantined: Boolean(m.quarantined),
            budget: money(m.budgetCents, cur), settled: money(m.settledCents, cur), held: money(m.heldCents, cur), available: money(m.availableCents, cur),
            percentUsed: m.budgetCents > 0 ? Math.round((m.settledCents * 100) / m.budgetCents) : 0,
            ...(est ? { estimate: { isEstimate: true, healthScore: est.health?.score ?? null, flaggedHighRiskRequests: est.riskSummary?.high ?? 0 } } : {}),
          };
        }),
      };
    }
    case 'generate_financial_report': {
      const ctx = { payments, mandates, intel, now };
      return {
        available: payments.length > 0 || mandates.length > 0,
        summary: runTool('get_payment_summary', { period: a.period }, ctx),
        flagged: runTool('find_flagged_payments', {}, ctx),
        reconciliation: runTool('get_reconciliation_status', {}, ctx),
        mandates: runTool('get_mandate_budgets', {}, ctx),
      };
    }
    case 'compare_bank_statement':
      return { available: false, message: UNAVAILABLE };
    default:
      return { available: false, message: `Unknown tool ${String(name).slice(0, 40)}.` };
  }
}

/** Small structured card for the UI. Built from the same tool results the model saw; never from model text. */
export function cardFor(name, result) {
  if (!result?.available) return null;
  if (name === 'get_payment_summary') return { type: 'summary', title: `Payments · ${result.period}`, rows: [['Payments', String(result.paymentCount)], ...result.netReceived.map((m) => ['Net received', m.display]), ...result.refunded.filter((m) => m.cents).map((m) => ['Refunded', m.display])] };
  if (name === 'find_flagged_payments') return { type: 'flagged', title: `${result.flaggedCount} of ${result.totalPayments} payments flagged`, rows: result.flagged.slice(0, 5).map((p) => [p.paymentId, p.reasons[0]]) };
  if (name === 'get_mandate_budgets') return { type: 'budgets', title: 'Mandate budgets', rows: result.mandates.slice(0, 5).map((m) => [m.title, `${m.available.display} left · ${m.percentUsed}% used`]) };
  if (name === 'get_reconciliation_status') return { type: 'summary', title: 'Reconciliation', rows: [['Confirmed by PayPal API', String(result.confirmedByPayPalApi)], ['Awaiting review', String(result.awaitingReview)], ['Ghost recoveries', String(result.ghostBalanceRecoveries)]] };
  return null;
}
