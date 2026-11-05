// Independent verification of a Proof Card bundle. Runs unchanged in Node (server, tests) and in the browser
// (the public verify page), so the person checking a receipt does not have to trust our server's word.
import { canonical } from './canonical.js';
import { GENESIS, sha256Hex, verifyText, fingerprint, messages } from './crypto.js';
import { BLOCK, emptyState, checkTransition, applyBlock, budgetViolation, validateMandate, summarize } from './rules.js';

export const blockHash = (b) =>
  sha256Hex(canonical({ index: b.index, ts: b.ts, type: b.type, mandateId: b.mandateId, data: b.data, prevHash: b.prevHash }));

/**
 * @returns {Promise<{ok:boolean, height:number, headHash:string|null, guardFingerprint:string|null,
 *   blocks:{index:number,type:string,ok:boolean,issues:{kind:string,msg:string}[]}[],
 *   firstBadIndex:number|null, issues:{kind:string,msg:string}[], summary:object|null}>}
 * Issue kinds: HASH (content changed), LINK (chain cut), SIGNATURE (forged or wrong key),
 *              RULE (the guard broke the mandate), STRUCTURE (malformed), HEAD (truncated or replaced tail).
 */
export async function verifyBundle(bundle, { expectedHead = null, expectedGuardFingerprint = null } = {}) {
  const out = { ok: false, height: 0, headHash: null, guardFingerprint: null, blocks: [], firstBadIndex: null, issues: [], summary: null };
  const top = (kind, msg) => out.issues.push({ kind, msg });

  if (!bundle || !Array.isArray(bundle.blocks) || !bundle.blocks.length || !bundle.guard?.publicKeyJwk) {
    top('STRUCTURE', 'Not a LedgerTrue bundle: blocks or guard key missing.');
    return out;
  }
  const { blocks, guard } = bundle;
  out.height = blocks.length;
  out.guardFingerprint = await fingerprint(guard.publicKeyJwk);
  if (expectedGuardFingerprint && expectedGuardFingerprint !== out.guardFingerprint) {
    top('SIGNATURE', `Guard key ${out.guardFingerprint} is not the one this receipt was issued under (${expectedGuardFingerprint}).`);
  }

  const state = emptyState();
  let ownerKey = null;
  let prev = GENESIS;
  let broken = false;

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const rec = { index: i, type: b?.type ?? '?', ok: true, issues: [] };
    const bad = (kind, msg) => { rec.ok = false; rec.issues.push({ kind, msg }); };

    if (!b || b.index !== i) bad('STRUCTURE', `Block index should be ${i}.`);
    if (b?.mandateId !== bundle.mandateId) bad('STRUCTURE', 'Block belongs to a different mandate.');

    // 1. Content hash: any edit to ts/type/data changes it.
    let recomputed = null;
    try { recomputed = await blockHash(b); } catch { bad('STRUCTURE', 'Block cannot be hashed.'); }
    if (recomputed && recomputed !== b.hash) bad('HASH', 'Content does not match its hash: this block was edited.');
    // 2. Link to the previous block.
    if (b?.prevHash !== prev) bad('LINK', i === 0 ? 'Block 0 must start from the genesis hash.' : 'Does not point at the previous block: the chain was cut or reordered.');
    // 3. The guard's signature over the hash: stops anyone who edits a block and recomputes every later hash.
    if (!(await verifyText(guard.publicKeyJwk, String(b?.hash), String(b?.guardSig ?? '')))) bad('SIGNATURE', 'Guard signature is missing or does not verify.');

    // 4. Owner signatures.
    if (b?.type === BLOCK.MANDATE) {
      ownerKey = b.data?.publicKeyJwk ?? null;
      const errs = validateMandate(b.data?.mandate);
      if (errs.length) bad('STRUCTURE', `Mandate invalid: ${errs.join('; ')}`);
      if (b.data?.mandate?.id !== bundle.mandateId) bad('STRUCTURE', 'Mandate id differs from the bundle id.');
      if (!ownerKey || !(await verifyText(ownerKey, messages.mandate(b.data.mandate), String(b.data.signature ?? '')))) bad('SIGNATURE', 'Owner signature on the mandate does not verify.');
    }
    if (b?.type === BLOCK.APPROVAL && ownerKey) {
      const rq = state.requests[b.data?.requestId];
      const decisionHash = rq ? blocks[rq.decisionBlock]?.hash : null;
      const msg = messages.approval({ mandateId: bundle.mandateId, requestId: b.data.requestId, decision: b.data.decision, decisionHash });
      if (!decisionHash || !(await verifyText(ownerKey, msg, String(b.data.signature ?? '')))) bad('SIGNATURE', 'Owner approval signature does not verify.');
    }
    if (b?.type === BLOCK.REVOKE && ownerKey) {
      if (!(await verifyText(ownerKey, messages.revoke({ mandateId: bundle.mandateId, headHash: b.prevHash }), String(b.data?.signature ?? '')))) bad('SIGNATURE', 'Owner signature on the revoke does not verify.');
    }

    // 5. Replay the rules. Only meaningful while everything before it is intact.
    if (rec.ok && !broken) {
      for (const msg of checkTransition(state, b)) bad('RULE', msg);
      if (rec.ok) {
        applyBlock(state, b);
        const bv = budgetViolation(state);
        if (bv) bad('RULE', bv);
      }
    }

    if (!rec.ok) { broken = true; if (out.firstBadIndex === null) out.firstBadIndex = i; }
    out.blocks.push(rec);
    prev = b?.hash ?? prev;
  }

  out.headHash = blocks.at(-1)?.hash ?? null;

  // 6. Pinned head: catches a truncated tail or a replaced chain that is internally consistent.
  if (expectedHead) {
    const at = blocks[expectedHead.index];
    if (!at) top('HEAD', `The receipt pinned block ${expectedHead.index}, but the chain now ends at ${blocks.length - 1}: blocks were removed.`);
    else if (at.hash !== expectedHead.hash) top('HEAD', `Block ${expectedHead.index} is not the block this receipt pinned: history was rewritten.`);
  }

  out.summary = state.mandate ? summarize(state) : null;
  out.ok = out.issues.length === 0 && out.blocks.every((x) => x.ok);
  return out;
}
