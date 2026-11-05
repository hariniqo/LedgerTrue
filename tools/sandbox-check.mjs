#!/usr/bin/env node
// One real PayPal SANDBOX run: hold (authorize) -> settle (capture) or release (void). Use it to record the demo.
//   1. Put sandbox credentials in .env (PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET). Never in .env.example.
//   2. node tools/sandbox-check.mjs            # hold + capture
//      node tools/sandbox-check.mjs --void     # hold + release
// It refuses to run against live PayPal. It moves sandbox play-money only.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { PayPalClient } from '../src/paypal.js';
import { PayPalGateway } from '../src/proof/gateway.js';

export async function runSandboxCheck({ gateway, ask, log = console.log, amountCents = 1000, currency = 'USD', release = false }) {
  const hold = await gateway.createHold({ requestId: `check-${Date.now()}`.slice(-40), amountCents, currency, description: 'LedgerTrue sandbox check' });
  log(`1. Order created: ${hold.orderId}`);
  if (hold.needsApproval) {
    log(`2. Open this link, log in with a SANDBOX buyer account and approve:\n   ${hold.approveUrl}`);
    await ask('   Press Enter once you approved in PayPal... ');
  }
  const auth = hold.needsApproval ? await gateway.completeHold(hold.orderId) : hold;
  log(`3. Hold placed (authorization ${auth.authId}). The money is reserved, not taken.`);
  if (release) {
    await gateway.void({ authId: auth.authId });
    log('4. Hold released (void). Budget would be restored.');
    return { orderId: hold.orderId, authId: auth.authId, outcome: 'RELEASED' };
  }
  const cap = await gateway.capture({ authId: auth.authId, amountCents, currency });
  log(`4. Settled. Capture ${cap.captureId}. Evidence hash of PayPal's reply: ${cap.witness?.evidenceHash ?? 'n/a'}`);
  return { orderId: hold.orderId, authId: auth.authId, captureId: cap.captureId, evidenceHash: cap.witness?.evidenceHash ?? null, outcome: 'SETTLED' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  const env = process.env.PAYPAL_ENV || 'sandbox';
  if (env !== 'sandbox') { console.error('Refusing to run: PAYPAL_ENV must be "sandbox".'); process.exit(2); }
  const client = new PayPalClient({ clientId: process.env.PAYPAL_CLIENT_ID, secret: process.env.PAYPAL_CLIENT_SECRET, env });
  if (!client.configured) { console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env first (sandbox app from developer.paypal.com).'); process.exit(2); }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const r = await runSandboxCheck({ gateway: new PayPalGateway(client), ask: (q) => rl.question(q), release: process.argv.includes('--void'), currency: process.env.DEMO_CURRENCY || 'USD' });
    console.log('\nResult:', JSON.stringify(r));
  } catch (e) { console.error(`\nFailed: ${e.message}${e.body?.message ? ` (${e.body.message})` : ''}`); process.exitCode = 1; } finally { rl.close(); }
}
