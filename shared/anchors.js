// Anchors: signed, hash-linked "I saw this chain head at this time" records.
// They are meant to be COPIED OUT of the server (a public repo, a webhook, a printout). Once a head is anchored
// somewhere the operator cannot edit, even the guard-key holder cannot quietly rewrite history behind it.
// Runs unchanged in Node and in the browser.
import { canonical } from './canonical.js';
import { GENESIS, sha256Hex, verifyText, fingerprint } from './crypto.js';
import { verifyBundle } from './verify.js';
import { BLOCK } from './rules.js';

export const anchorHash = (a) =>
  sha256Hex(canonical({ seq: a.seq, ts: a.ts, mandateId: a.mandateId, headIndex: a.headIndex, headHash: a.headHash, prev: a.prev }));

/** Verify a whole anchor log: sequence, links, hashes and guard signatures. */
export async function verifyAnchorLog(entries, guardJwk) {
  const issues = [];
  let prev = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const a = entries[i];
    if (a.seq !== i) issues.push(`Anchor ${i}: sequence number is ${a.seq}.`);
    if (a.prev !== prev) issues.push(`Anchor ${i}: does not link to the previous anchor (log was cut or reordered).`);
    if ((await anchorHash(a)) !== a.hash) issues.push(`Anchor ${i}: content does not match its hash.`);
    if (!(await verifyText(guardJwk, String(a.hash), String(a.guardSig ?? '')))) issues.push(`Anchor ${i}: guard signature does not verify.`);
    prev = a.hash;
  }
  return { ok: issues.length === 0, count: entries.length, issues, head: entries.length ? { seq: entries.length - 1, hash: prev } : null };
}

/**
 * Check one mandate's anchors against its chain. Each anchor must be authentic (hash + guard signature) and the
 * chain must still contain exactly the block that was anchored. A rewritten or truncated chain fails here even
 * when the rewrite is internally consistent and re-signed with the real guard key.
 */
export async function verifyAnchors(bundle, entries, guardJwk) {
  const issues = [];
  const mine = (entries ?? []).filter((a) => a.mandateId === bundle.mandateId);
  let lastIndex = -1; let lastSeq = -1; let latest = null;
  for (const a of mine) {
    if ((await anchorHash(a)) !== a.hash) { issues.push(`Anchor #${a.seq}: content does not match its hash.`); continue; }
    if (!(await verifyText(guardJwk, String(a.hash), String(a.guardSig ?? '')))) { issues.push(`Anchor #${a.seq}: guard signature does not verify.`); continue; }
    if (a.seq <= lastSeq || a.headIndex < lastIndex) issues.push(`Anchor #${a.seq}: out of order.`);
    lastSeq = a.seq; lastIndex = Math.max(lastIndex, a.headIndex);
    const at = bundle.blocks[a.headIndex];
    if (!at) issues.push(`Anchor #${a.seq} recorded block ${a.headIndex}, but the chain now ends at ${bundle.blocks.length - 1}: blocks were removed.`);
    else if (at.hash !== a.headHash) issues.push(`Anchor #${a.seq}: block ${a.headIndex} is not the block that was anchored: history was rewritten.`);
    latest = a;
  }
  return { ok: issues.length === 0, count: mine.length, issues, latest };
}

/** A portable proof file: the chain plus the anchors that cover it. Verifiable offline with no server at all. */
export const PROOF_FORMAT = 'ledgertrue-proof/1';

export function makeProof({ bundle, anchors, anchorHead = null, exportedAt = Date.now() }) {
  return { format: PROOF_FORMAT, exportedAt, bundle, anchors, anchorHead };
}

/** Independent evidence: how many settlements carry a hash of the payment provider's own response. */
export function witnessSummary(blocks) {
  const caps = blocks.filter((b) => b.type === BLOCK.CAPTURE);
  const witnessed = caps.filter((b) => b.data?.witness && b.data.witness.simulated === false);
  const simulated = caps.filter((b) => b.data?.witness?.simulated === true);
  return { settlements: caps.length, witnessed: witnessed.length, simulated: simulated.length };
}

/** Accepts a proof file or a bare bundle. */
export async function verifyProof(input, { expectedGuardFingerprint = null, expectedHead = null } = {}) {
  const bundle = input?.format === PROOF_FORMAT ? input.bundle : input;
  const anchors = input?.format === PROOF_FORMAT ? input.anchors ?? [] : [];
  const chain = await verifyBundle(bundle, { expectedGuardFingerprint, expectedHead });
  let anchorResult = { ok: true, count: 0, issues: [], latest: null };
  if (bundle?.guard?.publicKeyJwk && anchors.length) anchorResult = await verifyAnchors(bundle, anchors, bundle.guard.publicKeyJwk);
  const witness = chain.ok ? witnessSummary(bundle.blocks) : { settlements: 0, witnessed: 0, simulated: 0 };
  return {
    ok: chain.ok && anchorResult.ok,
    chain, anchors: anchorResult, witness,
    anchored: anchorResult.ok && anchorResult.count > 0,
    guardFingerprint: bundle?.guard?.publicKeyJwk ? await fingerprint(bundle.guard.publicKeyJwk) : null,
  };
}
