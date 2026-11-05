// The rule engine. Pure functions, no I/O, no clock: every input (including the time) comes from the chain.
// That is what lets a stranger's browser replay the guard's decisions and prove it followed the mandate.
import { scanText, goalOverlap } from './heuristics.js';

export const BLOCK = Object.freeze({
  MANDATE: 'MANDATE',
  REQUEST: 'REQUEST',
  DECISION: 'DECISION',
  APPROVAL: 'APPROVAL',
  HOLD: 'HOLD',
  CAPTURE: 'CAPTURE',
  VOID: 'VOID',
  RECON: 'RECON',
  REVOKE: 'REVOKE',
});

export const OUTCOME = Object.freeze({ APPROVED: 'APPROVED', BLOCKED: 'BLOCKED', NEEDS_APPROVAL: 'NEEDS_APPROVAL' });

export const STATUS = Object.freeze({
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  BLOCKED: 'BLOCKED',
  REJECTED: 'REJECTED',
  HELD: 'HELD',
  SETTLED: 'SETTLED',
  VOIDED: 'VOIDED',
});

export const CHECK_LABELS = {
  MANDATE_ACTIVE: 'Mandate is active',
  NOT_EXPIRED: 'Mandate has not expired',
  AMOUNT_VALID: 'Amount is a positive whole number of minor units',
  AGENT_AUTHORIZED: 'Agent is allowed to spend from this mandate',
  MERCHANT_ALLOWED: 'Merchant is on the allowed list',
  PER_TX_CAP: 'Within the per-payment cap',
  BUDGET_AVAILABLE: 'Enough budget is left',
  INJECTION_TRIPWIRE: 'No instruction-hijacking text',
  RESTRICTED_CATEGORY: 'Not a restricted purchase type',
  GOAL_CHECK: 'Matches the mandate goal',
  OWNER_APPROVAL_THRESHOLD: 'Below the owner-approval threshold',
  ML_RISK_REVIEW: 'Spend pattern looks normal for this agent',
};

export function emptyState() {
  return { mandate: null, revoked: false, requests: {}, settledCents: 0, heldCents: 0, reservedCents: 0, blocks: 0 };
}

export const availableCents = (s) => (s.mandate ? s.mandate.budgetCents - s.settledCents - s.heldCents - s.reservedCents : 0);

const lc = (s) => String(s ?? '').trim().toLowerCase();

export function validateMandate(m) {
  const errs = [];
  const int = (v) => Number.isInteger(v) && v > 0;
  if (!m || typeof m !== 'object') return ['mandate must be an object'];
  if (!/^m_[a-f0-9]{24}$/.test(m.id ?? '')) errs.push('id must look like m_<24 hex>');
  if (typeof m.title !== 'string' || !m.title.trim() || m.title.length > 80) errs.push('title is required (max 80 chars)');
  if (typeof m.goal !== 'string' || !m.goal.trim() || m.goal.length > 240) errs.push('goal is required (max 240 chars)');
  if (!/^[A-Z]{3}$/.test(m.currency ?? '')) errs.push('currency must be a 3-letter code');
  if (!int(m.budgetCents)) errs.push('budgetCents must be a positive integer');
  if (!int(m.perTxCapCents) || m.perTxCapCents > m.budgetCents) errs.push('perTxCapCents must be positive and not above the budget');
  if (!Number.isInteger(m.approvalAboveCents) || m.approvalAboveCents < 0) errs.push('approvalAboveCents must be a non-negative integer');
  if (!Array.isArray(m.allowedMerchants) || !m.allowedMerchants.length || m.allowedMerchants.length > 50 || m.allowedMerchants.some((x) => typeof x !== 'string' || !x.trim())) errs.push('allowedMerchants needs 1-50 names');
  if (!Array.isArray(m.agents) || !m.agents.length || m.agents.some((x) => typeof x !== 'string' || !x.trim())) errs.push('agents needs at least one id (or "*")');
  if (!Array.isArray(m.allowedCategories ?? [])) errs.push('allowedCategories must be a list');
  if (!['ai_agent', 'child', 'employee'].includes(m.helper)) errs.push('helper must be ai_agent, child or employee');
  if (!Number.isInteger(m.createdAt) || !Number.isInteger(m.expiresAt) || m.expiresAt <= m.createdAt) errs.push('expiresAt must be after createdAt');
  return errs;
}

/**
 * Evaluate one payment request against the mandate and the state of the chain so far.
 * Hard checks block. Soft checks only escalate to the owner. Nothing here can approve more than the rules allow.
 */
export function evaluate(mandate, state, req, ts) {
  const checks = [];
  const add = (code, pass, detail, hard = true) => checks.push({ code, pass: Boolean(pass), hard, detail });

  add('MANDATE_ACTIVE', !state.revoked, state.revoked ? 'The owner revoked this mandate.' : 'Active.');
  add('NOT_EXPIRED', ts < mandate.expiresAt, ts < mandate.expiresAt ? 'Still valid.' : `Expired at ${new Date(mandate.expiresAt).toISOString()}.`);
  const amt = req.amountCents;
  add('AMOUNT_VALID', Number.isInteger(amt) && amt > 0, 'Amount must be a positive integer of minor units.');
  const agentOk = mandate.agents.includes('*') || mandate.agents.map(lc).includes(lc(req.agentId));
  add('AGENT_AUTHORIZED', agentOk, agentOk ? `${req.agentId} is allowed.` : `${req.agentId} is not on the mandate's agent list.`);
  const merchantOk = mandate.allowedMerchants.map(lc).includes(lc(req.merchant));
  add('MERCHANT_ALLOWED', merchantOk, merchantOk ? `${req.merchant} is allowed.` : `${req.merchant} is not on the allowed merchant list.`);
  add('PER_TX_CAP', amt <= mandate.perTxCapCents, `Cap is ${mandate.perTxCapCents}, request is ${amt}.`);
  const left = availableCents(state);
  add('BUDGET_AVAILABLE', amt <= left, `Available ${left}, request ${amt}.`);

  const scan = scanText(req.reason, req.merchant, req.category, req.item);
  add('INJECTION_TRIPWIRE', scan.injection.length === 0, scan.injection.length ? 'Request text tries to change the rules, so it is treated as an attack.' : 'Clean.');
  const catAllowed = (mandate.allowedCategories ?? []).map(lc).includes(lc(req.category));
  const restricted = scan.restricted.filter((w) => !catAllowed);
  add('RESTRICTED_CATEGORY', restricted.length === 0, restricted.length ? `Restricted purchase type: ${restricted.join(', ')}.` : 'Clear.');

  // Soft checks: these can only ask for a human, never approve or block by themselves.
  const ai = req.aiFlag ?? {};
  const overlap = goalOverlap(mandate.goal, req.reason, req.item, req.category, req.merchant);
  const drift = ai.checked ? Boolean(ai.mismatch) : overlap.applicable && !overlap.overlap;
  add('GOAL_CHECK', !drift, drift ? (ai.note || 'The purchase does not look related to the mandate goal.') : 'Related to the goal.', false);
  // Advisory spend-risk flag, recorded on the REQUEST block by the server (never supplied by the agent). Like GOAL_CHECK it
  // can only ask the owner to look. Chains written before this existed carry no flag and replay exactly as before.
  const rf = req.riskFlag;
  if (rf && rf.checked) add('ML_RISK_REVIEW', !rf.escalate, rf.escalate ? `Spend-risk score ${rf.score} is at or above ${rf.threshold} (${rf.source}). This is an estimate, not a finding of fraud.` : 'Spend pattern looks normal for this agent.', false);
  const big = amt > mandate.approvalAboveCents;
  add('OWNER_APPROVAL_THRESHOLD', !big, big ? `Above ${mandate.approvalAboveCents}: the owner must sign.` : 'No signature needed.', false);

  const hardFail = checks.filter((c) => c.hard && !c.pass);
  const softFail = checks.filter((c) => !c.hard && !c.pass);
  const outcome = hardFail.length ? OUTCOME.BLOCKED : softFail.length ? OUTCOME.NEEDS_APPROVAL : OUTCOME.APPROVED;
  return { outcome, checks, reasons: [...hardFail, ...softFail].map((c) => c.code) };
}

/** Reject any block that does not follow legally from the state before it. Used by the engine and the verifier alike. */
export function checkTransition(state, block) {
  const v = [];
  const d = block.data ?? {};
  const rq = d.requestId ? state.requests[d.requestId] : null;
  const need = (cond, msg) => { if (!cond) v.push(msg); };

  switch (block.type) {
    case BLOCK.MANDATE:
      need(block.index === 0 && !state.mandate, 'MANDATE must be block 0 and appear once');
      break;
    case BLOCK.REQUEST:
      need(Boolean(state.mandate), 'request before mandate');
      need(!rq, `duplicate request id ${d.requestId}`);
      need(typeof d.requestId === 'string' && d.requestId.length > 0, 'request id missing');
      break;
    case BLOCK.DECISION: {
      need(rq && rq.status === 'NEW', 'decision without a fresh request');
      need(rq && rq.requestBlock === block.index - 1, 'decision must directly follow its request');
      if (rq && state.mandate) {
        const re = evaluate(state.mandate, state, { ...rq.data }, rq.ts);
        need(re.outcome === d.outcome, `guard said ${d.outcome} but the rules say ${re.outcome}`);
        const a = [...re.reasons].sort().join(',');
        const b = [...(d.reasons ?? [])].sort().join(',');
        need(a === b, `recorded reasons (${b || 'none'}) differ from the rules (${a || 'none'})`);
      }
      break;
    }
    case BLOCK.APPROVAL:
      need(rq && rq.status === STATUS.PENDING_APPROVAL, 'approval for a request that is not waiting');
      need(d.decision === 'APPROVE' || d.decision === 'REJECT', 'bad approval decision');
      break;
    case BLOCK.HOLD:
      need(rq && rq.status === STATUS.APPROVED, 'hold for a request that is not approved');
      need(rq && d.amountCents === rq.amountCents, 'hold amount differs from the approved amount');
      break;
    case BLOCK.CAPTURE:
      need(rq && rq.status === STATUS.HELD, 'capture without a hold');
      need(rq && Number.isInteger(d.amountCents) && d.amountCents > 0 && d.amountCents <= rq.heldCents, 'capture exceeds the hold');
      break;
    case BLOCK.VOID:
      need(rq && [STATUS.HELD, STATUS.APPROVED, STATUS.PENDING_APPROVAL].includes(rq.status), 'void for a request that holds nothing');
      break;
    case BLOCK.REVOKE:
      need(!state.revoked, 'already revoked');
      break;
    case BLOCK.RECON:
      break;
    default:
      v.push(`unknown block type ${block.type}`);
  }
  return v;
}

/** Fold one block into the state. Assumes checkTransition already passed. */
export function applyBlock(state, block) {
  const d = block.data ?? {};
  const rq = d.requestId ? state.requests[d.requestId] : null;
  state.blocks += 1;
  switch (block.type) {
    case BLOCK.MANDATE: state.mandate = d.mandate; break;
    case BLOCK.REQUEST:
      state.requests[d.requestId] = { id: d.requestId, status: 'NEW', amountCents: d.amountCents, agentId: d.agentId, merchant: d.merchant, ts: block.ts, requestBlock: block.index, heldCents: 0, capturedCents: 0, data: d };
      break;
    case BLOCK.DECISION:
      rq.decisionBlock = block.index;
      if (d.outcome === OUTCOME.BLOCKED) rq.status = STATUS.BLOCKED;
      else { rq.status = d.outcome === OUTCOME.APPROVED ? STATUS.APPROVED : STATUS.PENDING_APPROVAL; state.reservedCents += rq.amountCents; }
      break;
    case BLOCK.APPROVAL:
      if (d.decision === 'APPROVE') rq.status = STATUS.APPROVED;
      else { rq.status = STATUS.REJECTED; state.reservedCents -= rq.amountCents; }
      break;
    case BLOCK.HOLD:
      rq.status = STATUS.HELD; rq.heldCents = d.amountCents;
      state.reservedCents -= rq.amountCents; state.heldCents += d.amountCents;
      break;
    case BLOCK.CAPTURE:
      state.heldCents -= rq.heldCents; state.settledCents += d.amountCents;
      rq.capturedCents = d.amountCents; rq.heldCents = 0; rq.status = STATUS.SETTLED;
      break;
    case BLOCK.VOID:
      if (rq.status === STATUS.HELD) { state.heldCents -= rq.heldCents; rq.heldCents = 0; } else state.reservedCents -= rq.amountCents;
      rq.status = STATUS.VOIDED;
      break;
    case BLOCK.REVOKE: state.revoked = true; break;
    default: break;
  }
  return state;
}

/** Budget can never be exceeded, whatever the blocks say. A hard invariant, checked after every block. */
export function budgetViolation(state) {
  if (!state.mandate) return null;
  const total = state.settledCents + state.heldCents + state.reservedCents;
  if (total > state.mandate.budgetCents) return `committed ${total} exceeds the budget ${state.mandate.budgetCents}`;
  if (state.settledCents < 0 || state.heldCents < 0 || state.reservedCents < 0) return 'a balance went negative';
  return null;
}

export function summarize(state) {
  const m = state.mandate;
  const counts = {};
  for (const r of Object.values(state.requests)) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return {
    budgetCents: m?.budgetCents ?? 0,
    settledCents: state.settledCents,
    heldCents: state.heldCents,
    reservedCents: state.reservedCents,
    availableCents: availableCents(state),
    revoked: state.revoked,
    counts,
  };
}
