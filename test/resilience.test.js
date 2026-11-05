import test from 'node:test';
import assert from 'node:assert/strict';
import { world } from './helpers.js';
import { AnchorLog } from '../src/proof/anchors.js';
import { makeAuth, signToken, verifyToken } from '../src/security.js';

test('anchors: a failed webhook is retried in order, not dropped', async () => {
  const w = await world();
  let calls = 0; const seen = [];
  const log = new AnchorLog({
    guard: w.guard, webhookUrl: 'http://x/hook',
    fetchImpl: async (u, o) => { calls += 1; if (calls === 1) throw new Error('offline'); seen.push(JSON.parse(o.body).anchor.seq); return { ok: true }; },
  });
  await log.record('m_a', { index: 0, hash: 'a'.repeat(64) });
  await log.record('m_a', { index: 1, hash: 'b'.repeat(64) });
  for (let i = 0; i < 40 && log.published < 2; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(log.published, 2);
  assert.deepEqual(seen, [0, 1]);
  assert.equal(log.outbox.length, 0);
  assert.equal(log.entries.length, 2); // the signed log itself is never affected
});

test('signed tokens: valid, expired, tampered and wrong-secret tokens', () => {
  const now = 1_000_000_000_000;
  const t = signToken('s3cret-s3cret', 'agent', 60, now);
  assert.equal(verifyToken('s3cret-s3cret', t, now + 30_000).role, 'agent');
  assert.equal(verifyToken('s3cret-s3cret', t, now + 61_000), null);
  assert.equal(verifyToken('other-secret', t, now), null);
  const [body, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ role: 'operator', exp: 9e9 })).toString('base64url');
  assert.equal(verifyToken('s3cret-s3cret', `${forged}.${sig}`, now), null);
  assert.equal(verifyToken('s3cret-s3cret', 'garbage', now), null);
  assert.equal(verifyToken('s3cret-s3cret', `${body}.`, now), null);
});

test('auth: a signed agent token can ask but not settle; static tokens still work', () => {
  const auth = makeAuth({ DEMO_MODE: 'false', OPERATOR_TOKEN: 'op-static', AGENT_TOKEN: 'ag-static', TOKEN_SECRET: 'x'.repeat(24) });
  const req = (tok) => ({ headers: { authorization: `Bearer ${tok}` } });
  const agent = signToken('x'.repeat(24), 'agent', 60);
  const operator = signToken('x'.repeat(24), 'operator', 60);
  assert.equal(auth.can(req(agent), 'agent'), true);
  assert.equal(auth.can(req(agent), 'operator'), false);
  assert.equal(auth.can(req(operator), 'operator'), true);
  assert.equal(auth.can(req(signToken('x'.repeat(24), 'agent', -5)), 'agent'), false);
  assert.equal(auth.can(req('op-static'), 'operator'), true);
  assert.equal(auth.can(req('nope'), 'agent'), false);
  const noSecret = makeAuth({ DEMO_MODE: 'false', OPERATOR_TOKEN: 'a', AGENT_TOKEN: 'b' });
  assert.equal(noSecret.can(req(agent), 'agent'), false); // signed tokens are off unless TOKEN_SECRET is set
});