import { h } from './dom.js';
import { CHECK_LABELS } from '/shared/rules.js';
import { money } from '/shared/narrate.js';

export { money, CHECK_LABELS };

export const STATUS_CHIP = {
  PENDING_APPROVAL: ['warn', 'Waiting for owner'],
  APPROVED: ['ok', 'Approved'],
  BLOCKED: ['bad', 'Blocked'],
  REJECTED: ['bad', 'Rejected by owner'],
  HELD: ['hold', 'On hold'],
  SETTLED: ['ok', 'Settled'],
  VOIDED: ['', 'Released'],
  NEW: ['', 'New'],
};

export const statusChip = (status) => {
  const [kind, label] = STATUS_CHIP[status] ?? ['', status];
  return h('span', { class: `chip ${kind}` }, label);
};

/** The one hero: how much of the budget is settled, on hold, reserved and still free. */
export function budgetBar(s, currency, { big = true } = {}) {
  const pct = (n) => `${s.budgetCents ? (n / s.budgetCents) * 100 : 0}%`;
  const bar = h('div', { class: `bar ${big ? '' : 'mini-bar'}`, role: 'img', 'aria-label': `Of ${money(s.budgetCents, currency)}: ${money(s.settledCents, currency)} settled, ${money(s.heldCents, currency)} on hold, ${money(s.reservedCents, currency)} reserved, ${money(s.availableCents, currency)} free` },
    h('i', { class: 's', style: { width: pct(s.settledCents) } }),
    h('i', { class: 'h', style: { width: pct(s.heldCents) } }),
    h('i', { class: 'r', style: { width: pct(s.reservedCents) } }));
  if (!big) return bar;
  return h('div', { class: 'budget' },
    h('div', { class: 'figure' },
      h('span', { class: 'big' }, money(s.availableCents, currency)),
      h('span', { class: 'muted' }, `still spendable of ${money(s.budgetCents, currency)}`)),
    bar,
    h('div', { class: 'legend' },
      h('span', { class: 's', title: 'Paid out through PayPal' }, `Settled ${money(s.settledCents, currency)}`),
      h('span', { class: 'h', title: 'A PayPal hold is in place; not paid yet' }, `On hold ${money(s.heldCents, currency)}`),
      h('span', { class: 'r', title: 'Set aside while a request waits for the owner to sign' }, `Waiting for owner ${money(s.reservedCents, currency)}`)),
    h('p', { class: 'muted small legend-note' }, 'Settled = paid. On hold = PayPal hold, not paid yet. Waiting for owner = set aside until you approve or reject.'));
}

