import { api } from './api.js';
import { messages } from '/shared/crypto.js';

export const randomId = () => 'm_' + [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Build, sign (in this browser) and register a mandate. The private key never leaves the browser. */
export async function createMandate(ctx, fields) {
  if (!ctx.owner) throw new Error('No signing key is available in this browser.');
  const now = Date.now();
  const mandate = {
    id: randomId(),
    title: fields.title.trim(),
    goal: fields.goal.trim(),
    helper: fields.helper,
    currency: fields.currency,
    budgetCents: fields.budgetCents,
    perTxCapCents: fields.perTxCapCents,
    approvalAboveCents: fields.approvalAboveCents,
    allowedMerchants: fields.allowedMerchants,
    agents: fields.agents,
    allowedCategories: fields.allowedCategories ?? [],
    createdAt: now,
    expiresAt: now + fields.days * 86400_000,
  };
  const signature = await ctx.owner.sign(messages.mandate(mandate));
  await api('POST', '/api/mandates', { mandate, publicKeyJwk: ctx.owner.publicKeyJwk, signature });
  return mandate.id;
}

/** Scenario mandates. Amounts scale with the demo currency so the same story works in INR and USD. */
export function demoMandateFields(ctx, scenario) {
  const cur = ctx.cfg?.currency ?? 'INR';
  if (scenario === 'teen' || scenario === 'liveagent') {
    const kid = (cur === 'INR' ? 400000 : 5000) * 100; // a small exporter's supplier budget
    return {
      title: 'Export order supplies',
      goal: 'Packaging and raw materials for a small export order',
      helper: 'ai_agent',
      currency: cur,
      budgetCents: kid,
      perTxCapCents: Math.round(kid * 0.7),
      approvalAboveCents: Math.round(kid * 0.3),
      allowedMerchants: ['PackRight Supplies', 'Textile Mart'],
      agents: ['*'],
      days: 7,
    };
  }
  const budget = (cur === 'INR' ? 20000 : 200) * 100;
  return {
    title: 'Design team supplies',
    goal: 'Office equipment for the design team',
    helper: 'ai_agent',
    currency: cur,
    budgetCents: budget,
    perTxCapCents: Math.round(budget * 0.8),
    approvalAboveCents: scenario === 'approval' ? Math.round(budget * 0.2) : budget,
    allowedMerchants: ['Dell Store', 'IKEA'],
    agents: ['*'],
    days: 7,
  };
}

export async function ownerMatches(ctx, bundle) {
  return ctx.owner && bundle.blocks[0]?.data?.publicKeyJwk?.x === ctx.owner.publicKeyJwk.x;
}
