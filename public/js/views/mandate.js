import { h, clear, put, icon, svg, toast, busy, copyText, shortHash, clock, dateTime } from '../dom.js';
import { api, toMinor } from '../api.js';
import { budgetBar, statusChip, money, CHECK_LABELS } from '../format.js';
import { ownerMatches } from '../mandateTools.js';
import { qrMatrix, qrPath } from '../qr.js';
import { messages, fingerprint } from '/shared/crypto.js';
import { verifyBundle, blockHash } from '/shared/verify.js';
import { verifyProof, witnessSummary } from '/shared/anchors.js';
import { emptyState, applyBlock, summarize } from '/shared/rules.js';
import { narrate, reasonText } from '/shared/narrate.js';

const witnessLine = (w) => (w.settlements === 0 ? 'no settlements yet' : `${w.witnessed} of ${w.settlements} settlement(s) carry a hash of PayPal's own reply${w.simulated ? ` (${w.simulated} simulated)` : ''}`);

const HELPER = { ai_agent: 'AI agent', child: 'Child', employee: 'Employee' };

const derive = (blocks) => { const s = emptyState(); blocks.forEach((b) => applyBlock(s, b)); return s; };

export function blockSummary(b, cur) {
  const d = b.data ?? {};
  switch (b.type) {
    case 'MANDATE': return `${d.mandate.title}: budget ${money(d.mandate.budgetCents, cur)}, signed by owner key`;
    case 'REQUEST': return `${d.agentId} asks ${money(d.amountCents, cur)} at ${d.merchant}`;
    case 'DECISION': return `${d.outcome === 'APPROVED' ? 'Approved' : d.outcome === 'BLOCKED' ? 'Blocked' : 'Needs owner'}${d.reasons.length ? ': ' + d.reasons.map(reasonText).join(', ') : ''}`;
    case 'APPROVAL': return `Owner ${d.decision === 'APPROVE' ? 'approved' : 'rejected'} with a signature`;
    case 'HOLD': return `${money(d.amountCents, cur)} held (${d.gateway === 'paypal' ? 'PayPal authorization' : 'simulated'} ${d.authId ?? ''})`;
    case 'CAPTURE': return `${money(d.amountCents, cur)} settled${d.via === 'reconciler-poll' ? ' (confirmed by polling PayPal)' : ''}${d.witness?.evidenceHash ? `, PayPal evidence ${d.witness.evidenceHash.slice(0, 10)}…` : ''}`;
    case 'VOID': return `Hold released: ${d.reason}`;
    case 'RECON': return d.note;
    case 'REVOKE': return 'Owner revoked the mandate';
    default: return '';
  }
}

let paypalLoading;
function loadPayPal(clientId, currency) {
  if (window.paypal) return Promise.resolve(window.paypal);
  paypalLoading ??= new Promise((resolve, reject) => {
    const s = h('script', { src: `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&intent=authorize&currency=${encodeURIComponent(currency)}&components=buttons` });
    s.onload = () => resolve(window.paypal);
    s.onerror = () => { paypalLoading = null; reject(new Error('PayPal SDK failed to load')); };
    document.head.append(s);
  });
  return paypalLoading;
}

export async function mandateDetail(ctx, id, tab) {
  let data = await api('GET', `/api/mandates/${id}`);
  const body = h('div', {});
  const head = h('div', {});
  const cur = () => data.summary.currency;

  const refetch = async () => { data = await api('GET', `/api/mandates/${id}`); renderHead(); renderBody(); };
  let timer;
  const onBlock = (e) => { if (e.detail.mandateId !== id) return; clearTimeout(timer); timer = setTimeout(() => refetch().catch(() => {}), 150); };
  ctx.bus.addEventListener('block', onBlock);

  // ---------- header ----------
  function renderHead() {
    const s = data.summary;
    const mine = ctx.owner && data.bundle.blocks[0].data.publicKeyJwk.x === ctx.owner.publicKeyJwk.x;
    const revoke = h('button', { class: 'danger' }, 'Revoke mandate');
    revoke.onclick = busy(revoke, 'Signing…', async () => {
      if (!confirm('Revoke this mandate? New requests are blocked from now on. Holds already placed are not affected.')) return;
      const fresh = await api('GET', `/api/mandates/${id}/bundle`);
      const sig = await ctx.owner.sign(messages.revoke({ mandateId: id, headHash: fresh.head.hash }));
      await api('POST', `/api/mandates/${id}/revoke`, { signature: sig });
      toast('Mandate revoked');
    });
    clear(head,
      h('div', { class: 'page-head', style: { marginBottom: '0' } },
        h('div', {},
          h('h1', {}, s.title),
          h('p', {}, s.goal),
          h('div', { class: 'row', style: { marginTop: '12px' } },
            h('span', { class: 'chip' }, HELPER[s.helper] ?? s.helper),
            s.revoked ? h('span', { class: 'chip bad' }, 'Revoked') : h('span', { class: 'chip ok' }, `Valid until ${dateTime(s.expiresAt)}`),
            s.quarantined ? h('span', { class: 'chip bad' }, 'Failed integrity check') : null)),
        !s.revoked && mine ? revoke : null),
      h('nav', { class: 'tabs', 'aria-label': 'Mandate sections' },
        [['activity', 'Activity'], ['chain', 'Chain and verify'], ['proof', 'Proof Card']].map(([k, label]) =>
          h('a', { href: k === 'activity' ? `#/m/${id}` : `#/m/${id}/${k}`, 'aria-current': k === tab ? 'page' : null }, label)),
        h('a', { href: `#/intel/${id}` }, 'Intelligence')));
  }

  // ---------- activity ----------
  const agentForm = () => {
    const f = {
      agent: h('input', { value: 'shopper-1', required: true }),
      merchant: h('input', { value: data.bundle.blocks[0].data.mandate.allowedMerchants[0], required: true }),
      amount: h('input', { value: '1000', inputmode: 'decimal', required: true }),
      item: h('input', { value: 'Laptop for the design team' }),
      reason: h('input', { value: 'Replace the failing laptop for the design team', required: true }),
    };
    const send = h('button', { class: 'primary', type: 'submit' }, 'Send request');
    return h('details', { class: 'panel pad' },
      h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, 'Send a request as an agent'),
      h('form', {
        style: { marginTop: '16px' },
        onsubmit: async (e) => {
          e.preventDefault();
          await busy(send, 'Checking rules…', async () => {
            const r = await api('POST', `/api/mandates/${id}/requests`, { agentId: f.agent.value, merchant: f.merchant.value, amountCents: toMinor(f.amount.value), item: f.item.value, reason: f.reason.value, category: 'office' });
            toast(r.outcome === 'BLOCKED' ? `Blocked: ${r.reasons.map(reasonText).join(', ')}` : r.outcome === 'NEEDS_APPROVAL' ? 'Paused for the owner to sign' : 'Approved and on hold');
          })();
        },
      },
      h('div', { class: 'form-grid' },
        h('label', {}, 'Agent', f.agent), h('label', {}, 'Merchant', f.merchant),
        h('label', {}, `Amount (${cur()})`, f.amount), h('label', {}, 'Item', f.item),
        h('label', { class: 'wide' }, 'Reason the agent gives', f.reason)),
      h('div', { class: 'row', style: { marginTop: '16px' } }, send, h('span', { class: 'muted small' }, 'Text the agent writes is scanned for instructions that try to change the rules.'))));
  };

  function requestRow(rq, mineOwner) {
    const bundle = data.bundle;
    const decision = bundle.blocks[rq.decisionBlock];
    const checks = decision?.data.checks ?? [];
    const actions = h('div', { class: 'row' });

    if (rq.status === 'PENDING_APPROVAL') {
      const decide = (decision_) => async function () {
        await busy(this, 'Signing…', async () => {
          const signature = await ctx.owner.sign(messages.approval({ mandateId: id, requestId: rq.id, decision: decision_, decisionHash: decision.hash }));
          await api('POST', `/api/mandates/${id}/requests/${rq.id}/approval`, { decision: decision_, signature });
          toast(decision_ === 'APPROVE' ? 'Approved with your signature' : 'Rejected');
        })();
      };
      put(actions, [
        h('button', { class: 'primary', disabled: !mineOwner, onclick: decide('APPROVE') }, icon('key', 16), 'Approve and sign'),
        h('button', { class: 'danger', disabled: !mineOwner, onclick: decide('REJECT') }, 'Reject'),
        mineOwner ? null : h('span', { class: 'muted small' }, 'Only the browser that holds the owner key can sign.')]);
    }
    const pend = data.pending?.[rq.id];
    if (rq.status === 'APPROVED' && pend) {
      const slot = h('div', { class: 'paypal-slot' }, h('span', { class: 'muted small' }, 'Loading PayPal…'));
      loadPayPal(ctx.cfg.paypalClientId, cur()).then((pp) => {
        clear(slot);
        pp.Buttons({
          style: { layout: 'horizontal', height: 40, tagline: false },
          createOrder: () => pend.orderId,
          onApprove: async () => { await api('POST', `/api/mandates/${id}/requests/${rq.id}/paypal-authorize`, { orderId: pend.orderId }); toast('PayPal authorized the hold'); },
          onError: (err) => toast(`PayPal: ${err.message ?? err}`, 'error'),
        }).render(slot);
      }).catch((e) => clear(slot, h('span', { class: 'muted small' }, e.message)));
      put(actions, [h('div', {}, h('div', { class: 'small muted', style: { marginBottom: '6px' } }, 'Approve this hold in PayPal to place it'), slot)]);
    }
    if (rq.status === 'HELD') {
      const settle = h('button', { class: 'primary' }, 'Settle (capture)');
      settle.onclick = busy(settle, 'Settling…', async () => {
        const r = await api('POST', `/api/mandates/${id}/requests/${rq.id}/capture`, {});
        toast(r.capture?.status === 'RECOVERED' ? 'The reply was lost, PayPal confirmed it, settled once' : r.capture?.status === 'UNKNOWN' ? r.capture.note : 'Settled');
      });
      const release = h('button', {}, 'Release hold');
      release.onclick = busy(release, 'Releasing…', async () => { await api('POST', `/api/mandates/${id}/requests/${rq.id}/void`, { reason: 'released by operator' }); toast('Hold released, budget restored'); });
      put(actions, [settle, release]);
    }

    const amountLabel = rq.status === 'SETTLED' ? money(rq.capturedCents, cur()) : money(rq.amountCents, cur());
    return h('div', { class: 'req' },
      h('div', { class: 'req-top' },
        h('div', {}, h('span', { class: 'req-title' }, `${rq.agentId} at ${rq.merchant}`), ' ', h('span', { class: 'muted small' }, clock(rq.ts))),
        h('div', { class: 'row' }, h('span', { class: 'req-amount' }, amountLabel), statusChip(rq.status))),
      h('div', { class: 'req-reason' }, rq.data.item ? `${rq.data.item}. ` : '', `"${rq.data.reason}"`),
      decision?.data.reasons.length ? h('div', { class: 'row' }, decision.data.reasons.map((c) => h('span', { class: `chip ${decision.data.outcome === 'BLOCKED' ? 'bad' : 'warn'}` }, reasonText(c)))) : null,
      actions.children.length ? actions : null,
      h('details', { class: 'checks' }, h('summary', {}, 'Rule checks'),
        checks.map((c) => h('div', { class: `check ${c.pass ? 'pass' : 'fail'} ${c.hard ? '' : 'soft'}` },
          icon(c.pass ? 'check' : c.hard ? 'x' : 'alert', 16),
          h('div', {}, CHECK_LABELS[c.code] ?? c.code, h('div', { class: 'detail' }, c.detail))))));
  }

  function activity() {
    const st = derive(data.bundle.blocks);
    const sum = summarize(st);
    const mineOwner = Boolean(ctx.owner && data.bundle.blocks[0].data.publicKeyJwk.x === ctx.owner.publicKeyJwk.x);
    const reqs = Object.values(st.requests).sort((a, b) => b.requestBlock - a.requestBlock);
    const waiting = reqs.filter((r) => r.status === 'PENDING_APPROVAL').length;
    return h('div', {},
      h('div', { class: 'panel pad' }, budgetBar(sum, cur())),
      waiting ? h('div', { class: 'callout warn', style: { marginTop: '16px' } }, icon('key'), h('div', {}, h('strong', {}, `${waiting} request${waiting > 1 ? 's' : ''} waiting for your signature. `), 'The budget is reserved until you approve or reject.')) : null,
      h('section', { class: 'section' },
        h('header', {}, h('h2', {}, 'Requests'), h('span', { class: 'muted small' }, `${reqs.length} in total`)),
        reqs.length ? h('div', { class: 'panel pad' }, reqs.map((r) => requestRow(r, mineOwner))) : h('div', { class: 'empty' }, h('p', {}, 'No requests yet. Agents ask here before they spend.'))),
      h('section', { class: 'section' }, agentForm()));
  }

  // ---------- chain ----------
  function chain() {
    let work = structuredClone(data.bundle);
    const pin = { index: data.bundle.head.index, hash: data.bundle.head.hash };
    const verdict = h('div', {});
    const tape = h('div', { class: 'tape', role: 'list', 'aria-label': 'Blocks in the chain' });
    let result = null;

    const verdictView = (r) => {
      if (!r) return h('div', { class: 'verdict wait' }, icon('shield', 30), h('div', {}, 'Not verified yet', h('small', {}, 'Press Verify to recompute every hash and signature in this browser.')));
      if (r.ok) return h('div', { class: 'verdict ok' }, icon('check', 30), h('div', {}, `Verified: ${r.height} blocks intact`, h('small', {}, `Every hash links, every guard signature checks out (key ${r.guardFingerprint}), the owner's signatures match, and the guard's decisions replay exactly under the mandate's rules.`)));
      const first = r.blocks.find((b) => !b.ok);
      return h('div', { class: 'verdict bad' }, icon('x', 30), h('div', {}, first ? `Verification failed at block ${first.index}` : 'Verification failed', h('small', {}, first ? first.issues.map((i) => i.msg).join(' ') : r.issues.map((i) => i.msg).join(' '))));
    };

    const drawTape = (r, states = {}) => {
      clear(tape);
      work.blocks.forEach((b, i) => {
        const res = r?.blocks[i];
        const afterBreak = r && r.firstBadIndex !== null && i > r.firstBadIndex && res?.ok;
        const cls = states[i] ?? (afterBreak ? 'skipped' : res ? (res.ok ? 'good' : 'broken') : '');
        tape.append(h('div', { class: `blk ${cls}`, role: 'listitem', 'data-k': b.type },
          h('div', { class: 'blk-head' }, h('span', { class: 'blk-type' }, `${i}  ${b.type.charAt(0) + b.type.slice(1).toLowerCase()}`), h('span', { class: 'blk-hash' }, shortHash(b.hash, 12)), h('span', { class: 'muted small' }, clock(b.ts))),
          h('div', { class: 'blk-sum' }, blockSummary(b, cur())),
          afterBreak ? h('div', { class: 'muted small' }, 'Intact on its own, but it follows a broken block, so it cannot be trusted.') : null,
          res && !res.ok ? h('div', { class: 'issues' }, res.issues.map((x) => h('div', {}, `${x.kind}: ${x.msg}`))) : null,
          h('details', {}, h('summary', {}, 'Show block data'), h('pre', { class: 'json' }, JSON.stringify(b, null, 2)))));
      });
      const headIssue = r?.issues.find((x) => x.kind === 'HEAD');
      if (headIssue) tape.append(h('div', { class: 'cut' }, headIssue.msg));
    };

    const run = async () => {
      const r = await verifyBundle(work, { expectedHead: pin, expectedGuardFingerprint: ctx.cfg.guard.keyId });
      // Sweep through the tape so the check is something you can watch happen.
      const states = {};
      const stop = r.firstBadIndex ?? work.blocks.length;
      for (let i = 0; i < Math.min(work.blocks.length, 80); i++) {
        states[i] = 'checking'; drawTape(null, { ...states });
        await new Promise((res) => setTimeout(res, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 28));
        states[i] = i < stop ? 'good' : i === stop ? 'broken' : 'skipped';
      }
      result = r;
      clear(verdict, verdictView(r));
      drawTape(r);
    };

    const tamper = (fn) => async () => {
      const i = work.blocks.findIndex((b) => b.type === 'REQUEST');
      if (i < 0) { toast('Add a request first, then try to tamper with it.', 'error'); return; }
      await fn(i);
      await run();
    };
    const btnVerify = h('button', { class: 'primary' }, icon('shield', 16), 'Verify in this browser');
    btnVerify.onclick = busy(btnVerify, 'Verifying…', run);

    const editAmount = tamper(async (i) => { work.blocks[i].data.amountCents = Math.max(1, Math.floor(work.blocks[i].data.amountCents / 2)); });
    const editRehash = tamper(async (i) => { work.blocks[i].data.amountCents = Math.max(1, Math.floor(work.blocks[i].data.amountCents / 2)); work.blocks[i].hash = await blockHash(work.blocks[i]); });
    const cut = async () => { if (work.blocks.length < 2) return; work.blocks.pop(); await run(); };
    const restore = () => { work = structuredClone(data.bundle); result = null; clear(verdict, verdictView(null)); drawTape(null); };

    clear(verdict, verdictView(null));
    drawTape(null);
    return h('div', {},
      h('div', { class: 'callout' }, icon('link'), h('div', {}, 'Each block stores the hash of the one before it and is signed by the guard. Change one character anywhere and the chain breaks from that point on. Checking happens here in your browser, using the same code the server uses.')),
      h('div', { class: 'row', style: { margin: '18px 0 14px' } }, btnVerify),
      verdict,
      h('section', { class: 'section' },
        h('header', {}, h('h2', {}, 'Tamper lab'), h('span', { class: 'muted small' }, 'Edits a copy in this page only. The server\'s chain is never touched.')),
        h('div', { class: 'row' },
          h('button', { onclick: editAmount }, 'Halve a request amount'),
          h('button', { onclick: editRehash }, 'Halve it and recompute the hash'),
          h('button', { onclick: cut }, 'Remove the last block'),
          h('button', { class: 'ghost', onclick: restore }, 'Restore the original'))),
      h('section', { class: 'section' }, h('header', {}, h('h2', {}, 'Blocks'), h('span', { class: 'muted small' }, `${work.blocks.length} in this copy`)), h('div', { class: 'panel pad' }, tape)));
  }

  // ---------- proof card ----------
  function proof() {
    const b = data.bundle;
    const url = `${location.origin}/verify/${id}?h=${b.head.hash}&n=${b.head.index}&g=${ctx.cfg.guard.keyId}`;
    const verdict = h('div', {}, h('div', { class: 'verdict wait' }, icon('shield', 30), h('div', {}, 'Checking the chain…')));
    const anchorRow = h('dd', {}, 'checking…');
    const evidenceRow = h('dd', {}, witnessLine(witnessSummary(b.blocks)));
    api('GET', `/api/mandates/${id}/proof`).then((proof) => verifyProof(proof, { expectedHead: b.head, expectedGuardFingerprint: ctx.cfg.guard.keyId })).then((pr) => {
      const r = pr.chain;
      anchorRow.textContent = pr.anchors.count ? (pr.anchors.ok ? `${pr.anchors.count} signed, latest #${pr.anchors.latest.seq}` : 'MISMATCH: ' + pr.anchors.issues[0]) : 'none yet';
      clear(verdict, h('div', { class: `verdict ${pr.ok ? 'ok' : 'bad'}` }, icon(pr.ok ? 'check' : 'x', 30),
        h('div', {}, pr.ok ? 'Verified' : 'Verification failed', h('small', {}, pr.ok ? `${r.height} blocks. Hashes, signatures, rule replay${pr.anchored ? ' and signed anchors' : ''} all check out.` : (r.blocks.find((x) => !x.ok)?.issues[0].msg ?? r.issues[0]?.msg ?? pr.anchors.issues[0])))));
    }).catch((e) => { anchorRow.textContent = e.message; });

    const m = qrMatrix(url);
    const qr = svg('svg', { viewBox: `0 0 ${m.length} ${m.length}`, class: 'qr', role: 'img', 'aria-label': 'QR code that opens the public verification page', 'shape-rendering': 'crispEdges' }, svg('path', { d: qrPath(m), fill: '#0b1f44' }));

    const story = narrate(b.blocks);
    const aiBox = h('div', {});
    const explain = h('button', { class: 'no-print' }, 'Write a plain-English summary');
    explain.onclick = busy(explain, 'Writing…', async () => {
      const r = await api('POST', `/api/mandates/${id}/explain`, {});
      clear(aiBox, h('div', { class: 'note' }, r.note), h('p', { class: 'muted small', style: { marginTop: '6px' } }, r.source === 'llm' ? 'Rewritten by an AI model from the facts above. Every number, ID and link in it was checked against the chain. AI can make mistakes; verify important details against the records. It cannot move money or change the chain.' : (r.rejected ? 'The AI wording was discarded because it did not match the facts, so this is the plain version built from the chain.' : 'Built from the chain itself, no AI involved.')));
    });
    const ownerFp = h('span', { class: 'mono' }, '…');
    fingerprint(b.blocks[0].data.publicKeyJwk).then((fp) => { ownerFp.textContent = fp; });
    const sum = summarize(derive(b.blocks));

    return h('div', { class: 'proof' },
      h('div', {},
        verdict,
        h('section', { class: 'section', style: { marginTop: '22px' } },
          h('header', {}, h('h2', {}, story.headline)),
          h('div', { class: 'story' }, story.stories.length ? story.stories.map((s) =>
            h('div', {}, h('h3', {}, s.title), h('ol', {}, s.steps.map((x) => h('li', { class: x.kind }, x.text)))))
            : h('p', { class: 'muted' }, 'No requests have been made yet.'))),
        h('section', { class: 'section' }, h('header', {}, h('h2', {}, 'Facts')),
          h('dl', { class: 'kv' },
            h('dt', {}, 'Settled'), h('dd', {}, money(sum.settledCents, cur())),
            h('dt', {}, 'Owner key'), h('dd', {}, ownerFp),
            h('dt', {}, 'Guard key'), h('dd', { class: 'mono' }, ctx.cfg.guard.keyId),
            h('dt', {}, 'Chain head'), h('dd', { class: 'mono' }, `block ${b.head.index}, ${shortHash(b.head.hash, 16)}`),
            h('dt', {}, 'Anchors'), anchorRow,
            h('dt', {}, 'PayPal evidence'), evidenceRow)),
        h('div', { style: { marginTop: '22px' } }, explain, aiBox)),
      h('aside', { class: 'seal' },
        qr,
        h('div', {}, h('strong', {}, 'Scan to verify'), h('div', { class: 'muted small' }, 'Opens a public page that checks the chain with no login.')),
        h('div', { class: 'row no-print', style: { justifyContent: 'center' } },
          h('button', { onclick: () => copyText(url) }, 'Copy link'),
          h('button', { onclick: () => print() }, 'Print'),
          h('a', { class: 'btn', href: `/api/mandates/${id}/proof`, download: `ledgertrue-proof-${id}.json` }, 'Download proof file'))));
  }

  renderHead();
  const renderBody = () => clear(body, tab === 'chain' ? chain() : tab === 'proof' ? proof() : activity());
  renderBody();
  return { el: h('div', {}, head, body), title: data.summary.title, destroy: () => ctx.bus.removeEventListener('block', onBlock) };
}
