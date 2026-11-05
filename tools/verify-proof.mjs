#!/usr/bin/env node
// Verify a LedgerTrue proof file on any computer with Node 20+. No server, no network, no dependencies.
//   node tools/verify-proof.mjs ledgertrue-proof-m_xxx.json [--guard <keyId>] [--anchors anchors.json]
// --anchors lets you check against an anchor log you copied earlier from a place the operator cannot edit.
import fs from 'node:fs';
import { verifyProof, verifyAnchors } from '../shared/anchors.js';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };
const guard = flag('--guard');
const anchorFile = flag('--anchors');
const file = args[0];
if (!file) { console.error('usage: node tools/verify-proof.mjs <proof.json> [--guard <keyId>] [--anchors <anchors.json>]'); process.exit(2); }

const input = JSON.parse(fs.readFileSync(file, 'utf8'));
const pr = await verifyProof(input, { expectedGuardFingerprint: guard });
let extra = null;
if (anchorFile) {
  const log = JSON.parse(fs.readFileSync(anchorFile, 'utf8'));
  extra = await verifyAnchors(input.bundle ?? input, log.entries ?? log, (input.bundle ?? input).guard.publicKeyJwk);
}
const ok = pr.ok && (!extra || extra.ok);
const r = pr.chain;
console.log(ok ? 'AUTHENTIC' : 'FAILED');
console.log(`  blocks        : ${r.height}`);
console.log(`  guard key     : ${pr.guardFingerprint}${guard ? (guard === pr.guardFingerprint ? '  (matches --guard)' : '  (DOES NOT match --guard)') : ''}`);
console.log(`  anchors       : ${pr.anchors.count}${pr.anchors.count ? (pr.anchors.ok ? ' (all match the chain)' : ' (MISMATCH)') : ' (none included)'}`);
if (extra) console.log(`  external log  : ${extra.count} anchor(s) checked${extra.ok ? ', all match' : ', MISMATCH'}`);
console.log(`  PayPal proof  : ${pr.witness.witnessed} of ${pr.witness.settlements} settlement(s) carry a hash of PayPal's reply${pr.witness.simulated ? ` (${pr.witness.simulated} simulated)` : ''}`);
for (const b of r.blocks.filter((x) => !x.ok)) console.log(`  block ${b.index} ${b.type}: ${b.issues.map((i) => i.msg).join(' ')}`);
for (const i of [...r.issues, ...pr.anchors.issues.map((m) => ({ msg: m })), ...(extra?.issues ?? []).map((m) => ({ msg: m }))]) console.log(`  ${i.msg ?? i}`);
process.exit(ok ? 0 : 1);
