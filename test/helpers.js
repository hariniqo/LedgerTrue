import { generateKeyPair, exportPublicJwk, signText, messages } from '../shared/crypto.js';
import { ChainStore } from '../src/proof/chainStore.js';
import { ProofEngine } from '../src/proof/engine.js';
import { SimGateway } from '../src/proof/gateway.js';
import { SimPayPal } from '../src/scenarios.js';
import { Reconciler } from '../src/reconciler.js';
import { loadGuard } from '../src/proof/guardKeys.js';
import crypto from 'node:crypto';

export async function owner() {
  const pair = await generateKeyPair();
  const publicKeyJwk = await exportPublicJwk(pair.publicKey);
  return { pair, publicKeyJwk, sign: (text) => signText(pair.privateKey, text) };
}

export const mandateId = () => 'm_' + crypto.randomBytes(12).toString('hex');

export function mandateFor(id, over = {}) {
  const now = Date.now();
  return {
    id, title: 'Design team supplies', goal: 'Office equipment for the design team', helper: 'ai_agent', currency: 'INR',
    budgetCents: 2_000_000, perTxCapCents: 1_600_000, approvalAboveCents: 1_600_000,
    allowedMerchants: ['Dell Store', 'IKEA'], agents: ['*'], allowedCategories: [], createdAt: now, expiresAt: now + 7 * 86400_000, ...over,
  };
}

export async function world({ dir = null, captureTimeoutMs = 500 } = {}) {
  const guard = await loadGuard(null);
  const store = new ChainStore({ dir, guard });
  const sim = new SimPayPal();
  const gateway = new SimGateway(sim);
  const recon = new Reconciler({ oracle: sim.oracle });
  const engine = new ProofEngine({ store, gateway, recon, captureTimeoutMs });
  return { guard, store, sim, gateway, recon, engine };
}

export async function newMandate(w, over = {}) {
  const o = await owner();
  const id = mandateId();
  const mandate = mandateFor(id, over);
  await w.engine.createMandate({ mandate, publicKeyJwk: o.publicKeyJwk, signature: await o.sign(messages.mandate(mandate)) });
  return { id, mandate, owner: o };
}

export const approvalSig = (o, { mandateId: id, requestId, decision, decisionHash }) => o.sign(messages.approval({ mandateId: id, requestId, decision, decisionHash }));

export const ask = (engine, id, over = {}) => engine.requestPayment(id, {
  agentId: 'shopper-1', merchant: 'Dell Store', category: 'office', item: 'Laptop for the design team',
  reason: 'Replace the failing laptop for the design team', amountCents: 100_000, ...over,
});
