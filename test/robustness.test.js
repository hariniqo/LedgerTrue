import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { makeAuth } from '../src/security.js';
import { createApp } from '../src/server.js';

const boot = async (env = {}) => {
  const app = await createApp({ DEMO_MODE: 'true', PERSIST_FILE: '', CHAIN_DIR: '', GUARD_KEY_FILE: '', ANCHOR_FILE: '', PENDING_FILE: '', AI_DISABLED: 'true', ...env });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  return { ...app, port: app.server.address().port, close: () => new Promise((r) => app.server.close(r)) };
};
const raw = (port, requestLine) => new Promise((resolve, reject) => {
  const c = net.connect(port, '127.0.0.1', () => c.write(`${requestLine} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
  let buf = ''; c.on('data', (d) => { buf += d; }); c.on('end', () => resolve(buf)); c.on('error', reject);
});

test('malformed request URL returns 400 and the server stays up', async () => {
  const s = await boot();
  const res = await raw(s.port, 'GET //');
  assert.match(res, /^HTTP\/1\.1 400/);
  const ok = await fetch(`http://127.0.0.1:${s.port}/api/config`);
  assert.equal(ok.status, 200);
  await s.close();
});

test('bad percent-encoding returns 400, not 500', async () => {
  const s = await boot();
  const res = await raw(s.port, 'GET /api/mandates/%ZZ/proof');
  assert.match(res, /^HTTP\/1\.1 400/);
  await s.close();
});

test('open demo mode is refused in production', () => {
  assert.throws(() => makeAuth({ DEMO_MODE: 'true', NODE_ENV: 'production' }), /refused when NODE_ENV=production/);
  assert.doesNotThrow(() => makeAuth({ DEMO_MODE: 'false', NODE_ENV: 'production', OPERATOR_TOKEN: 'o'.repeat(20), AGENT_TOKEN: 'a'.repeat(20) }));
});

test('TOKEN_SECRET must be long enough', () => {
  assert.throws(() => makeAuth({ DEMO_MODE: 'true', TOKEN_SECRET: 'short' }), /at least 16/);
});

test('GET requests are rate limited too', async () => {
  const s = await boot({ RATE_LIMIT_READ_PER_10S: '5' });
  const codes = [];
  for (let i = 0; i < 10; i++) codes.push((await fetch(`http://127.0.0.1:${s.port}/api/config`)).status);
  assert.ok(codes.includes(429), `expected a 429 in ${codes}`);
  await s.close();
});

test('with TRUST_PROXY the limiter keys on the forwarded client, not the proxy', async () => {
  const s = await boot({ TRUST_PROXY: 'true', RATE_LIMIT_READ_PER_10S: '3' });
  const hit = (ip) => fetch(`http://127.0.0.1:${s.port}/api/config`, { headers: { 'x-forwarded-for': ip } }).then((r) => r.status);
  for (let i = 0; i < 5; i++) await hit('203.0.113.1');
  assert.equal(await hit('203.0.113.1'), 429);
  assert.equal(await hit('203.0.113.2'), 200);
  await s.close();
});
