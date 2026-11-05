import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_NVIDIA_BASE_URL, DEFAULT_NVIDIA_MODEL, NvidiaRequestError, nvidiaChatCompletion } from '../src/nvidia.js';

const messages = [{ role: 'system', content: 'System instructions' }, { role: 'user', content: 'Question' }];

test('NVIDIA NIM uses the configurable server-side endpoint and bounded request body', async () => {
  let request;
  const content = await nvidiaChatCompletion({
    apiKey: 'server-only-key',
    model: DEFAULT_NVIDIA_MODEL,
    baseUrl: 'https://nim.example/v1/',
    messages,
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'A response.' } }] }) };
    },
  });
  assert.equal(content, 'A response.');
  assert.equal(request.url, 'https://nim.example/v1/chat/completions');
  assert.equal(request.options.headers.Authorization, 'Bearer server-only-key');
  assert.equal(request.body.model, 'openai/gpt-oss-20b');
  assert.equal(request.body.max_tokens, 1024);
  assert.equal(request.body.stream, false);
  assert.equal(DEFAULT_NVIDIA_BASE_URL, 'https://integrate.api.nvidia.com/v1');
  assert.equal(DEFAULT_NVIDIA_MODEL, 'openai/gpt-oss-20b');
});

test('NVIDIA NIM retries a transient provider response once, not indefinitely', async () => {
  let calls = 0;
  const content = await nvidiaChatCompletion({
    apiKey: 'server-only-key',
    model: 'test/model',
    messages,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Recovered.' } }] }) };
    },
  });
  assert.equal(content, 'Recovered.');
  assert.equal(calls, 2);
});

test('NVIDIA NIM does not retry credential errors and never includes the key in errors', async () => {
  let calls = 0;
  await assert.rejects(
    nvidiaChatCompletion({
      apiKey: 'secret-key-not-for-errors',
      model: 'test/model',
      messages,
      fetchImpl: async () => { calls++; return { ok: false, status: 401 }; },
    }),
    (error) => error instanceof NvidiaRequestError && error.status === 401 && !error.message.includes('secret-key'),
  );
  assert.equal(calls, 1);
});

test('NVIDIA NIM retries timeouts once and rejects non-HTTPS base URLs', async () => {
  let calls = 0;
  await assert.rejects(
    nvidiaChatCompletion({
      apiKey: 'server-only-key',
      model: 'test/model',
      messages,
      fetchImpl: async () => { calls++; throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); },
    }),
    (error) => error instanceof NvidiaRequestError && error.code === 'timeout',
  );
  assert.equal(calls, 2);
  await assert.rejects(
    nvidiaChatCompletion({ apiKey: 'server-only-key', model: 'test/model', baseUrl: 'http://nim.example/v1', messages }),
    /HTTPS URL/,
  );
});

test('NVIDIA NIM classifies common authentication, model, quota and server errors safely', async () => {
  const expected = new Map([
    [401, 'authentication_failed'],
    [403, 'access_denied'],
    [404, 'model_not_found'],
    [410, 'model_retired'],
    [429, 'rate_limited'],
    [500, 'provider_error'],
  ]);
  for (const [status, code] of expected) {
    let calls = 0;
    await assert.rejects(
      nvidiaChatCompletion({
        apiKey: 'secret-key-not-for-errors',
        model: DEFAULT_NVIDIA_MODEL,
        messages,
        fetchImpl: async () => { calls++; return { ok: false, status }; },
      }),
      (error) => error instanceof NvidiaRequestError
        && error.status === status
        && error.code === code
        && !error.message.includes('secret-key'),
    );
    assert.equal(calls, status === 429 || status === 500 ? 2 : 1, `unexpected retry count for HTTP ${status}`);
  }
});
