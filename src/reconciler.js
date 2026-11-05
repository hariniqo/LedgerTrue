import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { EventStore } from './eventStore.js';
import { Ledger, desiredPositions, ACCT } from './ledger.js';
import { reducePayment, cmp, S } from './stateMachine.js';
import { T } from './events.js';

const NAIVE_STATE = {
  [T.ORDER_INITIATED]: 'INITIATED', [T.PAYMENT_ATTEMPTED]: 'PROCESSING',
  [T.CLIENT_TIMEOUT]: 'FAILED', [T.CLIENT_ERROR]: 'FAILED',
  [T.CAPTURE_PENDING]: 'PENDING', [T.CAPTURE_COMPLETED]: 'SUCCESS', [T.CAPTURE_DENIED]: 'FAILED',
  [T.DISPUTE_CREATED]: 'DISPUTED', [T.DISPUTE_RESOLVED_SELLER]: 'SUCCESS', [T.DISPUTE_RESOLVED_BUYER]: 'REVERSED',
  [T.CAPTURE_REFUNDED]: 'REFUNDED', [T.CAPTURE_REVERSED]: 'REVERSED',
};

/**
 * What a typical integration does: trust every delivery, process in arrival order, last write wins.
 * Kept in the engine so the dashboard can show the drift LedgerTrue removes.
 */
export function naiveView(rawRecords, amountCents) {
  let state = 'INITIATED';
  let balance = 0;
  for (const r of rawRecords) {
    state = NAIVE_STATE[r.type] ?? state;
    const amt = r.amountCents ?? amountCents;
    if (r.type === T.CAPTURE_COMPLETED) balance += amt;
    else if (r.type === T.CAPTURE_REFUNDED || r.type === T.CAPTURE_REVERSED) balance -= amt;
  }
  return { state, balanceCents: balance };
}

export class Reconciler extends EventEmitter {
  constructor({ store = new EventStore(), ledger = new Ledger(), oracle = null, verifyAfterMs = 8000, now = () => Date.now() } = {}) {
    super();
    this.store = store;
    this.ledger = ledger;
    this.oracle = oracle; // async (paymentId) => raw poll event | null
    this.verifyAfterMs = verifyAfterMs;
    this.now = now;
    this.snapshots = new Map();
    this.verifyState = new Map(); // paymentId -> { attempts, lastAt }
  }

  ingest(raw, opts = {}) {
    const record = this.store.append(raw, { now: this.now(), ...opts });
    this.emit('raw', record);
    const { snapshot, entries } = this._refresh(record.paymentId, record);
    this.emit('payment', { snapshot, entries, record });
    return { record, duplicate: record.duplicate, snapshot, entries };
  }

  _refresh(paymentId, cause) {
    const events = this.store.eventsFor(paymentId);
    const raws = this.store.rawFor(paymentId);
    const r = reducePayment(paymentId, events);

    // RECONCILE keeps the ledger at the last known-good state (derived from the events, so it is deterministic).
    const basis = r.state === S.RECONCILE ? r.lastGood : { state: r.state, refunded: r.refundedCents };
    const positions = basis ? desiredPositions({ state: basis.state, amountCents: r.amountCents, refundedCents: basis.refunded }) : {};
    const entries = this.ledger.settle(paymentId, r.currency, positions, {
      reason: `${cause.type} -> ${r.state}`, eventId: cause.eventId, ts: cause.receivedAt,
    });

    const sorted = [...events].sort(cmp);
    let outOfOrder = false;
    for (let i = 0; i < sorted.length - 1; i++) if (sorted[i].arrival > sorted[i + 1].arrival) outOfOrder = true;
    const duplicates = raws.filter((x) => x.duplicate).length;
    const anomalies = [...r.anomalies];
    if (outOfOrder) anomalies.push({ code: 'OUT_OF_ORDER_ARRIVAL', severity: 'info', message: 'Events arrived in a different order than they happened. State was rebuilt by source timestamp.', eventId: null });
    if (duplicates) anomalies.push({ code: 'DUPLICATES_ABSORBED', severity: 'info', message: `${duplicates} duplicate deliver${duplicates === 1 ? 'y' : 'ies'} absorbed by idempotency keys.`, eventId: null });

    const posted = this.ledger.posted.get(paymentId) ?? {};
    const snapshot = {
      ...r,
      anomalies,
      duplicates,
      rawCount: raws.length,
      lastReceivedAt: raws.at(-1)?.receivedAt ?? null,
      naive: naiveView(raws, r.amountCents),
      ledger: {
        available: posted[ACCT.AVAILABLE] ?? 0,
        pending: posted[ACCT.PENDING] ?? 0,
        held: posted[ACCT.HELD] ?? 0,
      },
    };
    this.snapshots.set(paymentId, snapshot);
    return { snapshot, entries };
  }

  get(paymentId) { return this.snapshots.get(paymentId) ?? null; }
  list() { return [...this.snapshots.values()].sort((a, b) => (b.firstEventTs ?? 0) - (a.firstEventTs ?? 0)); }

  async verify(paymentId) {
    if (!this.oracle) throw new Error('no PayPal oracle configured');
    const vs = this.verifyState.get(paymentId) ?? { attempts: 0, lastAt: 0 };
    vs.attempts += 1;
    vs.lastAt = this.now();
    this.verifyState.set(paymentId, vs);
    const raw = await this.oracle(paymentId);
    if (!raw) return null;
    return this.ingest(raw);
  }

  /**
   * Payments stuck in a non-final state are polled against PayPal, so a lost webhook never leaves a ghost.
   * force=true ignores the staleness window (used by tests and the "Verify now" button).
   */
  async sweep({ force = false } = {}) {
    const stuck = new Set([S.INITIATED, S.PROCESSING, S.PENDING, S.UNKNOWN, S.RECONCILE]);
    const now = this.now();
    const out = [];
    for (const p of this.snapshots.values()) {
      if (!stuck.has(p.state)) continue;
      const vs = this.verifyState.get(p.paymentId) ?? { attempts: 0, lastAt: 0 };
      if (vs.attempts >= 3) continue;
      const quietSince = Math.max(p.lastReceivedAt ?? 0, vs.lastAt);
      if (!force && now - quietSince < this.verifyAfterMs) continue;
      try {
        const r = await this.verify(p.paymentId);
        if (r) out.push(r);
      } catch (e) {
        this.emit('error-soft', { paymentId: p.paymentId, error: e.message });
      }
    }
    return out;
  }

  timeline(paymentId) {
    return this.store.rawFor(paymentId).map((r) => ({
      arrival: r.arrival, eventId: r.eventId, type: r.type, source: r.source, ts: r.ts,
      amountCents: r.amountCents, duplicate: r.duplicate, receivedAt: r.receivedAt,
    }));
  }

  /**
   * Demo reset. The log is append-only, so it is archived next to the original (never truncated):
   * an "immutable" audit log that a button can wipe is not an audit log.
   */
  reset() {
    const file = this.store.file;
    if (file && fs.existsSync(file) && fs.statSync(file).size > 0) fs.renameSync(file, `${file}.${Date.now()}.bak`);
    this.store = new EventStore({ file });
    this.ledger.reset();
    this.snapshots.clear();
    this.verifyState.clear();
    this.emit('reset');
  }
}
