// Generates SIMULATED payment-event streams and labels them with the real Reconciler.
//   node tools/gen-recon-dataset.mjs [count=2500] [seed=20261031] [out=ml/data/recon_sim.jsonl]
//
// Every stream is invented: random gateway latency, dropped / duplicated / reordered webhooks, client timeouts,
// refunds, disputes. The LABELS are not invented: each stream is replayed through the actual state machine, then
// PayPal is "polled" (the simulator's ground truth), and the final snapshot decides the label. The ML model learns
// to predict that final verdict from a PREFIX of the events, before the poll resolves it.
import fs from 'node:fs';
import path from 'node:path';
import { Reconciler } from '../src/reconciler.js';
import { SimPayPal } from '../src/scenarios.js';
import { T } from '../src/events.js';

const count = Number(process.argv[2] || 2500);
const seed = Number(process.argv[3] || 20261031);
const out = process.argv[4] || 'ml/data/recon_sim.jsonl';

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const CLIENT_TIMEOUT_MS = 8000;

function build(i) {
  const r = mulberry32(seed + i * 7919);
  const U = (a, b) => a + (b - a) * r();
  const norm = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  const logn = (mu, sd) => Math.exp(mu + sd * norm());
  const pid = `ORD-SIM${i.toString(16).toUpperCase().padStart(5, '0')}`;
  const amount = Math.max(500, Math.round(logn(Math.log(8000), 1.0) / 100) * 100);
  const latency = logn(Math.log(2500), 0.9);
  const declined = r() < 0.12;
  const t0 = 0;
  const tAttempt = t0 + U(300, 900);
  const ev = [];
  const push = (type, source, ts, extra = {}, delay = 0) => ev.push({ type, source, ts, amountCents: amount, ...extra, _delay: delay });

  push(T.ORDER_INITIATED, 'app', t0, {}, U(20, 200));
  if (r() < 0.97) push(T.PAYMENT_ATTEMPTED, 'app', tAttempt, {}, U(20, 300));
  const tPP = tAttempt + latency;
  const dropP = latency > CLIENT_TIMEOUT_MS ? 0.25 : 0.1;
  const webhookDelay = () => (r() < 0.2 ? U(2500, 9000) : U(150, 1800));

  let truth = declined ? 'DECLINED' : 'COMPLETED';
  let webhookSeen = false;
  if (!declined) {
    if (r() < 0.1) { push(T.CAPTURE_PENDING, 'paypal_webhook', tPP, { ref: 'P-' + i, eventId: `WH-P${i}` }, webhookDelay()); }
    const tDone = tPP + (ev.some((e) => e.type === T.CAPTURE_PENDING) ? U(1500, 6000) : 0);
    if (r() >= dropP) {
      webhookSeen = true;
      const mismatch = r() < 0.03;
      const amt = mismatch ? Math.round(amount * U(0.85, 0.95) / 100) * 100 : amount;
      const k = r() < 0.15 ? 1 + Math.floor(U(1, 4)) : 1;
      for (let j = 0; j < k; j++) push(T.CAPTURE_COMPLETED, 'paypal_webhook', tDone, { ref: 'C-' + i, amountCents: amt, eventId: j === 0 || r() < 0.5 ? `WH-C${i}` : `WH-C${i}-${j}` }, webhookDelay() + j * U(100, 900));
    }
  } else if (r() >= dropP) {
    webhookSeen = true;
    push(T.CAPTURE_DENIED, 'paypal_webhook', tPP, { ref: 'D-' + i, eventId: `WH-D${i}` }, webhookDelay());
  }
  // client side signals
  if (latency > CLIENT_TIMEOUT_MS && r() < 0.92) push(T.CLIENT_TIMEOUT, 'app', tAttempt + CLIENT_TIMEOUT_MS, { ref: 'client-timeout' }, U(20, 300));
  else if (r() < 0.04) push(T.CLIENT_ERROR, 'app', tAttempt + U(500, 3000), { ref: 'client-error' }, U(20, 300));
  // rarer faults
  if (!declined && r() < 0.03 && webhookSeen) push(T.CAPTURE_DENIED, 'paypal_webhook', tPP - U(200, 900), { ref: 'D2-' + i, eventId: `WH-DX${i}` }, webhookDelay());
  if (!declined && r() < 0.08) {
    const part = Math.round(amount * U(0.1, 0.9) / 100) * 100;
    push(T.CAPTURE_REFUNDED, 'paypal_webhook', tPP + U(3000, 9000), { ref: 'RF1-' + i, amountCents: part, eventId: `WH-R1${i}` }, webhookDelay());
    if (r() < 0.25) push(T.CAPTURE_REFUNDED, 'paypal_webhook', tPP + U(9000, 15000), { ref: 'RF2-' + i, amountCents: Math.max(100, amount - part + 500), eventId: `WH-R2${i}` }, webhookDelay());
  }
  if (!declined && r() < 0.03) {
    push(T.DISPUTE_CREATED, 'paypal_webhook', tPP + U(5000, 20000), { ref: 'PP-D-' + i, eventId: `WH-DC${i}` }, webhookDelay());
    push(r() < 0.5 ? T.DISPUTE_RESOLVED_BUYER : T.DISPUTE_RESOLVED_SELLER, 'paypal_webhook', tPP + U(20000, 40000), { ref: 'PP-DR-' + i, eventId: `WH-DR${i}` }, webhookDelay());
  }
  const refunded = ev.some((e) => e.type === T.CAPTURE_REFUNDED);
  if (refunded && truth === 'COMPLETED') truth = 'COMPLETED';
  return { pid, amount, truth, ev };
}

async function one(i) {
  const { pid, amount, truth, ev } = build(i);
  let clock = 0;
  const sim = new SimPayPal(() => clock);
  const recon = new Reconciler({ oracle: sim.oracle, now: () => clock });
  sim.set(pid, { status: truth === 'DECLINED' ? 'DECLINED' : 'COMPLETED', amountCents: amount, currency: 'USD' });
  const sched = ev.map((e, k) => ({ ...e, arrivalAt: e.ts + e._delay, k })).sort((a, b) => a.arrivalAt - b.arrivalAt || a.k - b.k);
  const states = [];
  for (const e of sched) {
    clock = Math.round(e.arrivalAt);
    const { _delay, arrivalAt, k, ...raw } = e;
    const { snapshot } = recon.ingest({ ...raw, paymentId: pid, ts: Math.round(raw.ts), currency: 'USD' });
    states.push(snapshot.state);
  }
  const pre = recon.get(pid);
  clock += 30_000;
  await recon.verify(pid);
  const fin = recon.get(pid);
  const sev = new Set(fin.anomalies.map((a) => a.severity));
  const attention = Boolean(fin.ghost) || fin.state === 'RECONCILE' || sev.has('critical') || fin.anomalies.some((a) => a.code === 'AMOUNT_MISMATCH');
  const moved = ['SUCCESS', 'VERIFIED', 'PARTIALLY_REFUNDED', 'DISPUTED', 'REFUNDED', 'REVERSED'].includes(fin.state);
  return {
    id: pid,
    events: recon.store.rawFor(pid).filter((x) => x.source !== 'paypal_poll').map((x) => ({ type: x.type, source: x.source, ts: x.ts, amountCents: x.amountCents, duplicate: x.duplicate, arrival: x.arrival, receivedAt: x.receivedAt })),
    states,
    preState: pre.state,
    final: { state: fin.state, ghost: Boolean(fin.ghost), attention, moneyMoved: moved, anomalies: fin.anomalies.map((a) => `${a.code}:${a.severity}`) },
  };
}

fs.mkdirSync(path.dirname(out), { recursive: true });
const lines = [];
for (let i = 0; i < count; i++) lines.push(JSON.stringify(await one(i)));
fs.writeFileSync(out, lines.join('\n') + '\n');
const rows = lines.map((l) => JSON.parse(l));
const pct = (f) => ((rows.filter(f).length / rows.length) * 100).toFixed(1);
console.log(`wrote ${rows.length} simulated payments to ${out} (seed ${seed})`);
console.log(`  needs attention: ${pct((r) => r.final.attention)}%   ghost: ${pct((r) => r.final.ghost)}%   money moved: ${pct((r) => r.final.moneyMoved)}%`);
