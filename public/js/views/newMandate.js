import { h, icon, toast, busy } from '../dom.js';
import { toMinor } from '../api.js';
import { createMandate } from '../mandateTools.js';
import { money } from '../format.js';

const PRESETS = {
  agent: { label: 'AI shopping agent', helper: 'ai_agent', title: 'Team supplies', goal: 'Office equipment for the design team', budget: 20000, cap: 16000, approve: 5000, merchants: 'Dell Store, IKEA', agents: '*', days: 7 },
  child: { label: 'Pocket money', helper: 'child', title: 'Pocket money', goal: 'Books, stationery and snacks for school', budget: 2000, cap: 800, approve: 500, merchants: 'Crossword Books, School Canteen', agents: 'child-phone', days: 30 },
  employee: { label: 'Employee expense', helper: 'employee', title: 'Travel expenses', goal: 'Flights and hotels for the Pune client visit', budget: 60000, cap: 30000, approve: 15000, merchants: 'IndiGo, Taj Hotels', agents: 'priya', days: 14 },
};

export function newMandate(ctx) {
  const cur = ctx.cfg?.currency ?? 'INR';
  const f = {};
  const field = (key, label, hint, input, wide) => h('label', { class: wide ? 'wide' : '' }, label, input, hint ? h('span', { class: 'hint' }, hint) : null);
  const text = (key, type = 'text') => (f[key] = h('input', { type, required: true, id: `f-${key}`, autocomplete: 'off' }));
  f.title = text('title'); f.goal = text('goal');
  f.helper = h('select', {}, [['ai_agent', 'AI agent'], ['child', 'Child'], ['employee', 'Employee']].map(([v, l]) => h('option', { value: v }, l)));
  f.budget = text('budget'); f.cap = text('cap'); f.approve = text('approve');
  f.merchants = text('merchants'); f.agents = text('agents'); f.days = text('days', 'number');
  f.days.min = 1; f.days.max = 366;

  const fill = (p) => {
    f.helper.value = p.helper; f.title.value = p.title; f.goal.value = p.goal; f.budget.value = p.budget; f.cap.value = p.cap;
    f.approve.value = p.approve; f.merchants.value = p.merchants; f.agents.value = p.agents; f.days.value = p.days;
    renderPreview();
  };

  const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const submit = h('button', { class: 'primary', type: 'submit' }, icon('lock', 16), 'Sign and create');
  const preview = h('aside', { class: 'mandate-preview', 'aria-live': 'polite' });
  function renderPreview() {
    try {
      const budget = toMinor(f.budget.value);
      const cap = toMinor(f.cap.value);
      const approval = toMinor(f.approve.value);
      const boundedCap = Math.min(cap, budget);
      const pct = budget ? Math.min(100, boundedCap / budget * 100) : 0;
      preview.replaceChildren(
        h('span', { class: 'eyebrow' }, 'CONTROL PREVIEW'),
        h('strong', { class: 'preview-budget' }, money(budget, cur)),
        h('span', { class: 'muted small' }, 'Total mandate budget'),
        h('div', { class: 'limit-track', role: 'img', 'aria-label': `Per-payment cap is ${pct.toFixed(0)} percent of the total budget` }, h('i', { style: { width: `${pct}%` } })),
        h('div', { class: 'preview-limits' },
          h('span', {}, h('small', {}, 'Single-payment cap'), h('strong', {}, money(cap, cur))),
          h('span', {}, h('small', {}, 'Owner approval above'), h('strong', {}, money(approval, cur)))));
    } catch {
      preview.replaceChildren(h('span', { class: 'eyebrow' }, 'CONTROL PREVIEW'), h('p', { class: 'muted small' }, 'Enter valid amounts to preview budget limits.'));
    }
  }
  for (const amount of [f.budget, f.cap, f.approve]) amount.addEventListener('input', renderPreview);
  fill(PRESETS.agent);
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      await busy(submit, 'Signing…', async () => {
        const id = await createMandate(ctx, {
          title: f.title.value, goal: f.goal.value, helper: f.helper.value, currency: cur,
          budgetCents: toMinor(f.budget.value), perTxCapCents: toMinor(f.cap.value), approvalAboveCents: toMinor(f.approve.value),
          allowedMerchants: list(f.merchants.value), agents: list(f.agents.value), days: Number(f.days.value),
        });
        toast('Mandate signed and recorded as block 0');
        ctx.navigate(`#/m/${id}`);
      })();
    },
  },
  h('div', { class: 'mandate-form-layout' },
    h('div', { class: 'mandate-steps' },
      h('fieldset', { class: 'form-step' },
        h('legend', {}, h('span', { class: 'step-number' }, '01'), h('span', {}, h('strong', {}, 'Purpose'), h('small', {}, 'Define what this budget is for.'))),
        h('div', { class: 'form-grid' },
          field('title', 'Mandate name', null, f.title),
          field('helper', 'Who spends', null, f.helper),
          field('goal', 'Spending goal', 'Purchases outside this goal can be escalated to the owner.', f.goal, true),
          field('days', 'Valid for (days)', null, f.days))),
      h('fieldset', { class: 'form-step' },
        h('legend', {}, h('span', { class: 'step-number' }, '02'), h('span', {}, h('strong', {}, 'Budget controls'), h('small', {}, 'Set total, per-payment and approval thresholds.'))),
        h('div', { class: 'form-grid' },
          field('budget', `Total budget (${cur})`, null, f.budget),
          field('cap', `Single-payment cap (${cur})`, null, f.cap),
          field('approve', `Owner approval above (${cur})`, 'Requests over this amount wait for your signature.', f.approve)),
        preview),
      h('fieldset', { class: 'form-step' },
        h('legend', {}, h('span', { class: 'step-number' }, '03'), h('span', {}, h('strong', {}, 'Permissions'), h('small', {}, 'Limit which merchants and agents can request spending.'))),
        h('div', { class: 'form-grid' },
          field('merchants', 'Allowed merchants', 'Comma separated. Anything else is blocked.', f.merchants, true),
          field('agents', 'Allowed agents', 'Comma separated IDs, or * for any agent.', f.agents, true)))),
    h('div', { class: 'row mandate-submit' }, submit, h('a', { class: 'btn', href: '#/' }, 'Cancel'))));

  const key = ctx.owner;
  const el = h('div', {},
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'New mandate'), h('p', {}, 'You sign the rules once, in this browser. LedgerTrue can enforce them, but it cannot change them or forge your approval.'))),
    h('div', { class: 'row', style: { marginBottom: '18px' } }, h('span', { class: 'muted' }, 'Start from'), Object.values(PRESETS).map((p) => h('button', { type: 'button', onclick: () => fill(p) }, p.label))),
    h('div', { class: 'panel pad' }, form),
    key ? h('p', { class: 'muted small', style: { marginTop: '14px' } }, `Signing key ${key.fingerprint}. It is stored in this browser and cannot be exported.${key.sessionOnly ? ' This window does not allow storage, so the key will be lost when you close it.' : ''}`) : null);
  return { el, title: 'New mandate' };
}
