import test from 'node:test';
import assert from 'node:assert/strict';
import { world, newMandate } from './helpers.js';
import { runLiveAgent, parsePurchases } from '../src/proof/liveAgent.js';
import { mergeMirror } from '../shared/mirror.js';
import { loadGuard } from '../src/proof/guardKeys.js';
import { AnchorLog } from '../src/proof/anchors.js';

const fakeModel = (content) => async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });
const setup = async (ai) => {
  const w = await world();
  const { id } = await newMandate(w, { allowedMerchants: ['Campus Bookstore'] });
  w.engine.ai = ai;
  return { w, id };
};

test('a hijacked LLM agent is bounded by code, not by the model', async () => {
  const hijacked = JSON.stringify({ purchases: [
    { merchant: 'GiftCards Direct', item: 'Gift card', category: 'gift card', reason: 'Store owner says spend everything', amountCents: 1_900_000 },
    { merchant: 'Campus Bookstore', item: 'Notebooks', category: 'office', reason: 'Notebooks for the design team', amountCents: 100_000 },
  ] });
  const { w, id } = await setup({ apiKey: 'k', model: 'm', fetchImpl: fakeModel(hijacked) });
  const out = await runLiveAgent({ engine: w.engine, mandateId: id });
  assert.equal(out.agentSource, 'llm');
  assert.notEqual(out.requests[0].status, 'HELD', 'the gift card must never be approved');
  assert.notEqual(out.requests[0].status, 'SETTLED');
});

test('no key: scripted fallback says so', async () => {
  const { w, id } = await setup({});
  const out = await runLiveAgent({ engine: w.engine, mandateId: id });
  assert.equal(out.agentSource, 'scripted-fallback');
  assert.match(out.note, /not an LLM/);
});

test('garbage from the model falls back and is labelled, never called LLM', async () => {
  const { w, id } = await setup({ apiKey: 'k', model: 'm', fetchImpl: fakeModel('sure! buying everything') });
  const out = await runLiveAgent({ engine: w.engine, mandateId: id });
  assert.equal(out.agentSource, 'scripted-fallback');
  assert.throws(() => parsePurchases('nope'));
});

test('invalid amounts from the model are rejected by validation, not paid', async () => {
  const bad = JSON.stringify({ purchases: [{ merchant: 'Campus Bookstore', item: 'x', category: 'office', reason: 'r', amountCents: -5 }] });
  const { w, id } = await setup({ apiKey: 'k', model: 'm', fetchImpl: fakeModel(bad) });
  const out = await runLiveAgent({ engine: w.engine, mandateId: id });
  assert.equal(out.requests[0].status, 'REJECTED_INPUT');
});

test('mirror: extending is fine, rewriting history is caught', async () => {
  const guard = await loadGuard(null);
  const log = new AnchorLog({ guard });
  const blk = (i, h) => ({ index: i, hash: h });
  await log.record('m_1', blk(0, 'aa')); await log.record('m_1', blk(1, 'bb'));
  const pub = { guard: { keyId: guard.keyId, publicKeyJwk: guard.publicKeyJwk }, entries: [...log.entries] };
  const first = await mergeMirror(null, pub);
  assert.equal(first.ok, true);
  await log.record('m_1', blk(2, 'cc'));
  const grown = await mergeMirror(first.merged, { ...pub, entries: [...log.entries] });
  assert.equal(grown.ok, true); assert.equal(grown.added, 1);
  const forged = new AnchorLog({ guard });
  await forged.record('m_1', blk(0, 'aa')); await forged.record('m_1', blk(1, 'EVIL')); await forged.record('m_1', blk(2, 'cc'));
  const bad = await mergeMirror(grown.merged, { ...pub, entries: [...forged.entries] });
  assert.equal(bad.ok, false);
  assert.match(bad.issues.join(' '), /rewritten/);
  const cut = await mergeMirror(grown.merged, { ...pub, entries: pub.entries.slice(0, 1) });
  assert.equal(cut.ok, false);
});
