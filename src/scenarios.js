import crypto from 'node:crypto';
import { T } from './events.js';

/** Stand-in for PayPal's side of the world: what *actually* happened, which only an API poll can reveal. */
export class SimPayPal {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.truth = new Map();
  }

  set(paymentId, { status, amountCents, currency = 'USD' }) {
    this.truth.set(paymentId, { status, amountCents, currency });
  }

  oracle = async (paymentId, { afterTs = 0 } = {}) => {
    const t = this.truth.get(paymentId);
    if (!t) return null;
    const type = { COMPLETED: T.CAPTURE_COMPLETED, PENDING: T.CAPTURE_PENDING, DECLINED: T.CAPTURE_DENIED, REFUNDED: T.CAPTURE_REFUNDED }[t.status];
    if (!type) return null;
    return {
      paymentId, type, source: 'paypal_poll', ts: Math.max(this.now(), afterTs + 1),
      amountCents: t.amountCents, currency: t.currency, ref: `poll:${t.status}`,
    };
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pid = () => 'ORD-' + crypto.randomBytes(3).toString('hex').toUpperCase();
const cap = () => 'CAP-' + crypto.randomBytes(3).toString('hex').toUpperCase();
const wh = () => 'WH-' + crypto.randomBytes(4).toString('hex').toUpperCase();

/**
 * A step: { wait, at, type, source, amountCents?, ref?, eventId? }
 *  - `wait` is real time to sleep before delivering (demo pacing; 0 in tests)
 *  - `at` is the event's *own* timestamp offset from scenario start, independent of when it arrives.
 *    Delivering a step with a smaller `at` after one with a larger `at` is how out-of-order delivery is simulated.
 */
const SCENARIOS = {
  ghost_balance: {
    title: 'Ghost Balance',
    blurb: 'Client times out. PayPal actually captured the money. Naive systems show FAILED.',
    build() {
      const id = pid(); const c = cap(); const amt = 4999;
      return { ids: [id], truth: { [id]: { status: 'COMPLETED', amountCents: amt } }, steps: [
        { wait: 0, at: 0, type: T.ORDER_INITIATED, source: 'app', amountCents: amt },
        { wait: 700, at: 700, type: T.PAYMENT_ATTEMPTED, source: 'app', amountCents: amt },
        { wait: 1800, at: 1800, type: T.CAPTURE_COMPLETED, source: 'paypal_webhook', amountCents: amt, ref: c, eventId: wh() },
        // The checkout server reports its timeout late, so a naive "last write wins" integration ends on FAILED.
        { wait: 1200, at: 2500, type: T.CLIENT_TIMEOUT, source: 'app', ref: 'client-timeout' },
      ].map((s) => ({ ...s, paymentId: id })) };
    },
  },
  duplicate_webhooks: {
    title: 'Duplicate webhooks',
    blurb: 'PayPal redelivers the same capture four times. The ledger must credit once.',
    build() {
      const id = pid(); const c = cap(); const amt = 12000; const e1 = wh();
      const done = { type: T.CAPTURE_COMPLETED, source: 'paypal_webhook', amountCents: amt, ref: c, at: 1200 };
      return { ids: [id], truth: { [id]: { status: 'COMPLETED', amountCents: amt } }, steps: [
        { wait: 0, at: 0, type: T.ORDER_INITIATED, source: 'app', amountCents: amt },
        { wait: 500, at: 500, type: T.PAYMENT_ATTEMPTED, source: 'app', amountCents: amt },
        { wait: 700, ...done, eventId: e1 },
        { wait: 600, ...done, eventId: e1 }, // exact replay
        { wait: 600, ...done, eventId: wh() }, // replay under a fresh delivery id
        { wait: 600, ...done, eventId: wh() },
      ].map((s) => ({ ...s, paymentId: id })) };
    },
  },
  out_of_order: {
    title: 'Out-of-order delivery',
    blurb: 'Refund arrives before the capture, and the order creation arrives last.',
    build() {
      const id = pid(); const c = cap(); const amt = 25000;
      return { ids: [id], truth: { [id]: { status: 'COMPLETED', amountCents: amt } }, steps: [
        { wait: 0, at: 4000, type: T.CAPTURE_REFUNDED, source: 'paypal_webhook', amountCents: 8000, ref: 'RF-' + c, eventId: wh() },
        { wait: 900, at: 1500, type: T.CAPTURE_COMPLETED, source: 'paypal_webhook', amountCents: amt, ref: c, eventId: wh() },
        { wait: 900, at: 600, type: T.PAYMENT_ATTEMPTED, source: 'app', amountCents: amt },
        { wait: 900, at: 0, type: T.ORDER_INITIATED, source: 'app', amountCents: amt },
      ].map((s) => ({ ...s, paymentId: id })) };
    },
  },
  lost_webhook: {
    title: 'Lost webhook',
    blurb: 'No webhook ever arrives. LedgerTrue notices the silence and asks PayPal itself.',
    build() {
      const id = pid(); const amt = 7450;
      return { ids: [id], truth: { [id]: { status: 'COMPLETED', amountCents: amt } }, steps: [
        { wait: 0, at: 0, type: T.ORDER_INITIATED, source: 'app', amountCents: amt },
        { wait: 600, at: 600, type: T.PAYMENT_ATTEMPTED, source: 'app', amountCents: amt },
        { wait: 1500, at: 2100, type: T.CLIENT_TIMEOUT, source: 'app', ref: 'client-timeout' },
      ].map((s) => ({ ...s, paymentId: id })) };
    },
  },
  conflicting_signals: {
    title: 'Conflicting signals',
    blurb: 'A denial webhook, then a completion for the same payment. The engine refuses to guess.',
    build() {
      const id = pid(); const c = cap(); const amt = 9900;
      return { ids: [id], truth: { [id]: { status: 'COMPLETED', amountCents: amt } }, steps: [
        { wait: 0, at: 0, type: T.ORDER_INITIATED, source: 'app', amountCents: amt },
        { wait: 600, at: 600, type: T.PAYMENT_ATTEMPTED, source: 'app', amountCents: amt },
        { wait: 1200, at: 1800, type: T.CAPTURE_DENIED, source: 'paypal_webhook', amountCents: amt, ref: c + '-a', eventId: wh() },
        { wait: 1500, at: 3300, type: T.CAPTURE_COMPLETED, source: 'paypal_webhook', amountCents: amt, ref: c, eventId: wh() },
      ].map((s) => ({ ...s, paymentId: id })) };
    },
  },
  dispute_lifecycle: {
    title: 'Dispute and chargeback',
    blurb: 'Funds move from available to held, then the buyer wins and the money is reversed.',
    build() {
      const id = pid(); const c = cap(); const amt = 15000;
      return { ids: [id], truth: { [id]: { status: 'COMPLETED', amountCents: amt } }, steps: [
        { wait: 0, at: 0, type: T.ORDER_INITIATED, source: 'app', amountCents: amt },
        { wait: 500, at: 500, type: T.PAYMENT_ATTEMPTED, source: 'app', amountCents: amt },
        { wait: 700, at: 1200, type: T.CAPTURE_COMPLETED, source: 'paypal_webhook', amountCents: amt, ref: c, eventId: wh() },
        { wait: 1800, at: 3000, type: T.DISPUTE_CREATED, source: 'paypal_webhook', amountCents: amt, ref: 'PP-D-' + c, eventId: wh() },
        { wait: 2200, at: 5200, type: T.DISPUTE_RESOLVED_BUYER, source: 'paypal_webhook', amountCents: amt, ref: 'PP-D-R-' + c, eventId: wh() },
      ].map((s) => ({ ...s, paymentId: id })) };
    },
  },
  refund_overflow: {
    title: 'Over-refund',
    blurb: 'Two refunds add up to more than was captured. Ledger freezes for manual review.',
    build() {
      const id = pid(); const c = cap(); const amt = 5000;
      return { ids: [id], truth: {}, steps: [
        { wait: 0, at: 0, type: T.ORDER_INITIATED, source: 'app', amountCents: amt },
        { wait: 500, at: 500, type: T.PAYMENT_ATTEMPTED, source: 'app', amountCents: amt },
        { wait: 700, at: 1200, type: T.CAPTURE_COMPLETED, source: 'paypal_webhook', amountCents: amt, ref: c, eventId: wh() },
        { wait: 1200, at: 2500, type: T.CAPTURE_REFUNDED, source: 'paypal_webhook', amountCents: 3000, ref: 'RF1-' + c, eventId: wh() },
        { wait: 1200, at: 3800, type: T.CAPTURE_REFUNDED, source: 'paypal_webhook', amountCents: 3000, ref: 'RF2-' + c, eventId: wh() },
      ].map((s) => ({ ...s, paymentId: id })) };
    },
  },
  amount_mismatch: {
    title: 'Amount mismatch',
    blurb: 'App expected $50.00, PayPal captured $45.00. PayPal wins and the gap is flagged.',
    build() {
      const id = pid(); const c = cap();
      return { ids: [id], truth: { [id]: { status: 'COMPLETED', amountCents: 4500 } }, steps: [
        { wait: 0, at: 0, type: T.ORDER_INITIATED, source: 'app', amountCents: 5000 },
        { wait: 500, at: 500, type: T.PAYMENT_ATTEMPTED, source: 'app', amountCents: 5000 },
        { wait: 900, at: 1400, type: T.CAPTURE_COMPLETED, source: 'paypal_webhook', amountCents: 4500, ref: c, eventId: wh() },
      ].map((s) => ({ ...s, paymentId: id })) };
    },
  },
};

export const SCENARIO_LIST = Object.entries(SCENARIOS).map(([key, v]) => ({ key, title: v.title, blurb: v.blurb }));

export async function runScenario(name, recon, sim, { paced = true, base = recon.now() } = {}) {
  if (name === 'all') {
    const results = await Promise.all(Object.keys(SCENARIOS).map((n, i) => (async () => {
      if (paced) await sleep(i * 350);
      return runScenario(n, recon, sim, { paced, base: recon.now() });
    })()));
    return { ids: results.flatMap((r) => r.ids) };
  }
  const sc = SCENARIOS[name];
  if (!sc) throw new Error(`unknown scenario: ${name}`);
  const built = sc.build();
  for (const [id, truth] of Object.entries(built.truth)) sim?.set(id, truth);
  for (const step of built.steps) {
    if (paced && step.wait) await sleep(step.wait);
    const { wait, at, ...ev } = step;
    recon.ingest({ ...ev, ts: base + at });
  }
  return { ids: built.ids };
}
