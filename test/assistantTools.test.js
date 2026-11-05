import test from 'node:test';
import assert from 'node:assert/strict';
import { runTool, cardFor } from '../src/assistantTools.js';
import { answerAssistant } from '../src/assistant.js';

const now = Date.parse('2026-11-01T12:00:00Z');
const pay = (o) => ({ paymentId: 'ORD-AAAA1111', state: 'VERIFIED', amountCents: 10000, refundedCents: 0, currency: 'USD', confirmed: true, ghost: false, duplicates: 0, anomalies: [], firstEventTs: now - 3600_000, recommended: { label: 'No action' }, timeline: [], ...o });
const payments = [
  pay({ paymentId: 'ORD-AAAA1111', amountCents: 10000 }),
  pay({ paymentId: 'ORD-BBBB2222', state: 'PARTIALLY_REFUNDED', amountCents: 5050, refundedCents: 1000, firstEventTs: now - 3000_000 }),
  pay({ paymentId: 'ORD-CCCC3333', state: 'SUCCESS', confirmed: false, amountCents: 10000, firstEventTs: now - 3300_000, duplicates: 2 }),
  pay({ paymentId: 'ORD-DDDD4444', state: 'RECONCILE', ghost: true, amountCents: 700, currency: 'INR', firstEventTs: now - 40 * 86_400_000 }),
  pay({ paymentId: 'ORD-EEEE5555', state: 'FAILED', confirmed: false, amountCents: 999 }),
];
const mandates = [{ id: 'm_abcdef0123456789abcdef01', title: 'Office budget', currency: 'USD', budgetCents: 50000, availableCents: 30000, settledCents: 10000, heldCents: 10000, reservedCents: 0, revoked: false, quarantined: false }];
const ctx = { payments, mandates, intel: {}, now };

test('summary uses exact integer cents, per currency, and never mixes currencies', () => {
  const r = runTool('get_payment_summary', { period: 'all' }, ctx);
  const usdNet = r.netReceived.find((m) => m.currency === 'USD');
  assert.equal(usdNet.cents, 10000 + (5050 - 1000) + 10000); // VERIFIED + PARTIALLY_REFUNDED(net) + SUCCESS
  assert.equal(usdNet.display, '$240.50');
  assert.equal(r.refunded.find((m) => m.currency === 'USD').cents, 1000);
  assert.ok(r.netReceived.length === 1 || r.netReceived.every((m) => m.currency !== 'USD' || m.cents === usdNet.cents));
  assert.equal(r.webhookOnlyUnconfirmed.find((m) => m.currency === 'USD').cents, 10000);
  assert.equal(r.confirmedByPayPalApi.find((m) => m.currency === 'USD').cents, 15050);
});

test('period filter excludes older payments', () => {
  const r = runTool('get_payment_summary', { period: '7d' }, ctx);
  assert.equal(r.paymentCount, 4);
  assert.ok(!r.countByState.RECONCILE);
});

test('duplicates, flagged payments and reconciliation are computed from records', () => {
  const d = runTool('find_duplicates', {}, ctx);
  assert.equal(d.duplicateDeliveriesAbsorbed.totalDeliveries, 2);
  assert.equal(d.possibleRepeatCharges.isEstimate, true);
  assert.deepEqual(d.possibleRepeatCharges.groups[0].paymentIds.sort(), ['ORD-AAAA1111', 'ORD-CCCC3333']);
  const f = runTool('find_flagged_payments', {}, ctx);
  assert.deepEqual(f.flagged.map((p) => p.paymentId).sort(), ['ORD-CCCC3333', 'ORD-DDDD4444']);
  const rec = runTool('get_reconciliation_status', {}, ctx);
  assert.equal(rec.awaitingReview, 1);
  assert.equal(rec.ghostBalanceRecoveries, 1);
});

test('mandate budgets report percent used; unavailable data is stated, never invented', () => {
  const b = runTool('get_mandate_budgets', {}, ctx);
  assert.equal(b.mandates[0].percentUsed, 20);
  assert.equal(runTool('get_payment_summary', {}, { payments: [], mandates: [], now }).message, 'Data unavailable — connect an authorised financial data source.');
  assert.equal(runTool('compare_bank_statement', {}, ctx).available, false);
  assert.equal(runTool('get_payment_detail', { paymentId: 'ORD-NOPE0000' }, ctx).available, false);
  assert.equal(runTool('does_not_exist', {}, ctx).available, false);
  assert.equal(runTool('list_payments', { limit: 'x' }, ctx).count, 5);
  assert.ok(cardFor('get_payment_summary', runTool('get_payment_summary', {}, ctx)).rows.length);
});

function scriptedFetch(steps) {
  const seen = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    seen.push(body);
    return { ok: true, json: async () => ({ choices: [{ message: steps.shift() }] }) };
  };
  return { fetchImpl, seen };
}

test('assistant runs the full tool-call loop and the answer is grounded in the tool result', async () => {
  const { fetchImpl, seen } = scriptedFetch([
    { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_reconciliation_status', arguments: '{}' } }] },
    { content: 'Of 5 payments, 1 is awaiting review and 1 ghost-balance recovery was found.' },
  ]);
  const r = await answerAssistant({ question: 'How is my reconciliation going?', payments, mandates, apiKey: 'k', fetchImpl });
  assert.equal(r.source, 'nvidia');
  assert.deepEqual(r.tools, ['get_reconciliation_status']);
  assert.ok(seen[0].tools.length >= 8, 'tool definitions are sent');
  assert.equal(seen[1].messages.at(-1).role, 'tool');
  assert.match(seen[1].messages.at(-1).content, /"awaitingReview":1/);
});

test('a model answer with a number the tools did not produce is replaced by verified figures', async () => {
  const { fetchImpl } = scriptedFetch([
    { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_payment_summary', arguments: '{"period":"all"}' } }] },
    { content: 'You received $987,654.00 in total.' },
  ]);
  const r = await answerAssistant({ question: 'What is my total income?', payments, mandates, apiKey: 'k', fetchImpl });
  assert.equal(r.source, 'deterministic');
  assert.match(r.answer, /verified figures/);
  assert.doesNotMatch(r.answer, /987,654/);
});

test('tools are read-only: nothing is mutated and action requests never reach the model', async () => {
  const before = JSON.stringify(payments);
  runTool('generate_financial_report', {}, ctx);
  assert.equal(JSON.stringify(payments), before);
  let called = false;
  const r = await answerAssistant({ question: 'Refund ORD-AAAA1111 now', payments, mandates, apiKey: 'k', fetchImpl: async () => { called = true; return { ok: false, status: 500 }; } });
  assert.equal(called, false);
  assert.equal(r.screened, true);
});
