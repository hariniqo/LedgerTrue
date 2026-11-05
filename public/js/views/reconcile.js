import { h, clear, icon, toast, busy, clock } from '../dom.js';
import { api } from '../api.js';
import { money } from '../format.js';

const WEAK = new Set(['CLIENT.TIMEOUT', 'CLIENT.ERROR']);
const CHIP = { SUCCESS: 'ok', VERIFIED: 'ok', FAILED: 'bad', REVERSED: 'bad', RECONCILE: 'bad', UNKNOWN: 'warn', PENDING: 'warn', DISPUTED: 'warn', REFUNDED: '', PARTIALLY_REFUNDED: '', INITIATED: 'hold', PROCESSING: 'hold' };

export async function reconcile(ctx) {
  const initial = await api('GET', '/api/state');
  const payments = new Map(initial.payments.map((p) => [p.paymentId, p]));
  const notes = new Map();
  let selected = null;
  let stats = initial.stats;

  const feed = h('div', { class: 'feed', 'aria-live': 'polite' });
  const list = h('div', {});
  const ledger = h('div', {});
  const statLine = h('div', { class: 'row' });
  const search = h('input', { type: 'search', placeholder: 'Search ID or anomaly', 'aria-label': 'Search payments', oninput: () => renderPayments() });
  const stateFilter = h('select', { 'aria-label': 'Filter payments by state', onchange: () => renderPayments() },
    h('option', { value: '' }, 'All states'),
    ['SUCCESS', 'VERIFIED', 'PENDING', 'UNKNOWN', 'RECONCILE', 'DISPUTED', 'FAILED', 'REFUNDED', 'REVERSED'].map((state) => h('option', { value: state }, state)));

  const scenario = h('select', { 'aria-label': 'Scenario' }, h('option', { value: 'all' }, 'All scenarios at once'), initial.scenarios.map((s) => h('option', { value: s.key, title: s.blurb }, s.title)));
  const run = h('button', { class: 'primary', disabled: !ctx.cfg?.demo }, icon('play', 16), 'Inject chaos');
  run.onclick = busy(run, 'Starting…', () => api('POST', '/api/chaos', { scenario: scenario.value }));
  const reset = h('button', { disabled: !ctx.cfg?.demo }, 'Reset demo');
  reset.onclick = busy(reset, 'Resetting…', async () => { await api('POST', '/api/reset'); toast('Reset. The old log was archived, not deleted.'); });

  const emptyFeed = () => h('div', { class: 'empty' }, h('p', {}, 'Pick a scenario and press Inject chaos. Raw signals appear here in the order they arrive.'));
  clear(feed, emptyFeed());

  function renderStats() {
    const ls = Object.values(stats.ledger);
    const sumOf = (k) => ls.map((l) => money(l[k], l.currency)).join(' + ') || money(0, 'USD');
    const all = [...payments.values()];
    clear(statLine,
      h('span', { class: 'chip' }, `${all.length} payments`),
      h('span', { class: 'chip ok' }, `Available ${sumOf('available')}`),
      h('span', { class: 'chip' }, `Pending ${sumOf('pending')}`),
      h('span', { class: 'chip' }, `Held ${sumOf('held')}`),
      h('span', { class: 'chip hold' }, `${all.filter((p) => p.ghost).length} ghost balances caught`),
      h('span', { class: `chip ${all.some((p) => p.state === 'RECONCILE') ? 'bad' : ''}` }, `${all.filter((p) => p.state === 'RECONCILE').length} need review`),
      h('span', { class: `chip ${stats.invariants.ok ? 'ok' : 'bad'}` }, stats.invariants.ok ? 'Ledger balances to zero' : 'LEDGER OUT OF BALANCE'));
  }

  function addRaw(r) {
    if (feed.querySelector('.empty')) clear(feed);
    feed.prepend(h('div', { class: `ev ${r.source} ${r.duplicate ? 'dup' : ''} ${WEAK.has(r.type) ? 'weak' : ''}` },
      h('div', { class: 't' }, h('b', {}, `${r.type}${r.duplicate ? ' (duplicate)' : ''}`), h('span', {}, r.amountCents != null ? money(r.amountCents, r.currency) : '')),
      h('div', { class: 'muted small' }, `${r.paymentId} · ${r.source.replace('_', ' ')} · happened ${clock(r.ts)}`)));
    while (feed.children.length > 80) feed.lastChild.remove();
  }

  function payRow(p) {
    const same = p.naive.state === p.state;
    const open = p.paymentId === selected;
    const visible = p.anomalies.filter((a) => a.severity !== 'info' || open);
    const actions = open ? h('div', { class: 'row' },
      (() => { const b = h('button', {}, 'Explain'); b.onclick = busy(b, 'Writing…', async () => { notes.set(p.paymentId, await api('POST', `/api/payments/${encodeURIComponent(p.paymentId)}/explain`)); renderPayments(); }); return b; })(),
      (() => { const b = h('button', {}, 'Ask PayPal now'); b.onclick = busy(b, 'Asking…', () => api('POST', `/api/payments/${encodeURIComponent(p.paymentId)}/verify`)); return b; })()) : null;
    const note = open && notes.get(p.paymentId);
    return h('div', { class: 'pay' },
      h('div', { class: 'top' },
        h('button', { class: 'ghost', style: { fontWeight: 650, color: 'inherit' }, 'aria-expanded': open, onclick: () => { selected = open ? null : p.paymentId; renderPayments(); } }, `${p.paymentId}  ${money(p.amountCents, p.currency)}`),
        h('span', { class: `chip ${CHIP[p.state] ?? ''}` }, p.state)),
      h('div', { class: 'vs' },
        h('div', { class: `naive ${same ? 'same' : ''}` }, h('b', {}, 'A typical integration shows'), `${p.naive.state}, ${money(p.naive.balanceCents, p.currency)}`),
        h('div', { class: 'true' }, h('b', {}, 'LedgerTrue shows'), `${p.state}, ${money(p.ledger.available + p.ledger.pending + p.ledger.held, p.currency)} booked`)),
      visible.map((a) => h('div', { class: 'small' }, h('strong', {}, a.code), ' ', a.message)),
      h('div', { class: 'small' }, 'Next: ', h('strong', {}, p.recommended.label)),
      actions,
      note ? h('div', { class: 'note' }, note.note, h('div', { class: 'muted small', style: { marginTop: '6px' } }, note.source === 'nvidia' ? 'Written by an AI model from the reconciled facts. Its numbers and IDs were checked against them. AI can make mistakes; verify important details against the records.' : (note.rejected ? 'AI wording discarded (it did not match the facts). Built-in note shown.' : 'Built-in deterministic note'))) : null);
  }

  function renderPayments() {
    const all = [...payments.values()].sort((a, b) => (b.firstEventTs ?? 0) - (a.firstEventTs ?? 0));
    const term = search.value.trim().toLowerCase();
    const filtered = all.filter((p) => (!stateFilter.value || p.state === stateFilter.value)
      && (!term || `${p.paymentId} ${p.state} ${p.anomalies.map((a) => a.message).join(' ')}`.toLowerCase().includes(term)));
    clear(list, filtered.length ? filtered.map(payRow) : h('div', { class: 'empty' }, h('p', {}, all.length ? 'No payments match these filters.' : 'No payments yet.')));
  }

  async function renderLedger() {
    const d = await api('GET', '/api/ledger');
    clear(ledger, h('div', { class: 'panel scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, ['#', 'Payment', 'Debit', 'Credit'].map((x) => h('th', {}, x)), h('th', { class: 'num' }, 'Amount'))),
      h('tbody', {}, d.entries.slice(0, 40).map((e) => h('tr', {}, h('td', {}, e.id), h('td', { class: 'mono' }, e.paymentId), h('td', {}, e.debit), h('td', {}, e.credit), h('td', { class: 'num' }, money(e.amountCents, e.currency))))))));
  }
  let lt;
  const later = () => { clearTimeout(lt); lt = setTimeout(() => renderLedger().catch(() => {}), 250); };

  const onRaw = (e) => addRaw(e.detail);
  const onPay = (e) => { payments.set(e.detail.snapshot.paymentId, e.detail.snapshot); stats = e.detail.stats; renderPayments(); renderStats(); later(); };
  const onReset = (e) => { payments.clear(); notes.clear(); selected = null; stats = e.detail; clear(feed, emptyFeed()); renderPayments(); renderStats(); later(); };
  ctx.bus.addEventListener('raw', onRaw); ctx.bus.addEventListener('payment', onPay); ctx.bus.addEventListener('reset', onReset);

  renderStats(); renderPayments(); renderLedger();

  const el = h('div', {},
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Reconciliation'), h('p', {}, 'Payment systems disagree, repeat themselves and arrive out of order. This engine replays the immutable log into one trusted state per payment, and double-entry bookkeeping proves no money was created or lost.')),
      h('div', { class: 'row' }, scenario, run, reset)),
    statLine,
    h('div', { class: 'cols', style: { marginTop: '22px' } },
      h('section', {}, h('header', { class: 'section', style: { marginTop: 0 } }, h('h2', {}, 'Raw signals')), h('p', { class: 'muted small', style: { margin: '4px 0 10px' } }, 'What a naive integration sees, in arrival order.'), feed),
      h('section', {}, h('header', { class: 'section', style: { marginTop: 0 } }, h('h2', {}, 'Reconciled truth')), h('p', { class: 'muted small', style: { margin: '4px 0 10px' } }, 'Filter by status or search an ID and open a payment for its explanation.'), h('div', { class: 'row reconcile-filters' }, search, stateFilter), list)),
    h('section', { class: 'section' }, h('header', {}, h('h2', {}, 'Double-entry ledger')), ledger));
  return { el, title: 'Reconciliation', destroy: () => { ctx.bus.removeEventListener('raw', onRaw); ctx.bus.removeEventListener('payment', onPay); ctx.bus.removeEventListener('reset', onReset); clearTimeout(lt); } };
}
