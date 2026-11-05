import { h, clear, icon, toast, busy, dateTime } from '../dom.js';
import { api } from '../api.js';
import { budgetBar, money } from '../format.js';
import { createMandate, demoMandateFields } from '../mandateTools.js';

export async function home(ctx) {
  let [mandates, state, scenarios] = await Promise.all([
    api('GET', '/api/mandates'),
    api('GET', '/api/state'),
    api('GET', '/api/demo/scenarios').catch(() => ({})),
  ]);
  await ctx.cfgReady; // already in flight since page load, so this adds no extra round trip
  let payments = state.payments;
  const activeMandates = () => mandates.filter((m) => !m.revoked && !m.quarantined);
  const byCurrency = (key) => Object.entries(activeMandates().reduce((sum, m) => {
    sum[m.currency] = (sum[m.currency] ?? 0) + (m[key] ?? 0);
    return sum;
  }, {})).map(([currency, cents]) => money(cents, currency)).join(' · ') || '—';

  const runDemo = (name) => async function () {
    const btn = this;
    await busy(btn, 'Running…', async () => {
      const id = await createMandate(ctx, demoMandateFields(ctx, name));
      await api('POST', `/api/demo/${name}`, { mandateId: id });
      toast('Scenario finished. Opening the mandate.');
      ctx.navigate(`#/m/${id}`);
    })();
  };

  const demoList = ctx.cfg?.demo && Object.keys(scenarios).length
    ? h('section', { class: 'section' },
      h('header', {}, h('h2', {}, 'Try a scenario'), h('span', { class: 'muted small' }, 'Each one creates a fresh signed mandate and runs simulated agents against it.')),
      h('div', { class: 'panel pad' },
        h('div', { class: 'list' }, Object.entries(scenarios).map(([key, s]) =>
          h('div', { class: 'item' },
            h('div', {}, h('div', { class: 'title' }, s.title), h('div', { class: 'sub' }, s.blurb)),
            h('button', { class: key === 'race' ? 'primary' : '', onclick: runDemo(key) }, icon('play', 16), 'Run'))))))
    : null;

  const mandateTable = () => mandates.length
    ? h('div', { class: 'panel scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Mandate'), h('th', {}, 'Budget used'), h('th', { class: 'num' }, 'Free'), h('th', { class: 'num' }, 'Blocks'), h('th', {}, 'Created'))),
      h('tbody', {}, mandates.map((m) => h('tr', {},
        h('td', {}, h('a', { class: 'row-link', href: `#/m/${m.id}` }, m.title), h('div', { class: 'muted small' }, m.goal), m.revoked ? h('span', { class: 'chip bad' }, 'Revoked') : null, m.quarantined ? h('span', { class: 'chip bad' }, 'Quarantined') : null),
        h('td', {}, budgetBar(m, m.currency, { big: false })),
        h('td', { class: 'num' }, money(m.availableCents, m.currency)),
        h('td', { class: 'num' }, m.height),
        h('td', { class: 'muted' }, dateTime(m.createdAt)))))))
    : h('div', { class: 'empty' }, h('h2', {}, 'No mandates yet'), h('p', {}, 'A mandate is a signed budget with rules. Run a scenario below, or write your own.'), h('a', { class: 'btn primary', href: '#/new' }, icon('plus', 16), 'New mandate'));

  const kpi = (label, value, note, kind = '') => h('article', { class: 'panel kpi' },
    h('span', { class: 'kpi-label' }, label),
    h('strong', { class: `kpi-value ${kind}` }, value),
    h('span', { class: 'muted small' }, note));
  const activity = () => {
    const recent = [...payments].sort((a, b) => (b.lastReceivedAt ?? b.firstEventTs ?? 0) - (a.lastReceivedAt ?? a.firstEventTs ?? 0)).slice(0, 6);
    return recent.length
      ? h('div', { class: 'activity-list' }, recent.map((p) => h('a', { class: 'activity-row', href: '#/reconcile' },
      h('span', { class: 'activity-mark' }, icon(p.ghost ? 'alert' : 'scale', 16)),
      h('span', { class: 'activity-main' },
        h('strong', {}, p.paymentId),
        h('span', { class: 'muted small' }, p.ghost ? 'Ghost balance detected' : p.anomalies?.find((a) => a.severity !== 'info')?.message ?? 'Payment state updated')),
      h('span', { class: 'activity-end' },
        h('span', { class: `chip ${p.state === 'SUCCESS' || p.state === 'VERIFIED' ? 'ok' : p.state === 'RECONCILE' || p.ghost ? 'bad' : 'hold'}` }, p.state),
        h('strong', {}, money(p.amountCents, p.currency))))))
      : h('div', { class: 'empty compact-empty' }, h('p', {}, 'Payment activity will appear here as events arrive.'), h('a', { href: '#/reconcile' }, 'Open reconciliation'));
  };
  const status = ctx.cfg?.boot?.quarantined?.length
    ? h('span', { class: 'chip bad' }, `${ctx.cfg.boot.quarantined.length} proof chain(s) quarantined`)
    : ctx.cfg?.anchors?.broken
      ? h('span', { class: 'chip bad' }, 'Anchor log integrity warning')
      : h('span', { class: 'chip ok' }, ctx.cfg ? 'No quarantined chains at startup' : 'System status unavailable');
  const budgetPanel = () => activeMandates().length
    ? h('div', { class: 'panel pad' }, h('div', { class: 'budget-list' }, activeMandates().slice(0, 4).map((m) => h('a', { class: 'budget-row', href: `#/m/${m.id}` },
      h('span', { class: 'budget-title' }, h('strong', {}, m.title), h('span', { class: 'muted small' }, `${money(m.settledCents, m.currency)} settled · ${money(m.heldCents, m.currency)} held`)),
      budgetBar(m, m.currency, { big: false }),
      h('span', { class: 'muted small budget-free' }, `${money(m.availableCents, m.currency)} free`)))))
    : h('div', { class: 'panel pad muted' }, 'Create your first signed mandate to track its budget here.');

  const flowStep = (n, title, text) => h('li', { class: 'flow-step' },
    h('span', { class: 'flow-n', 'aria-hidden': 'true' }, n),
    h('div', {}, h('strong', {}, title), h('span', { class: 'muted small' }, text)));
  const hero = ctx.cfg?.demo && scenarios.teen
    ? h('section', { class: 'panel hero', 'aria-label': 'Quick demo' },
      h('div', { class: 'hero-copy' },
        h('span', { class: 'eyebrow' }, 'SEE IT IN 20 SECONDS'),
        h('h2', {}, 'A small business gives an AI agent its supplier budget'),
        h('p', { class: 'muted' }, 'The agent buys packaging for an export order, gets tricked by a fake supplier invoice, and asks for a big machine upgrade. Plain code approves, blocks and escalates. Then you verify the whole story yourself.'),
        h('button', { class: 'primary', onclick: runDemo('teen') }, icon('play', 16), 'Run the demo')),
      h('ol', { class: 'flow', 'aria-label': 'How a payment flows' },
        flowStep('1', 'Owner signs a mandate', 'Budget, merchants, expiry, in their own browser'),
        flowStep('2', 'Agent asks to spend', 'Every request is logged, good or bad'),
        flowStep('3', 'Code decides', 'Approve, block, or ask the owner. AI cannot overrule it'),
        flowStep('4', 'PayPal hold, then settle or release', 'Authorize, capture or void in the PayPal sandbox'),
        flowStep('5', 'Anyone can verify', 'Proof Card + QR. Edit a record and it visibly breaks')))
    : null;

  const stat = (value, label) => h('li', { class: 'impact-stat' }, h('strong', {}, value), h('span', {}, label));
  const impact = hero
    ? h('section', { class: 'impact', 'aria-label': 'Why this matters for small businesses' },
      h('h3', {}, 'Why it matters: small businesses carry the economy, and fraud lands on them first'),
      h('ul', { class: 'impact-stats' },
        stat('~90%', 'of businesses worldwide are small and medium enterprises'),
        stat('50%+', 'of global jobs depend on them'),
        stat('US$5.7T', 'unmet financing need across 119 emerging economies'),
        stat('US$2.9B', 'lost to business email compromise, reported to the FBI in 2023 alone')),
      h('p', { class: 'impact-src small muted' }, 'Sources: World Bank, SME Finance topic page; FBI Internet Crime Complaint Center, 2023 Internet Crime Report. A mandate gives a small team a spending limit it can prove, without hiring a finance department.'))
    : null;

  const metrics = h('section', { class: 'kpi-grid', 'aria-label': 'Financial overview' });
  const budgetHost = h('div', {});
  const activityHost = h('div', { class: 'panel pad activity-panel' });
  const portfolioHost = h('section', { class: 'section' });
  function renderDynamic() {
    const active = activeMandates();
    const held = payments.filter((p) => p.ledger?.held > 0);
    const alerts = payments.filter((p) => p.ghost || p.state === 'RECONCILE' || p.anomalies?.some((a) => a.severity === 'high' || a.severity === 'critical'));
    clear(metrics,
      kpi('Total mandates', mandates.length, `${active.length} active · ${mandates.length - active.length} inactive`),
      kpi('Active budget', byCurrency('budgetCents'), `${active.length} usable mandate${active.length === 1 ? '' : 's'}`),
      kpi('Held payments', held.length, held.length ? 'Funds awaiting capture or release' : 'No funds currently on hold', held.length ? 'hold-text' : ''),
      kpi('Reconciliation alerts', alerts.length, alerts.length ? 'Ghost balances or items needing review' : 'No urgent anomalies', alerts.length ? 'alert-text' : ''));
    clear(budgetHost, budgetPanel());
    clear(activityHost, activity());
    clear(portfolioHost,
      h('header', {}, h('div', {}, h('h2', {}, 'Mandate portfolio'), h('p', { class: 'muted small' }, 'Open a mandate to review requests, permissions and its proof chain.'))),
      mandateTable());
  }

  const el = h('div', {},
    h('div', { class: 'page-head' },
      h('div', {},
        h('span', { class: 'eyebrow' }, 'LEDGERTRUE · COMMAND CENTER'),
        h('h1', {}, 'Spending you can prove'),
        h('p', {}, 'One view of signed budgets, payment risk and independently verifiable proof.')),
      h('a', { class: 'btn primary', href: '#/new' }, icon('plus', 16), 'New mandate')),
    hero,
    impact,
    metrics,
    h('section', { class: 'system-strip panel' },
      h('span', { class: 'system-title' }, 'System status'),
      h('span', { class: 'mode' }, h('span', { class: `dot ${ctx.cfg?.mode === 'simulator' ? 'sim' : ''}` }), `Payments · ${ctx.cfg?.mode ?? 'connecting'}`),
      status,
      h('span', { class: 'chip hold', title: 'AI only explains and flags. Rules written as plain code decide every payment.' }, icon('shield', 14), `AI advisory only · ${ctx.cfg?.explainer === 'nvidia' ? 'NVIDIA NIM' : 'deterministic mode'} · cannot move money`),
      h('a', { class: 'text-link', href: '#/reconcile' }, 'Open reconciliation', icon('scale', 15))),
    h('div', { class: 'dashboard-grid section' },
      h('section', {}, h('header', {}, h('div', {}, h('h2', {}, 'Budget utilization'), h('p', { class: 'muted small' }, 'Committed, held and available funds by mandate.'))), budgetHost),
      h('section', {}, h('header', {}, h('div', {}, h('h2', {}, 'Recent payment activity'), h('p', { class: 'muted small' }, 'Latest reconciled states and exceptions.'))), activityHost)),
    portfolioHost,
    demoList);

  renderDynamic();
  let refreshTimer;
  let disposed = false;
  const refresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      try {
        [mandates, state] = await Promise.all([api('GET', '/api/mandates'), api('GET', '/api/state')]);
        payments = state.payments;
        if (!disposed) renderDynamic();
      } catch (error) {
        if (!disposed) toast(`Dashboard refresh failed: ${error.message}`, 'error');
      }
    }, 180);
  };
  const onPayment = (event) => {
    const updated = event.detail.snapshot;
    payments = [...payments.filter((payment) => payment.paymentId !== updated.paymentId), updated];
    renderDynamic();
  };
  const onReset = () => { payments = []; renderDynamic(); refresh(); };
  ctx.bus.addEventListener('payment', onPayment);
  ctx.bus.addEventListener('reset', onReset);
  ctx.bus.addEventListener('block', refresh);
  return {
    el,
    title: 'Mandates',
    destroy: () => {
      disposed = true;
      clearTimeout(refreshTimer);
      ctx.bus.removeEventListener('payment', onPayment);
      ctx.bus.removeEventListener('reset', onReset);
      ctx.bus.removeEventListener('block', refresh);
    },
  };
}
