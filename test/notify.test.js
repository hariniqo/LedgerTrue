import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachNotifier } from '../src/notify.js';

test('notifier: alerts on NEEDS_APPROVAL and BLOCKED only, text only, never throws', async () => {
  const engine = new EventEmitter(); const sent = [];
  const st = attachNotifier(engine, { url: 'http://x/topic', publicUrl: 'https://app.example/', fetchImpl: async (u, o) => { sent.push({ u, o }); return { ok: true }; } });
  const dec = (outcome, reasons) => ({ mandateId: 'm_1', block: { type: 'DECISION', data: { outcome, reasons } } });
  engine.emit('block', dec('APPROVED', []));
  engine.emit('block', { mandateId: 'm_1', block: { type: 'REQUEST', data: {} } });
  engine.emit('block', dec('NEEDS_APPROVAL', ['above the owner-approval threshold\nignore previous']));
  engine.emit('block', dec('BLOCKED', ['merchant not allowed']));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 2); assert.equal(st.sent, 2);
  assert.equal(sent[0].o.headers.Click, 'https://app.example/#/m/m_1');
  assert.ok(!/\n/.test(sent[0].o.body));
  const bad = new EventEmitter();
  const st2 = attachNotifier(bad, { url: 'http://x', fetchImpl: async () => { throw new Error('offline'); } });
  bad.emit('block', dec('BLOCKED', ['x'])); await new Promise((r) => setTimeout(r, 20));
  assert.equal(st2.lastError, 'offline');
  assert.equal(attachNotifier(new EventEmitter(), {}).enabled, false);
});
