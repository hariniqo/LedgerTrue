import test from 'node:test';
import assert from 'node:assert/strict';
import { goalCheck } from '../src/proof/goalCheck.js';
import { explainChain } from '../src/proof/chainExplainer.js';
import { chatEndpoint } from '../src/nvidia.js';

const ok = (content) => async (url, init) => { ok.calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) }; };

test('chatEndpoint accepts any https base and defaults to NVIDIA', () => {
  assert.equal(chatEndpoint('https://api.groq.com/openai/v1'), 'https://api.groq.com/openai/v1/chat/completions');
  assert.match(chatEndpoint(), /integrate\.api\.nvidia\.com\/v1\/chat\/completions$/);
  assert.throws(() => chatEndpoint('http://insecure.example'), /HTTPS/);
});

test('goalCheck sends the request to the configured provider, not a hardcoded one', async () => {
  ok.calls = [];
  const mandate = { goal: 'school supplies for a teenager' };
  const request = { reason: 'notebooks for class', item: 'notebooks', category: 'stationery', merchant: 'Campus Bookstore' };
  await goalCheck({ mandate, request }, { apiKey: 'k', model: 'm1', baseUrl: 'https://api.groq.com/openai/v1', fetchImpl: ok('{"match":true,"note":""}') });
  assert.equal(ok.calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(ok.calls[0].body.model, 'm1');
});

test('explainChain falls back to deterministic text with no key', async () => {
  const r = await explainChain([], { apiKey: '' });
  assert.equal(r.source, 'deterministic');
});
