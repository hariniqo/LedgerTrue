// Public verification page. No login, no app code: it downloads the chain and checks it here, in your browser.
import { h, clear, icon, shortHash, dateTime } from './dom.js';
import { verifyProof } from '/shared/anchors.js';
import { fingerprint } from '/shared/crypto.js';
import { narrate, money } from '/shared/narrate.js';
import { summarize, emptyState, applyBlock } from '/shared/rules.js';

const root = document.getElementById('root');
const id = location.pathname.split('/').pop();
const q = new URLSearchParams(location.search);
const pinned = q.get('h') && q.get('n') ? { hash: q.get('h'), index: Number(q.get('n')) } : null;
const wantGuard = q.get('g');

const result = h('div', {});
const detail = h('div', {});

function show(bundle, pr, source) {
  const r = pr.chain;
  const first = r.blocks.find((b) => !b.ok);
  const st = emptyState(); if (r.ok) bundle.blocks.forEach((b) => applyBlock(st, b));
  const m = bundle.blocks[0]?.data?.mandate;
  const anchorNote = pr.anchors.count ? (pr.anchors.ok ? ` ${pr.anchors.count} signed anchor(s) match the chain exactly.` : '') : ' No anchors were included, so this proves the chain is consistent but not that it matches an earlier public copy.';
  clear(result,
    h('div', { class: `verdict ${pr.ok ? 'ok' : 'bad'}` }, icon(pr.ok ? 'check' : 'x', 30),
      h('div', {}, pr.ok ? 'This receipt is authentic' : 'This receipt failed verification',
        h('small', {}, pr.ok
          ? `All ${r.height} blocks are intact, signed and consistent with the mandate's rules${pinned ? ', and the chain still ends exactly where the receipt pinned it' : ''}.${anchorNote}`
          : (first ? `Block ${first.index} (${first.type}): ${first.issues.map((i) => i.msg).join(' ')}` : [...r.issues, ...pr.anchors.issues].map((i) => i.msg ?? i).join(' '))))));
  if (!m) { clear(detail); return; }
  const s = summarize(st);
  const n = narrate(bundle.blocks);
  clear(detail,
    h('section', { class: 'section' }, h('header', {}, h('h2', {}, m.title)), h('p', { class: 'muted' }, m.goal)),
    r.ok ? h('dl', { class: 'kv', style: { marginTop: '16px' } },
      h('dt', {}, 'Budget'), h('dd', {}, money(m.budgetCents, m.currency)),
      h('dt', {}, 'Settled'), h('dd', {}, money(s.settledCents, m.currency)),
      h('dt', {}, 'On hold'), h('dd', {}, money(s.heldCents, m.currency)),
      h('dt', {}, 'Still free'), h('dd', {}, money(s.availableCents, m.currency)),
      h('dt', {}, 'Valid until'), h('dd', {}, s.revoked ? 'Revoked by the owner' : dateTime(m.expiresAt)),
      h('dt', {}, 'Guard key'), h('dd', { class: 'mono' }, r.guardFingerprint),
      h('dt', {}, 'Chain head'), h('dd', { class: 'mono' }, `block ${r.height - 1}, ${shortHash(r.headHash, 16)}`),
      h('dt', {}, 'Anchors'), h('dd', {}, pr.anchors.count ? `${pr.anchors.count} signed, latest #${pr.anchors.latest.seq} at ${dateTime(pr.anchors.latest.ts)}` : 'none included'),
      h('dt', {}, 'PayPal evidence'), h('dd', {}, pr.witness.settlements === 0 ? 'no settlements yet' : `${pr.witness.witnessed} of ${pr.witness.settlements} settlement(s) carry a hash of PayPal's own reply${pr.witness.simulated ? ` (${pr.witness.simulated} simulated)` : ''}`),
      h('dt', {}, 'Checked'), h('dd', {}, source)) : null,
    r.ok ? h('section', { class: 'section' }, h('header', {}, h('h2', {}, 'What happened')),
      h('div', { class: 'story' }, n.stories.map((x) => h('div', {}, h('h3', {}, x.title), h('ol', {}, x.steps.map((y) => h('li', { class: y.kind }, y.text)))))) ) : null);
}

async function fromServer() {
  try {
    const [proof, guard] = await Promise.all([
      fetch(`/api/mandates/${encodeURIComponent(id)}/proof`).then((r) => { if (!r.ok) throw new Error(r.status === 404 ? 'No receipt with this id exists on this server.' : 'The server could not return the receipt.'); return r.json(); }),
      fetch('/.well-known/ledgertrue-guard.json').then((r) => r.json()),
    ]);
    // The receipt pins which guard key signed it. The origin's published key must match, or someone swapped the chain.
    const expectedGuardFingerprint = wantGuard || guard.keyId;
    if (wantGuard && wantGuard !== guard.keyId) throw new Error('This receipt was issued under a different guard key than this server now uses.');
    const pr = await verifyProof(proof, { expectedHead: pinned, expectedGuardFingerprint });
    show(proof.bundle, pr, 'in your browser, just now');
  } catch (e) {
    clear(result, h('div', { class: 'verdict bad' }, icon('x', 30), h('div', {}, 'Could not verify', h('small', {}, e.message))));
  }
}

const paste = h('textarea', { placeholder: 'Paste a proof file or bundle (JSON), or choose the file below. Nothing is sent to any server.', 'aria-label': 'Proof JSON' });
const pick = h('input', { type: 'file', accept: 'application/json,.json', 'aria-label': 'Proof file' });
pick.onchange = async () => { const f = pick.files?.[0]; if (f) { paste.value = await f.text(); checkPasted.click(); } };
const checkPasted = h('button', {}, 'Verify pasted proof');
checkPasted.onclick = async () => {
  try {
    const input = JSON.parse(paste.value);
    const pr = await verifyProof(input, { expectedGuardFingerprint: wantGuard || null });
    show(input.bundle ?? input, pr, 'from the data you gave it, in your browser');
  } catch (e) { clear(result, h('div', { class: 'verdict bad' }, icon('x', 30), h('div', {}, 'Not a valid bundle', h('small', {}, e.message)))); }
};

clear(root,
  h('div', { class: 'vbrand' }, h('span', { class: 'mark' }, icon('shield', 18)), 'LedgerTrue Proof Card'),
  h('h1', { style: { marginBottom: '18px' } }, 'Check this receipt yourself'),
  result, detail,
  h('section', { class: 'section' }, h('header', {}, h('h2', {}, 'Verify without trusting this server')),
    h('p', { class: 'muted small', style: { marginBottom: '10px' } }, 'Download the proof file (the chain plus its signed anchors), then check it here or with tools/verify-proof.mjs on any computer. Everything is recomputed locally from the data you give it.'),
    paste, h('div', { class: 'row', style: { marginTop: '10px' } }, checkPasted, pick, h('a', { class: 'btn', href: `/api/mandates/${encodeURIComponent(id)}/proof`, download: `ledgertrue-proof-${id}.json` }, 'Download proof file'))),
  h('p', { class: 'muted small', style: { marginTop: '28px' } }, 'Demo-grade: a hash chain proves the record was not edited after the fact. It does not prove the guard key is honest on its own. Anchors close most of that gap once copies of them live somewhere the operator cannot edit. PayPal evidence is a hash of the reply PayPal sent, not a PayPal signature.'));

clear(result, h('div', { class: 'verdict wait' }, icon('shield', 30), h('div', {}, 'Checking…')));
fromServer();
