import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapWebhook, mapOrder } from '../src/paypal.js';
import { explain } from '../src/explainer.js';
import { Reconciler } from '../src/reconciler.js';
import { createApp } from '../src/server.js';

test('mapWebhook: capture completed uses order id from supplementary data', () => {
  const idx = new Map();
  const m = mapWebhook({
    id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', create_time: '2026-10-30T10:00:00Z',
    resource: { id: 'CAP1', amount: { value: '49.99', currency_code: 'USD' }, supplementary_data: { related_ids: { order_id: 'ORD1' } } },
  }, idx);
  assert.equal(m.paymentId, 'ORD1');
  assert.equal(m.amountCents, 4999);
  assert.equal(m.type, 'PAYMENT.CAPTURE.COMPLETED');
  assert.equal(idx.get('CAP1'), 'ORD1');
});

test('mapWebhook: refund resolves its capture via the index', () => {
  const idx = new Map([['CAP1', 'ORD1']]);
  const m = mapWebhook({
    id: 'WH-2', event_type: 'PAYMENT.CAPTURE.REFUNDED', create_time: '2026-10-30T10:05:00Z',
    resource: { id: 'REF1', amount: { value: '10.00', currency_code: 'USD' }, links: [{ rel: 'up', href: 'https://api.paypal.com/v2/payments/captures/CAP1' }] },
  }, idx);
  assert.equal(m.paymentId, 'ORD1');
  assert.equal(m.amountCents, 1000);
});

test('mapWebhook: unknown event types are ignored', () => {
  assert.equal(mapWebhook({ id: 'x', event_type: 'BILLING.PLAN.CREATED', resource: {} }), null);
});

test('mapOrder: completed capture becomes an authoritative poll event', () => {
  const e = mapOrder({ purchase_units: [{ payments: { captures: [{ id: 'C', status: 'COMPLETED', amount: { value: '12.50', currency_code: 'USD' } }] } }] }, 'ORD9', 1);
  assert.equal(e.source, 'paypal_poll');
  assert.equal(e.amountCents, 1250);
  assert.equal(mapOrder({ purchase_units: [{}] }, 'ORD9'), null);
});

test('explainer falls back deterministically without an API key', async () => {
  const r = new Reconciler();
  r.ingest({ paymentId: 'P', type: 'ORDER.INITIATED', source: 'app', ts: 1, amountCents: 1000 });
  r.ingest({ paymentId: 'P', type: 'PAYMENT.CAPTURE.COMPLETED', source: 'paypal_webhook', ts: 5, amountCents: 1000, ref: 'c' });
  const out = await explain(r.get('P'), r.timeline('P'), {});
  assert.equal(out.source, 'fallback');
  assert.match(out.note, /SUCCESS/);
});

test('explainer survives an API failure', async () => {
  const r = new Reconciler();
  r.ingest({ paymentId: 'P', type: 'ORDER.INITIATED', source: 'app', ts: 1, amountCents: 1000 });
  const out = await explain(r.get('P'), r.timeline('P'), { apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal(out.source, 'fallback');
  assert.match(out.error, /500/);
});

test('explainer returns an NVIDIA NIM note', async () => {
  const r = new Reconciler();
  r.ingest({ paymentId: 'P', type: 'ORDER.INITIATED', source: 'app', ts: 1, amountCents: 1000 });
  const out = await explain(r.get('P'), r.timeline('P'), {
    apiKey: 'k',
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'Test note.' } }] }) }),
  });
  assert.equal(out.source, 'nvidia');
  assert.equal(out.note, 'Test note.');
});

test('HTTP: app events + PayPal webhook + duplicate over the wire', async () => {
  const { server } = await createApp({ DEMO_MODE: 'true', PERSIST_FILE: '' });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

  assert.equal((await post('/api/events', { paymentId: 'H1', type: 'ORDER.INITIATED', amountCents: 2500 })).status, 202);
  const hook = { id: 'WH-9', event_type: 'PAYMENT.CAPTURE.COMPLETED', create_time: new Date().toISOString(), resource: { id: 'C9', amount: { value: '25.00', currency_code: 'USD' }, supplementary_data: { related_ids: { order_id: 'H1' } } } };
  const first = await post('/api/webhooks/paypal', hook);
  const again = await post('/api/webhooks/paypal', hook);
  assert.equal(first.body.state, 'SUCCESS');
  assert.equal(again.body.duplicate, true);

  const state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.stats.ledger.USD.available, 2500);
  assert.equal(state.stats.invariants.ok, true);

  const bad = await post('/api/events', { paymentId: 'H2', type: 'NOPE' });
  assert.equal(bad.status, 400);

  const ex = await post('/api/payments/H1/explain', {});
  assert.equal(ex.body.source, 'fallback');

  server.close();
});
