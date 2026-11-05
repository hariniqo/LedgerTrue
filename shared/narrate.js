// Plain-English story of a chain. Deterministic and offline: the Proof Card can show it with no server and no AI.
import { BLOCK } from './rules.js';

export function money(cents, currency = 'USD') {
  return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency }).format((cents ?? 0) / 100);
}

const REASON_TEXT = {
  MANDATE_ACTIVE: 'the mandate was revoked',
  NOT_EXPIRED: 'the mandate had expired',
  AMOUNT_VALID: 'the amount was not valid',
  AGENT_AUTHORIZED: 'the agent is not allowed to spend here',
  MERCHANT_ALLOWED: 'the merchant is not on the allowed list',
  PER_TX_CAP: 'it was above the per-payment cap',
  BUDGET_AVAILABLE: 'there was not enough budget left',
  INJECTION_TRIPWIRE: 'the request text tried to change the rules',
  RESTRICTED_CATEGORY: 'it was a restricted purchase type',
  GOAL_CHECK: 'it did not look related to the goal',
  OWNER_APPROVAL_THRESHOLD: 'it was above the owner-approval threshold',
  ML_RISK_REVIEW: 'its spending pattern looked unusual for this agent (an estimate, not a finding of fraud)',
};
export const reasonText = (code) => REASON_TEXT[code] ?? code;

export function narrate(blocks) {
  const mandateBlock = blocks.find((b) => b.type === BLOCK.MANDATE);
  const m = mandateBlock?.data.mandate;
  if (!m) return { headline: 'No mandate found.', stories: [] };
  const cur = m.currency;
  const stories = new Map();
  const story = (id) => { if (!stories.has(id)) stories.set(id, { requestId: id, title: '', status: 'NEW', steps: [] }); return stories.get(id); };
  const orderOf = [];

  for (const b of blocks) {
    const d = b.data ?? {};
    const s = d.requestId ? story(d.requestId) : null;
    const step = (kind, text) => s.steps.push({ kind, text, blockIndex: b.index, ts: b.ts });
    switch (b.type) {
      case BLOCK.REQUEST:
        orderOf.push(d.requestId);
        s.title = `${d.agentId} asked for ${money(d.amountCents, cur)} at ${d.merchant}`;
        step('request', `${d.agentId} asked to pay ${money(d.amountCents, cur)} to ${d.merchant}${d.item ? ` for "${d.item}"` : ''}. Reason given: "${d.reason}"`);
        break;
      case BLOCK.DECISION: {
        const why = d.reasons.map(reasonText);
        if (d.outcome === 'APPROVED') { s.status = 'APPROVED'; step('approved', 'Every rule passed, so the guard approved it and reserved the budget.'); }
        else if (d.outcome === 'NEEDS_APPROVAL') { s.status = 'WAITING'; step('escalated', `The guard paused it for the owner because ${why.join(' and ')}. Budget is reserved meanwhile.`); }
        else { s.status = 'BLOCKED'; step('blocked', `Blocked by code because ${why.join(', ')}. No money moved.`); }
        break;
      }
      case BLOCK.APPROVAL:
        s.status = d.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
        step(d.decision === 'APPROVE' ? 'approved' : 'blocked', d.decision === 'APPROVE' ? 'The owner signed this exact decision.' : 'The owner rejected it and the reserved budget was released.');
        break;
      case BLOCK.HOLD: s.status = 'HELD'; step('hold', `${money(d.amountCents, cur)} was put on hold (${d.gateway === 'paypal' ? 'PayPal authorization' : 'simulated authorization'} ${d.authId ?? d.orderId}).`); break;
      case BLOCK.CAPTURE: s.status = 'SETTLED'; step('settled', `${money(d.amountCents, cur)} was settled${d.via === 'reconciler-poll' ? ' after the capture reply was lost and PayPal confirmed it' : ''}${d.captureId ? ` (capture ${d.captureId})` : ''}.`); break;
      case BLOCK.VOID: s.status = 'RELEASED'; step('released', `Released: ${d.reason}. Budget restored.`); break;
      case BLOCK.RECON: step('recon', d.note); break;
      default: break;
    }
  }
  const revoke = blocks.find((b) => b.type === BLOCK.REVOKE);
  return {
    headline: `${m.title}: budget ${money(m.budgetCents, cur)} for "${m.goal}"`,
    revokedAt: revoke?.ts ?? null,
    stories: orderOf.map((id) => stories.get(id)),
  };
}
