import crypto from 'node:crypto';
import { toCents } from './money.js';

// Internal event vocabulary. PayPal webhooks and polls are mapped onto these (see paypal.js).
export const T = Object.freeze({
  ORDER_INITIATED: 'ORDER.INITIATED',
  PAYMENT_ATTEMPTED: 'PAYMENT.ATTEMPTED',
  CLIENT_TIMEOUT: 'CLIENT.TIMEOUT',
  CLIENT_ERROR: 'CLIENT.ERROR',
  CAPTURE_PENDING: 'PAYMENT.CAPTURE.PENDING',
  CAPTURE_COMPLETED: 'PAYMENT.CAPTURE.COMPLETED',
  CAPTURE_DENIED: 'PAYMENT.CAPTURE.DENIED',
  DISPUTE_CREATED: 'CUSTOMER.DISPUTE.CREATED',
  DISPUTE_RESOLVED_SELLER: 'CUSTOMER.DISPUTE.RESOLVED.SELLER',
  DISPUTE_RESOLVED_BUYER: 'CUSTOMER.DISPUTE.RESOLVED.BUYER',
  CAPTURE_REFUNDED: 'PAYMENT.CAPTURE.REFUNDED',
  CAPTURE_REVERSED: 'PAYMENT.CAPTURE.REVERSED',
});

// Tie-breaker when two events carry the same timestamp (clock skew, same-ms events).
export const TYPE_RANK = Object.freeze({
  [T.ORDER_INITIATED]: 0,
  [T.PAYMENT_ATTEMPTED]: 1,
  [T.CLIENT_TIMEOUT]: 2,
  [T.CLIENT_ERROR]: 2,
  [T.CAPTURE_PENDING]: 3,
  [T.CAPTURE_COMPLETED]: 4,
  [T.CAPTURE_DENIED]: 4,
  [T.DISPUTE_CREATED]: 5,
  [T.DISPUTE_RESOLVED_SELLER]: 6,
  [T.DISPUTE_RESOLVED_BUYER]: 6,
  [T.CAPTURE_REFUNDED]: 7,
  [T.CAPTURE_REVERSED]: 8,
});

// Client-side failures are never authoritative: they can only make a payment UNKNOWN.
export const WEAK = new Set([T.CLIENT_TIMEOUT, T.CLIENT_ERROR]);

// app = your own server, paypal_webhook = pushed by PayPal, paypal_poll = we asked PayPal (source of truth)
export const SOURCES = new Set(['app', 'paypal_webhook', 'paypal_poll']);

export class ValidationError extends Error {}

export function normalizeEvent(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') throw new ValidationError('event must be an object');
  const { paymentId, type, source } = raw;
  if (!paymentId || typeof paymentId !== 'string') throw new ValidationError('paymentId is required');
  if (!Object.hasOwn(TYPE_RANK, type)) throw new ValidationError(`unknown event type: ${type}`);
  if (!SOURCES.has(source)) throw new ValidationError(`unknown source: ${source}`);

  const ts = typeof raw.ts === 'number' ? raw.ts : Date.parse(raw.ts);
  if (!Number.isFinite(ts)) throw new ValidationError('ts must be a number (ms) or ISO date');

  let amountCents = raw.amountCents ?? null;
  if (amountCents == null && raw.amount != null) {
    try { amountCents = toCents(raw.amount); } catch (e) { throw new ValidationError(e.message); }
  }
  if (amountCents != null && (!Number.isInteger(amountCents) || amountCents < 0)) {
    throw new ValidationError('amountCents must be a non-negative integer');
  }

  const currency = String(raw.currency || 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new ValidationError('currency must be a 3-letter code');

  const ref = raw.ref != null ? String(raw.ref) : null;
  // Idempotency has two layers: the provider's event id, and a natural key that catches
  // replays arriving under a new id.
  const naturalKey = `${paymentId}|${type}|${source}|${ref ?? `${ts}:${amountCents ?? ''}`}`;
  const eventId = raw.eventId
    ? String(raw.eventId)
    : 'ev_' + crypto.createHash('sha1').update(naturalKey).digest('hex').slice(0, 16);

  return { eventId, naturalKey, paymentId, type, source, ts, amountCents, currency, ref, meta: raw.meta ?? {}, receivedAt: now };
}
