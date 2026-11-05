import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Reconciler } from '../src/reconciler.js';
import { SimPayPal, runScenario } from '../src/scenarios.js';
import { T } from '../src/events.js';

const fresh = () => {
  let t = 1_000_000;
  const sim = new SimPayPal(() => t);
  const recon = new Reconciler({ oracle: sim.oracle, verifyAfterMs: 0, now: () => t });
  return { sim, recon, tick: (ms = 1000) => { t += ms; return t; }, clock: () => t };
};

const ev = (paymentId, type, source, ts, extra = {}) => ({ paymentId, type, source, ts, ...extra });

test('ghost balance: client timeout + PayPal capture -> SUCCESS, money booked once, retry blocked', () => {
  const { recon } = fresh();
  recon.ingest(ev('P1', T.ORDER_INITIATED, 'app', 1000, { amountCents: 4999 }));
  recon.ingest(ev('P1', T.PAYMENT_ATTEMPTED, 'app', 1500, { amountCents: 4999 }));
  recon.ingest(ev('P1', T.CLIENT_TIMEOUT, 'app', 3000));
  assert.equal(recon.get('P1').state, 'UNKNOWN');
  assert.equal(recon.ledger.summary().booked, 0);
  recon.ingest(ev('P1', T.CAPTURE_COMPLETED, 'paypal_webhook', 2500, { amountCents: 4999, ref: 'C1' }));
  const p = recon.get('P1');
  assert.equal(p.state, 'SUCCESS');
  assert.equal(p.ghost, true);
  assert.equal(p.naive.state, 'SUCCESS'); // naive got lucky on arrival order here...
  assert.equal(p.recommended.code, 'FULFIL_ORDER_BLOCK_RETRY');
  assert.equal(recon.ledger.summary().available, 4999);
});

test('naive view is wrong when the timeout arrives last', () => {
  const { recon } = fresh();
  recon.ingest(ev('P1', T.ORDER_INITIATED, 'app', 1000, { amountCents: 500 }));
  recon.ingest(ev('P1', T.CAPTURE_COMPLETED, 'paypal_webhook', 2000, { amountCents: 500, ref: 'C' }));
  recon.ingest(ev('P1', T.CLIENT_TIMEOUT, 'app', 1800)); // happened earlier, arrives later
  assert.equal(recon.get('P1').state, 'SUCCESS');
  assert.equal(recon.get('P1').naive.state, 'FAILED');
});

test('idempotency: exact replays and re-id replays credit once', () => {
  const { recon } = fresh();
  recon.ingest(ev('P2', T.ORDER_INITIATED, 'app', 1000, { amountCents: 12000 }));
  const done = { amountCents: 12000, ref: 'C2' };
  recon.ingest(ev('P2', T.CAPTURE_COMPLETED, 'paypal_webhook', 2000, { ...done, eventId: 'WH-1' }));
  const a = recon.ingest(ev('P2', T.CAPTURE_COMPLETED, 'paypal_webhook', 2000, { ...done, eventId: 'WH-1' }));
  const b = recon.ingest(ev('P2', T.CAPTURE_COMPLETED, 'paypal_webhook', 2000, { ...done, eventId: 'WH-2' }));
  assert.equal(a.duplicate, true);
  assert.equal(b.duplicate, true);
  assert.equal(recon.ledger.summary().available, 12000);
  assert.equal(recon.get('P2').duplicates, 2);
  assert.equal(recon.get('P2').rawCount, 4);
});

test('out of order: result equals in-order result', () => {
  const events = [
    ev('P3', T.ORDER_INITIATED, 'app', 0, { amountCents: 25000 }),
    ev('P3', T.PAYMENT_ATTEMPTED, 'app', 600, { amountCents: 25000 }),
    ev('P3', T.CAPTURE_COMPLETED, 'paypal_webhook', 1500, { amountCents: 25000, ref: 'C3', eventId: 'a' }),
    ev('P3', T.CAPTURE_REFUNDED, 'paypal_webhook', 4000, { amountCents: 8000, ref: 'R3', eventId: 'b' }),
  ];
  const run = (order) => { const { recon } = fresh(); order.forEach((i) => recon.ingest(events[i])); return recon; };
  const inOrder = run([0, 1, 2, 3]);
  const shuffled = run([3, 2, 1, 0]);
  assert.equal(shuffled.get('P3').state, 'PARTIALLY_REFUNDED');
  assert.equal(shuffled.get('P3').state, inOrder.get('P3').state);
  assert.deepEqual(shuffled.ledger.summary(), inOrder.ledger.summary());
  assert.equal(shuffled.ledger.summary().available, 17000);
  assert.ok(shuffled.get('P3').anomalies.some((a) => a.code === 'OUT_OF_ORDER_ARRIVAL'));
});

test('conflicting denial then completion -> RECONCILE, ledger frozen, poll resolves it', async () => {
  const { recon, sim } = fresh();
  sim.set('P4', { status: 'COMPLETED', amountCents: 9900 });
  recon.ingest(ev('P4', T.ORDER_INITIATED, 'app', 0, { amountCents: 9900 }));
  recon.ingest(ev('P4', T.CAPTURE_DENIED, 'paypal_webhook', 1800, { amountCents: 9900, ref: 'a', eventId: 'x' }));
  assert.equal(recon.get('P4').state, 'FAILED');
  recon.ingest(ev('P4', T.CAPTURE_COMPLETED, 'paypal_webhook', 3300, { amountCents: 9900, ref: 'b', eventId: 'y' }));
  assert.equal(recon.get('P4').state, 'RECONCILE');
  assert.equal(recon.ledger.summary().booked, 0); // frozen at last good (FAILED -> nothing recognised)
  await recon.sweep({ force: true });
  assert.equal(recon.get('P4').state, 'VERIFIED');
  assert.equal(recon.ledger.summary().available, 9900);
});

test('over-refund -> RECONCILE and ledger stays at last good state', () => {
  const { recon } = fresh();
  recon.ingest(ev('P5', T.ORDER_INITIATED, 'app', 0, { amountCents: 5000 }));
  recon.ingest(ev('P5', T.CAPTURE_COMPLETED, 'paypal_webhook', 1000, { amountCents: 5000, ref: 'c', eventId: 'a' }));
  recon.ingest(ev('P5', T.CAPTURE_REFUNDED, 'paypal_webhook', 2000, { amountCents: 3000, ref: 'r1', eventId: 'b' }));
  assert.equal(recon.get('P5').state, 'PARTIALLY_REFUNDED');
  recon.ingest(ev('P5', T.CAPTURE_REFUNDED, 'paypal_webhook', 3000, { amountCents: 3000, ref: 'r2', eventId: 'c' }));
  const p = recon.get('P5');
  assert.equal(p.state, 'RECONCILE');
  assert.ok(p.anomalies.some((a) => a.code === 'OVER_REFUND'));
  assert.equal(recon.ledger.summary().available, 2000); // 5000 - 3000, second refund NOT applied
  assert.equal(recon.ledger.summary().refunds, 3000);
});

test('full refund and dispute paths post balanced entries', () => {
  const { recon } = fresh();
  recon.ingest(ev('P6', T.ORDER_INITIATED, 'app', 0, { amountCents: 15000 }));
  recon.ingest(ev('P6', T.CAPTURE_COMPLETED, 'paypal_webhook', 1000, { amountCents: 15000, ref: 'c', eventId: 'a' }));
  recon.ingest(ev('P6', T.DISPUTE_CREATED, 'paypal_webhook', 2000, { amountCents: 15000, ref: 'd', eventId: 'b' }));
  let s = recon.ledger.summary();
  assert.equal(recon.get('P6').state, 'DISPUTED');
  assert.equal(s.held, 15000);
  assert.equal(s.available, 0);
  recon.ingest(ev('P6', T.DISPUTE_RESOLVED_BUYER, 'paypal_webhook', 3000, { amountCents: 15000, ref: 'dr', eventId: 'c' }));
  s = recon.ledger.summary();
  assert.equal(recon.get('P6').state, 'REVERSED');
  assert.equal(s.booked, 0);
  assert.equal(s.chargebacks, 15000);
  assert.equal(s.netRevenue, 0);
  assert.equal(s.balanced, true);
});

test('dispute resolved for seller returns funds to available', () => {
  const { recon } = fresh();
  recon.ingest(ev('P7', T.ORDER_INITIATED, 'app', 0, { amountCents: 1000 }));
  recon.ingest(ev('P7', T.CAPTURE_COMPLETED, 'paypal_webhook', 100, { amountCents: 1000, ref: 'c', eventId: 'a' }));
  recon.ingest(ev('P7', T.DISPUTE_CREATED, 'paypal_webhook', 200, { amountCents: 1000, ref: 'd', eventId: 'b' }));
  recon.ingest(ev('P7', T.DISPUTE_RESOLVED_SELLER, 'paypal_webhook', 300, { amountCents: 1000, ref: 'dr', eventId: 'c' }));
  assert.equal(recon.get('P7').state, 'SUCCESS');
  assert.equal(recon.ledger.summary().available, 1000);
  assert.equal(recon.ledger.summary().held, 0);
});

test('amount mismatch: PayPal figure wins and is flagged', () => {
  const { recon } = fresh();
  recon.ingest(ev('P8', T.ORDER_INITIATED, 'app', 0, { amountCents: 5000 }));
  recon.ingest(ev('P8', T.CAPTURE_COMPLETED, 'paypal_webhook', 100, { amountCents: 4500, ref: 'c', eventId: 'a' }));
  assert.equal(recon.get('P8').amountCents, 4500);
  assert.ok(recon.get('P8').anomalies.some((a) => a.code === 'AMOUNT_MISMATCH'));
  assert.equal(recon.ledger.summary().available, 4500);
});

test('lost webhook: sweep polls PayPal and promotes UNKNOWN -> VERIFIED', async () => {
  const { recon, sim } = fresh();
  sim.set('P9', { status: 'COMPLETED', amountCents: 7450 });
  recon.ingest(ev('P9', T.ORDER_INITIATED, 'app', 0, { amountCents: 7450 }));
  recon.ingest(ev('P9', T.PAYMENT_ATTEMPTED, 'app', 500, { amountCents: 7450 }));
  recon.ingest(ev('P9', T.CLIENT_TIMEOUT, 'app', 2000));
  assert.equal(recon.get('P9').state, 'UNKNOWN');
  await recon.sweep({ force: true });
  const p = recon.get('P9');
  assert.equal(p.state, 'VERIFIED');
  assert.equal(p.ghost, true); // timeout + PayPal-confirmed capture is a ghost balance even when found by polling
  assert.equal(recon.ledger.summary().available, 7450);
});

test('PayPal API denial overrides an optimistic webhook', async () => {
  const { recon, sim } = fresh();
  sim.set('P10', { status: 'DECLINED', amountCents: 1000 });
  recon.ingest(ev('P10', T.ORDER_INITIATED, 'app', 0, { amountCents: 1000 }));
  recon.ingest(ev('P10', T.CAPTURE_COMPLETED, 'paypal_webhook', 100, { amountCents: 1000, ref: 'c', eventId: 'a' }));
  assert.equal(recon.get('P10').state, 'SUCCESS');
  await recon.verify('P10');
  assert.equal(recon.get('P10').state, 'FAILED');
  assert.equal(recon.ledger.summary().booked, 0);
});

test('replay determinism: rebuilding from the log gives identical state and ledger', () => {
  const a = fresh().recon;
  const events = [
    ev('P11', T.ORDER_INITIATED, 'app', 0, { amountCents: 2000 }),
    ev('P11', T.CLIENT_TIMEOUT, 'app', 900),
    ev('P11', T.CAPTURE_COMPLETED, 'paypal_webhook', 500, { amountCents: 2000, ref: 'c', eventId: 'a' }),
    ev('P11', T.CAPTURE_REFUNDED, 'paypal_webhook', 1500, { amountCents: 500, ref: 'r', eventId: 'b' }),
  ];
  events.forEach((e) => a.ingest(e));
  const b = fresh().recon;
  [...a.store.raw].sort((x, y) => x.arrival - y.arrival).forEach((r) => b.ingest(r));
  assert.equal(b.get('P11').state, a.get('P11').state);
  assert.deepEqual(b.ledger.summary(), a.ledger.summary());
});

test('every chaos scenario ends with a balanced ledger and no stuck payments', async () => {
  const { recon, sim } = fresh();
  const out = await runScenario('all', recon, sim, { paced: false });
  await recon.sweep({ force: true });
  assert.equal(out.ids.length, 8);
  assert.equal(recon.ledger.invariants().ok, true);
  assert.equal(recon.ledger.summary().balanced, true);
  const states = Object.fromEntries(out.ids.map((id) => [id, recon.get(id).state]));
  const stuck = Object.values(states).filter((s) => ['UNKNOWN', 'PROCESSING', 'INITIATED'].includes(s));
  assert.deepEqual(stuck, []);
  assert.ok(Object.values(states).includes('RECONCILE')); // over-refund must be surfaced
});
