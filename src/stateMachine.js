import { T, TYPE_RANK, WEAK } from './events.js';

export const S = Object.freeze({
  INITIATED: 'INITIATED',
  PROCESSING: 'PROCESSING',
  PENDING: 'PENDING',
  UNKNOWN: 'UNKNOWN', // we asked PayPal to charge, the client gave up, PayPal has not told us anything
  SUCCESS: 'SUCCESS', // PayPal webhook says captured
  VERIFIED: 'VERIFIED', // PayPal API (poll / capture response) confirms captured
  FAILED: 'FAILED',
  DISPUTED: 'DISPUTED',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
  REFUNDED: 'REFUNDED',
  REVERSED: 'REVERSED',
  RECONCILE: 'RECONCILE', // contradiction we refuse to guess about -> human / PayPal poll must resolve it
});

const PRE = new Set([null, S.INITIATED, S.PROCESSING, S.PENDING, S.UNKNOWN]); // no confirmed money yet
const FUNDED = new Set([S.SUCCESS, S.VERIFIED, S.PARTIALLY_REFUNDED]);
const AFTER_MONEY = new Set([S.VERIFIED, S.PARTIALLY_REFUNDED, S.DISPUTED, S.REFUNDED, S.REVERSED]);

// Deterministic order: source timestamp, then lifecycle rank, then id. Arrival order is deliberately ignored.
export function cmp(a, b) {
  return a.ts - b.ts || TYPE_RANK[a.type] - TYPE_RANK[b.type] || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0);
}

function anomaly(ctx, code, severity, message, ev) {
  const key = `${code}|${ev?.eventId ?? ''}`;
  if (ctx.seen.has(key)) return;
  ctx.seen.add(key);
  ctx.anomalies.push({ code, severity, message, eventId: ev?.eventId ?? null });
}

function go(ctx, ev, to) {
  ctx.timeline.push({ eventId: ev.eventId, type: ev.type, source: ev.source, ts: ev.ts, from: ctx.state, to });
  ctx.state = to;
}

function toReconcile(ctx, ev, why) {
  anomaly(ctx, 'ILLEGAL_TRANSITION', 'critical', `${ev.type} is not valid while ${ctx.state ?? 'NEW'}: ${why}. Ledger frozen at last known-good state.`, ev);
  ctx.lastGood = { state: ctx.state, refunded: ctx.refunded };
  go(ctx, ev, S.RECONCILE);
}

// PayPal API responses are the source of truth and may override webhook-derived state.
function applyPoll(ctx, ev) {
  const cur = ctx.state;
  const override = (to) => {
    anomaly(ctx, 'AUTHORITATIVE_OVERRIDE', 'warn', `PayPal API says ${ev.type.split('.').pop()}, overriding ${cur}.`, ev);
    go(ctx, ev, to);
  };
  switch (ev.type) {
    case T.CAPTURE_COMPLETED:
      ctx.confirmed = true;
      if (cur === S.SUCCESS || PRE.has(cur)) return go(ctx, ev, S.VERIFIED);
      if (AFTER_MONEY.has(cur)) return; // already past this point, poll just confirms the capture existed
      return override(S.VERIFIED); // FAILED / RECONCILE
    case T.CAPTURE_PENDING:
      if (cur === S.PENDING) return;
      if (PRE.has(cur)) return go(ctx, ev, S.PENDING);
      if (cur === S.FAILED || cur === S.RECONCILE) return override(S.PENDING);
      return; // stale
    case T.CAPTURE_DENIED:
      if (cur === S.FAILED) return;
      if (PRE.has(cur)) return go(ctx, ev, S.FAILED);
      return override(S.FAILED);
    case T.CAPTURE_REFUNDED:
      ctx.refunded = ctx.amountCents; // poll reports absolute status, not a delta
      if (cur === S.REFUNDED) return;
      return PRE.has(cur) || cur === S.RECONCILE ? override(S.REFUNDED) : go(ctx, ev, S.REFUNDED);
    default:
      return; // polls never carry other types
  }
}

function applyNormal(ctx, ev) {
  const cur = ctx.state;
  switch (ev.type) {
    case T.ORDER_INITIATED:
      return cur === null ? go(ctx, ev, S.INITIATED) : undefined;
    case T.PAYMENT_ATTEMPTED:
      return cur === null || cur === S.INITIATED ? go(ctx, ev, S.PROCESSING) : undefined;
    case T.CLIENT_TIMEOUT:
    case T.CLIENT_ERROR:
      // Weak signal: cannot downgrade anything PayPal told us, can only turn "in flight" into "unknown".
      return cur === null || cur === S.INITIATED || cur === S.PROCESSING ? go(ctx, ev, S.UNKNOWN) : undefined;
    case T.CAPTURE_PENDING:
      return PRE.has(cur) && cur !== S.PENDING ? go(ctx, ev, S.PENDING) : undefined; // late/stale otherwise
    case T.CAPTURE_COMPLETED:
      if (PRE.has(cur)) return go(ctx, ev, S.SUCCESS);
      if (AFTER_MONEY.has(cur) || cur === S.SUCCESS) return; // duplicate-ish, nothing new
      return toReconcile(ctx, ev, cur === S.FAILED ? 'previously denied' : 'unexpected');
    case T.CAPTURE_DENIED:
      if (PRE.has(cur)) return go(ctx, ev, S.FAILED);
      if (cur === S.FAILED) return;
      return toReconcile(ctx, ev, 'funds already captured');
    case T.CAPTURE_REFUNDED: {
      if (!(FUNDED.has(cur) || cur === S.DISPUTED || cur === S.REFUNDED)) return toReconcile(ctx, ev, 'refund without a confirmed capture');
      const delta = ev.amountCents ?? ctx.amountCents - ctx.refunded;
      if (ctx.refunded + delta > ctx.amountCents) {
        anomaly(ctx, 'OVER_REFUND', 'critical', `Refunds would total ${ctx.refunded + delta} of ${ctx.amountCents} cents.`, ev);
        return toReconcile(ctx, ev, 'refund exceeds captured amount');
      }
      ctx.refunded += delta;
      const to = ctx.refunded === ctx.amountCents ? S.REFUNDED : cur === S.DISPUTED ? S.DISPUTED : S.PARTIALLY_REFUNDED;
      if (to === S.PARTIALLY_REFUNDED && cur === S.DISPUTED) ctx.preDispute = S.PARTIALLY_REFUNDED;
      return to === cur ? undefined : go(ctx, ev, to);
    }
    case T.CAPTURE_REVERSED:
      if (FUNDED.has(cur) || cur === S.DISPUTED) return go(ctx, ev, S.REVERSED);
      if (cur === S.REVERSED) return;
      return toReconcile(ctx, ev, 'reversal without a confirmed capture');
    case T.DISPUTE_CREATED:
      if (FUNDED.has(cur)) { ctx.preDispute = cur; return go(ctx, ev, S.DISPUTED); }
      if (cur === S.DISPUTED) return;
      return toReconcile(ctx, ev, 'dispute on a payment we have not seen funded');
    case T.DISPUTE_RESOLVED_SELLER:
      if (cur === S.DISPUTED) return go(ctx, ev, ctx.preDispute ?? S.SUCCESS);
      return anomaly(ctx, 'STALE_EVENT', 'info', 'Dispute resolution arrived while not disputed; ignored.', ev);
    case T.DISPUTE_RESOLVED_BUYER:
      if (cur === S.DISPUTED) return go(ctx, ev, S.REVERSED);
      return anomaly(ctx, 'STALE_EVENT', 'info', 'Dispute resolution arrived while not disputed; ignored.', ev);
    default:
      return undefined;
  }
}

export function reducePayment(paymentId, events) {
  const sorted = [...events].sort(cmp);
  const ctx = {
    state: null, refunded: 0, preDispute: null, lastGood: null, confirmed: false,
    anomalies: [], timeline: [], seen: new Set(), amountCents: 0, currency: 'USD',
  };

  // The amount PayPal reports beats what our own app claimed.
  const strongAmt = [...sorted].reverse().find((e) => e.source !== 'app' && e.amountCents != null && (e.type === T.CAPTURE_COMPLETED || e.type === T.CAPTURE_PENDING));
  const appAmt = sorted.find((e) => e.source === 'app' && e.amountCents != null);
  ctx.amountCents = (strongAmt ?? appAmt)?.amountCents ?? 0;
  ctx.currency = (strongAmt ?? sorted[0])?.currency ?? 'USD';
  if (strongAmt && appAmt && strongAmt.amountCents !== appAmt.amountCents) {
    anomaly(ctx, 'AMOUNT_MISMATCH', 'warn', `App expected ${appAmt.amountCents} cents but PayPal captured ${strongAmt.amountCents}. Using PayPal's figure.`, strongAmt);
  }

  let sawWeak = false;
  let sawFunded = false;
  for (const ev of sorted) {
    if (WEAK.has(ev.type)) sawWeak = true;
    if (ev.type === T.CAPTURE_COMPLETED && ev.source !== 'app') sawFunded = true;
    if (ctx.state === S.RECONCILE && ev.source !== 'paypal_poll') {
      anomaly(ctx, 'SKIPPED_IN_RECONCILE', 'info', `${ev.type} ignored while payment is in RECONCILE.`, ev);
      continue;
    }
    if (ev.source === 'paypal_poll') applyPoll(ctx, ev); else applyNormal(ctx, ev);
  }
  if (sawWeak && sawFunded) {
    anomaly(ctx, 'GHOST_BALANCE', 'warn', 'The app recorded a timeout/failure, but PayPal confirms the money moved. A naive system would show "failed" and invite a double charge.');
  }

  const p = {
    paymentId,
    state: ctx.state ?? S.INITIATED,
    amountCents: ctx.amountCents,
    refundedCents: ctx.refunded,
    currency: ctx.currency,
    confirmed: ctx.confirmed,
    anomalies: ctx.anomalies,
    timeline: ctx.timeline,
    lastGood: ctx.lastGood,
    ghost: sawWeak && sawFunded,
    firstEventTs: sorted[0]?.ts ?? null,
    lastEventTs: sorted.at(-1)?.ts ?? null,
  };
  p.recommended = recommend(p);
  return p;
}

export function recommend(p) {
  switch (p.state) {
    case S.UNKNOWN: return { code: 'VERIFY_WITH_PAYPAL', label: 'Hold the order, block customer retry, and ask PayPal for the real status.' };
    case S.PENDING: return { code: 'HOLD_FULFILMENT', label: 'Funds are pending. Do not ship yet.' };
    case S.SUCCESS:
    case S.VERIFIED:
      return p.ghost
        ? { code: 'FULFIL_ORDER_BLOCK_RETRY', label: 'Fulfil the order. Mark the app-side failure as stale and block any retry charge.' }
        : { code: 'FULFIL_ORDER', label: 'Captured. Safe to fulfil.' };
    case S.PARTIALLY_REFUNDED: return { code: 'FULFIL_ORDER', label: 'Captured with a partial refund. Adjust the order total.' };
    case S.FAILED: return { code: 'RELEASE_INVENTORY', label: 'Denied by PayPal. Release inventory and let the customer retry.' };
    case S.DISPUTED: return { code: 'SUBMIT_DISPUTE_EVIDENCE', label: 'Funds are held. Submit delivery evidence before the dispute deadline.' };
    case S.REFUNDED:
    case S.REVERSED: return { code: 'CLOSE_ORDER', label: 'Money returned to the buyer. Close the order.' };
    case S.RECONCILE: return { code: 'MANUAL_REVIEW', label: 'Contradictory events. Ledger is frozen at the last good state until PayPal is polled or a human reviews.' };
    default: return { code: 'WAIT', label: 'Payment is in flight.' };
  }
}
