import { h, clear, icon, svg, toast, busy, dateTime } from '../dom.js';
import { api } from '../api.js';
import { money } from '../format.js';

const LEVEL = { low: 'ok', medium: 'warn', high: 'bad', unknown: '' };
const pct = (p) => (p == null ? '—' : `${Math.round(p * 100)}%`);
const lvl = (l) => h('span', { class: `chip ${LEVEL[l] ?? ''}` }, l ?? 'unknown');
const engineChip = (e) => h('span', { class: `chip ${e === 'ml' ? 'hold' : ''}` }, e === 'ml' ? 'ML model' : 'Rule baseline');

function panel(title, sub, ...body) {
  return h('section', { class: 'section' },
    h('header', {}, h('h2', {}, title), sub ? h('span', { class: 'muted small' }, sub) : null),
    h('div', { class: 'panel pad' }, ...body));
}
const note = (text, kind = '') => h('div', { class: `callout ${kind}` }, icon('alert'), h('div', {}, text));

function kpi(label, value, sub) {
  return h('div', { class: 'panel pad kpi' }, h('div', { class: 'muted small' }, label), h('div', { class: 'kpi-v' }, value), sub ? h('div', { class: 'muted small' }, sub) : null);
}

// Burn forecast: committed history, p50 line and a p10-p90 band, with the budget line. Pure SVG, no innerHTML.
function forecastChart(f, currency) {
  if (!f || f.status !== 'ok') return note(f?.note ?? 'A projection needs at least 6 hours and 4 spend events. Nothing is guessed until then.');
  const W = 640, H = 220, P = { l: 56, r: 12, t: 12, b: 26 };
  const hist = f.history ?? [], curve = f.curve ?? [];
  const pts = [...hist.map((d) => ({ t: d.t, v: d.committed })), ...curve.map((d) => ({ t: d.t, v: d.p90 ?? d.p50 }))];
  const t0 = Math.min(...pts.map((p) => p.t)), t1 = Math.max(f.expiresAt ?? 0, ...pts.map((p) => p.t));
  const vmax = Math.max(f.budgetCents, ...pts.map((p) => p.v)) * 1.05;
  const x = (t) => P.l + ((t - t0) / (t1 - t0 || 1)) * (W - P.l - P.r);
  const y = (v) => H - P.b - (v / vmax) * (H - P.t - P.b);
  const line = (arr, k) => arr.map((d, i) => `${i ? 'L' : 'M'}${x(d.t).toFixed(1)},${y(d[k]).toFixed(1)}`).join(' ');
  const band = curve.length ? `${line(curve, 'p90')} ${curve.slice().reverse().map((d) => `L${x(d.t).toFixed(1)},${y(d.p10).toFixed(1)}`).join(' ')} Z` : '';
  const histPath = hist.map((d, i) => `${i ? 'L' : 'M'}${x(d.t).toFixed(1)},${y(d.committed).toFixed(1)}`).join(' ');
  return svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': `Committed spend so far and projected range to expiry, budget ${money(f.budgetCents, currency)}` },
    svg('line', { x1: P.l, x2: W - P.r, y1: y(f.budgetCents), y2: y(f.budgetCents), class: 'ch-budget' }),
    svg('text', { x: P.l + 4, y: y(f.budgetCents) - 4, class: 'ch-label' }, `Budget ${money(f.budgetCents, currency)}`),
    band ? svg('path', { d: band, class: 'ch-band' }) : null,
    curve.length ? svg('path', { d: line(curve, 'p50'), class: 'ch-proj' }) : null,
    svg('path', { d: histPath, class: 'ch-hist' }),
    svg('line', { x1: x(f.asOf), x2: x(f.asOf), y1: P.t, y2: H - P.b, class: 'ch-now' }),
    svg('text', { x: x(f.asOf) + 4, y: P.t + 10, class: 'ch-label' }, 'now'),
    svg('text', { x: P.l, y: H - 6, class: 'ch-label' }, dateTime(t0)),
    svg('text', { x: W - P.r, y: H - 6, class: 'ch-label', 'text-anchor': 'end' }, dateTime(t1)));
}

function healthPanel(d) {
  const hl = d.health;
  return panel('Mandate health', 'Explanatory index, not a credit rating',
    h('div', { class: 'health' },
      h('div', { class: `health-score ${LEVEL[hl.band === 'healthy' ? 'low' : hl.band === 'watch' ? 'medium' : 'high']}` }, h('b', {}, hl.score), h('span', {}, `/100 · ${hl.band}`)),
      h('div', { class: 'factors' }, hl.factors.map((f) => h('div', { class: 'factor' },
        h('div', { class: 'row between' }, h('span', {}, f.label), h('span', { class: 'muted small' }, `${f.points} / ${f.maxPoints}`)),
        h('div', { class: 'bar' }, h('i', { style: { width: `${(f.points / f.maxPoints) * 100}%` } })))))),
    hl.notes.map((n) => h('p', { class: 'muted small' }, n)));
}

function riskTable(d, currency) {
  const rows = [...d.requests].sort((a, b) => b.score - a.score).slice(0, 25);
  if (!rows.length) return h('p', { class: 'muted' }, 'No requests yet.');
  return h('div', { class: 'scroll' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Request', 'Agent', 'Amount', 'Merchant', 'Risk', 'Outcome'].map((c) => h('th', {}, c)))),
    h('tbody', {}, rows.map((r) => {
      const detail = h('tr', { hidden: true }, h('td', { colspan: 6 },
        r.evidence.length ? h('ul', { class: 'ev' }, r.evidence.map((e) => h('li', {}, e.text ?? e))) : h('span', { class: 'muted small' }, r.dataQuality === 'cold_start' ? 'Too little history for this agent to say anything.' : 'No unusual signals.'),
        h('div', { class: 'muted small' }, `Confidence ${pct(r.confidence)} · data: ${r.dataQuality} · estimate, not a finding of fraud`)));
      const main = h('tr', { class: 'clickable', tabindex: 0, onclick: () => { detail.hidden = !detail.hidden; } },
        h('td', { class: 'mono' }, r.requestId), h('td', {}, r.agentId), h('td', {}, money(r.amountCents, currency)), h('td', {}, r.merchant),
        h('td', {}, lvl(r.level), ' ', h('span', { class: 'muted small' }, r.score.toFixed(2))), h('td', {}, r.outcome ?? '—'));
      return [main, detail];
    }))));
}

function reliability(d) {
  if (!d.behaviour.length) return h('p', { class: 'muted' }, 'No agent activity yet.');
  return h('div', { class: 'scroll' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Agent', 'Requests', 'Blocked rate (95% interval)', 'Needs owner', 'Flagged', 'Label'].map((c) => h('th', {}, c)))),
    h('tbody', {}, d.behaviour.map((a) => h('tr', {}, h('td', {}, a.agent), h('td', {}, a.requests),
      h('td', {}, `${pct(a.blockRate)} (${pct(a.blockRateInterval95[0])}–${pct(a.blockRateInterval95[1])})`), h('td', {}, a.needsOwner), h('td', {}, a.flagged),
      h('td', {}, h('span', { class: 'chip' }, a.label)))))));
}

function trace(a) {
  return h('div', { class: 'list' }, a.agents.map((g) => h('div', { class: 'item' },
    h('div', {}, h('div', { class: 'title' }, g.agent), h('div', { class: 'sub' }, g.recommendedAction ?? ''),
      h('div', { class: 'muted small' }, `${g.modelVersion} · ${g.engine} · estimate · confidence ${pct(g.confidence)}`),
      g.validation.problems.length ? h('div', { class: 'small', style: { color: 'var(--bad)' } }, `Rejected by decision engine: ${g.validation.problems.join('; ')}`) : null),
    h('div', { class: 'row' }, lvl(g.riskLevel), h('span', { class: `chip ${g.validation.accepted ? 'ok' : 'bad'}` }, g.validation.accepted ? 'validated' : 'rejected')))));
}

function modelPanel(st) {
  if (!st.ml.connected) {
    return panel('Models', 'ML service not connected',
      note(`Running on the rule baseline (${st.ml.reason}). Start the Python service and set ML_SERVICE_URL to enable the trained models. Everything here still works without it, with fewer signals and no probabilities.`),
      st.unsupported.map((u) => h('p', { class: 'muted small' }, `Not built: ${u.agent}. ${u.reason}`)));
  }
  return panel('Model inventory', 'All trained on simulated data',
    note('Every model below was trained on simulated data. Metrics show the pipeline works; they are not production performance.', 'warn'),
    h('div', { class: 'scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Model', 'Version', 'Algorithm', 'Held-out PR-AUC', 'Data', 'Checksum'].map((c) => h('th', {}, c)))),
      h('tbody', {}, (st.ml.models ?? []).map((m) => h('tr', {}, h('td', {}, m.name), h('td', { class: 'mono' }, m.version), h('td', {}, m.algorithm ?? '—'),
        h('td', {}, m.headlinePrAuc == null ? '—' : m.headlinePrAuc.toFixed(3)), h('td', {}, h('span', { class: 'chip warn' }, m.dataSource)), h('td', { class: 'mono' }, m.sha256))))),
    ),
    st.ml.drift ? h('div', {}, h('h3', {}, 'Input drift (PSI)'), h('div', { class: 'drift' }, Object.entries(st.ml.drift).map(([k, w]) => h('div', { class: 'factor' },
      h('div', { class: 'row between' }, h('span', {}, k), h('span', { class: `chip ${w.status === 'stable' ? 'ok' : w.status === 'insufficient_data' ? '' : 'warn'}` }, `${w.status.replace('_', ' ')} · ${w.windowSize} live vectors`)),
      (w.features ?? []).slice(0, 3).map((f) => h('div', { class: 'muted small' }, `${f.feature}: ${f.psi ?? '—'}`)))))) : null);
}

function paymentsPanel(p) {
  const rows = (p.agent.prediction.payments ?? []).filter((x) => x.level !== 'low').slice(0, 10);
  return panel('Payment early warning', `${p.agent.modelVersion} · estimates`,
    rows.length ? h('div', { class: 'list' }, rows.map((x) => h('div', { class: 'item' },
      h('div', {}, h('div', { class: 'title mono' }, x.paymentId), h('div', { class: 'sub' }, `State ${x.engineState} · needs attention ${pct(x.attentionProbability)} · money moved ${pct(x.moneyMovedProbability)}`),
        (x.evidence ?? []).map((e) => h('div', { class: 'muted small' }, e.text ?? e))), lvl(x.level))))
      : h('p', { class: 'muted' }, p.agent.recommendedAction));
}

export async function intel(ctx, mandateId) {
  const el = h('div', {});
  const [status, overview] = await Promise.all([api('GET', '/api/intel/status'), api('GET', '/api/intel/overview')]);
  const picked = mandateId ?? overview.mandates.find((m) => !m.quarantined)?.id ?? null;

  const select = h('select', { 'aria-label': 'Mandate', onchange: (e) => ctx.navigate(`#/intel/${e.target.value}`) },
    overview.mandates.map((m) => h('option', { value: m.id, selected: m.id === picked }, m.title)));
  const head = h('div', { class: 'page-head' },
    h('div', {}, h('h1', {}, 'Intelligence'), h('p', {}, 'Forecasts and risk flags from the audit trail. Advisory only: this view cannot approve, block, move or create money.')),
    h('div', { class: 'row' }, engineChip(status.engine), overview.mandates.length ? select : null));
  const kpis = h('div', { class: 'kpis' },
    kpi('Mandates', overview.totals.mandates), kpi('High risk', overview.totals.highRisk), kpi('Flagged requests', overview.totals.flaggedRequests),
    kpi('Average health', overview.totals.avgHealth ?? '—'),
    kpi('Escalation', status.escalation.enabled ? 'On' : 'Off', status.escalation.enabled ? `Flags at ≥ ${status.escalation.threshold} go to the owner` : 'Scores never change a decision'));
  const body = h('div', {}, h('p', { class: 'muted' }, 'Loading analysis…'));
  clear(el, head, kpis, body);

  (async () => {
    try {
      const parts = [];
      if (picked) {
        const m = overview.mandates.find((x) => x.id === picked);
        const a = await api('GET', `/api/mandates/${picked}/intel`);
        if (a.quarantined) parts.push(note('This mandate failed its integrity check, so it is not analysed.', 'bad'));
        else {
          const d = a.detail;
          if (a.mlStatus === 'rejected' || a.mlStatus === 'unreachable') parts.push(note(`ML service result not used (${a.mlStatus}${a.mlNote ? `: ${a.mlNote}` : ''}). Showing the rule baseline instead.`, 'warn'));
          parts.push(h('div', { class: 'two' }, healthPanel(d),
            panel('Budget burn forecast', d.forecast.engine, forecastChart({ ...d.forecast, asOf: a.asOf }, m.currency),
              (d.forecast.horizons ?? []).map((x) => h('div', { class: 'muted small' }, `Next ${x.days}d: ${money(x.p50, m.currency)} likely (${money(x.p10, m.currency)}–${money(x.p90, m.currency)}), ${pct(x.exceedsBudgetProb)} chance of exceeding the budget`)),
              d.forecast.exhaustion ? h('p', { class: 'small' }, `Chance the budget runs out before expiry: ${pct(d.forecast.exhaustion.probBeforeExpiry)}`) : null)));
          parts.push(panel('Spend-risk scores', 'Highest first. Click a row for the evidence.', riskTable(d, m.currency)));
          parts.push(panel('Agent reliability', 'Wilson intervals, small samples stay wide', reliability(d)));
          parts.push(panel('Decision engine trace', `${a.agents.length} agents · each output validated before display`, trace(a), h('div', { class: 'muted small' }, a.overall.recommendations.join(' '))));
        }
      } else parts.push(note('Create a mandate to see analysis here.'));
      const sandbox = h('button', {}, 'Run synthetic sandbox');
      if (ctx.cfg?.demo && status.ml.connected) {
        sandbox.onclick = async () => {
          await busy(sandbox, 'Running…', async () => {
            const r = await api('POST', '/api/intel/synthetic', {});
            const s = r.analysis?.riskSummary;
            toast(`Synthetic data (not real): ${s?.high ?? 0} high, ${s?.medium ?? 0} medium of ${s?.scored ?? 0} requests`);
          })();
        };
      }
      parts.push(modelPanel(status));
      try { parts.push(paymentsPanel(await api('GET', '/api/intel/payments'))); } catch { /* optional panel */ }
      if (ctx.cfg?.demo && status.ml.connected) parts.push(panel('Synthetic sandbox', 'Simulated stream with injected anomalies. Never mixed with your data.', sandbox));
      clear(body, ...parts);
    } catch (e) { clear(body, note(e.message, 'bad')); }
  })();

  return { el, title: 'Intelligence' };
}
