#!/usr/bin/env node
// Checks the LLM and PayPal credentials from .env and says exactly what is wrong. Never prints a secret.
//   node --env-file=.env tools/diagnose.mjs
import { nvidiaChatCompletion, DEFAULT_NVIDIA_BASE_URL, DEFAULT_NVIDIA_MODEL } from '../src/nvidia.js';
import { PayPalClient } from '../src/paypal.js';

const e = process.env;
const ok = (m) => console.log(`  OK    ${m}`);
const bad = (m) => console.log(`  FAIL  ${m}`);

console.log('LLM');
const key = e.AI_API_KEY || e.NVIDIA_API_KEY;
const model = e.AI_MODEL || e.NVIDIA_MODEL || DEFAULT_NVIDIA_MODEL;
const baseUrl = e.AI_BASE_URL || e.NVIDIA_BASE_URL || DEFAULT_NVIDIA_BASE_URL;
if (e.AI_DISABLED === 'true') bad('AI_DISABLED=true, every model call is switched off');
else if (!key) bad('no AI_API_KEY / NVIDIA_API_KEY set');
else {
  try {
    const t = Date.now();
    const out = await nvidiaChatCompletion({ apiKey: key, model, baseUrl, maxTokens: 512, timeoutMs: 30_000,
      messages: [{ role: 'system', content: 'Reply with one short sentence.' }, { role: 'user', content: 'Say hello.' }] });
    ok(`${model} answered in ${Date.now() - t} ms: "${out.slice(0, 60)}"`);
  } catch (err) { bad(`${err.code ?? err.name}: ${err.message}${err.cause ? ` (${err.cause.cause?.code ?? err.cause.code ?? err.cause.message})` : ''}`); }
}

console.log('PayPal');
const pp = new PayPalClient({ clientId: e.PAYPAL_CLIENT_ID, secret: e.PAYPAL_CLIENT_SECRET, env: e.PAYPAL_ENV || 'sandbox' });
if (!pp.configured) bad('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET empty: app runs in simulator mode');
else {
  if (e.PAYPAL_CLIENT_ID.length < 40) bad(`PAYPAL_CLIENT_ID is ${e.PAYPAL_CLIENT_ID.length} chars; real ones are ~80, so it is truncated`);
  try { await pp.token(); ok(`${pp.env} credentials accepted`); } catch (err) { bad(err.message); }
  if (pp.env === 'sandbox') try { const o = await pp.createOrder({ amountCents: 100 }); ok(`created sandbox order ${o.id}`); } catch (err) { bad(err.message); }
}
