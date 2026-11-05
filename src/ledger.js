// Double-entry ledger. Entries are never edited: when a payment's reconciled state changes,
// we post the balanced *difference* between where its money should be and where we last put it.
// That makes replays, late events and corrections idempotent by construction.

export const ACCT = Object.freeze({
  PENDING: 'PAYPAL_PENDING', // PayPal has it, not yet spendable
  AVAILABLE: 'PAYPAL_AVAILABLE', // spendable
  HELD: 'PAYPAL_HELD', // frozen by a dispute
  REVENUE: 'REVENUE', // credit-normal
  REFUNDS: 'REFUNDS', // contra-revenue
  CHARGEBACKS: 'CHARGEBACKS', // contra-revenue
});

// Signed positions (debit positive, credit negative). Each vector sums to zero.
export function desiredPositions({ state, amountCents: amt, refundedCents: ref = 0 }) {
  const p = {};
  const put = (k, v) => { if (v) p[k] = (p[k] || 0) + v; };
  switch (state) {
    case 'PENDING': put(ACCT.PENDING, amt); put(ACCT.REVENUE, -amt); break;
    case 'SUCCESS':
    case 'VERIFIED': put(ACCT.AVAILABLE, amt); put(ACCT.REVENUE, -amt); break;
    case 'PARTIALLY_REFUNDED': put(ACCT.AVAILABLE, amt - ref); put(ACCT.REFUNDS, ref); put(ACCT.REVENUE, -amt); break;
    case 'DISPUTED': put(ACCT.HELD, amt - ref); put(ACCT.REFUNDS, ref); put(ACCT.REVENUE, -amt); break;
    case 'REFUNDED': put(ACCT.REFUNDS, amt); put(ACCT.REVENUE, -amt); break;
    case 'REVERSED': put(ACCT.REFUNDS, ref); put(ACCT.CHARGEBACKS, amt - ref); put(ACCT.REVENUE, -amt); break;
    default: break; // INITIATED / PROCESSING / UNKNOWN / FAILED: no money recognised
  }
  return p;
}

export class Ledger {
  constructor() { this.reset(); }

  reset() {
    this.entries = [];
    this.posted = new Map(); // paymentId -> { account: signedCents }
    this.balances = new Map(); // `${currency}|${account}` -> signedCents
    this.nextId = 1;
  }

  settle(paymentId, currency, positions, cause = {}) {
    const prev = this.posted.get(paymentId) ?? {};
    const keys = new Set([...Object.keys(prev), ...Object.keys(positions)]);
    const debits = [];
    const credits = [];
    for (const k of keys) {
      const d = (positions[k] || 0) - (prev[k] || 0);
      if (d > 0) debits.push([k, d]);
      else if (d < 0) credits.push([k, -d]);
    }

    const made = [];
    let i = 0;
    let j = 0;
    while (i < debits.length && j < credits.length) {
      const amount = Math.min(debits[i][1], credits[j][1]);
      const entry = {
        id: this.nextId++, paymentId, currency, debit: debits[i][0], credit: credits[j][0], amountCents: amount,
        reason: cause.reason ?? 'state change', eventId: cause.eventId ?? null, ts: cause.ts ?? Date.now(),
      };
      this.entries.push(entry);
      made.push(entry);
      this._bump(currency, entry.debit, amount);
      this._bump(currency, entry.credit, -amount);
      debits[i][1] -= amount;
      credits[j][1] -= amount;
      if (debits[i][1] === 0) i++;
      if (credits[j][1] === 0) j++;
    }
    this.posted.set(paymentId, { ...positions });
    return made;
  }

  _bump(currency, account, delta) {
    const k = `${currency}|${account}`;
    this.balances.set(k, (this.balances.get(k) ?? 0) + delta);
  }

  bal(currency, account) { return this.balances.get(`${currency}|${account}`) ?? 0; }

  currencies() { return [...new Set([...this.balances.keys()].map((k) => k.split('|')[0]))]; }

  summary(currency = 'USD') {
    const pending = this.bal(currency, ACCT.PENDING);
    const available = this.bal(currency, ACCT.AVAILABLE);
    const held = this.bal(currency, ACCT.HELD);
    const refunds = this.bal(currency, ACCT.REFUNDS);
    const chargebacks = this.bal(currency, ACCT.CHARGEBACKS);
    const revenue = -this.bal(currency, ACCT.REVENUE);
    let trial = 0;
    for (const [k, v] of this.balances) if (k.startsWith(`${currency}|`)) trial += v;
    return {
      currency, pending, available, held,
      booked: pending + available + held, // everything PayPal owes us
      grossRevenue: revenue, refunds, chargebacks, netRevenue: revenue - refunds - chargebacks,
      trialBalance: trial, balanced: trial === 0,
    };
  }

  summaries() {
    const cs = this.currencies();
    return Object.fromEntries((cs.length ? cs : ['USD']).map((c) => [c, this.summary(c)]));
  }

  invariants() {
    const errors = [];
    for (const c of this.currencies()) if (this.summary(c).trialBalance !== 0) errors.push(`trial balance != 0 for ${c}`);
    for (const e of this.entries) if (!Number.isInteger(e.amountCents) || e.amountCents <= 0) errors.push(`bad entry ${e.id}`);
    return { ok: errors.length === 0, errors };
  }
}
