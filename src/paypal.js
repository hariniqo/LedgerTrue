import { T } from './events.js';
import { toCents } from './money.js';

export class PayPalClient {
  constructor({ clientId, secret, env = 'sandbox', webhookId = '', fetchImpl = globalThis.fetch } = {}) {
    this.clientId = clientId;
    this.secret = secret;
    this.env = env;
    this.webhookId = webhookId;
    this.fetch = fetchImpl;
    this.cached = null;
  }

  get configured() { return Boolean(this.clientId && this.secret); }
  get base() { return this.env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'; }

  async token() {
    if (this.cached && this.cached.exp > Date.now() + 30_000) return this.cached.value;
    const res = await this.fetch(`${this.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${this.clientId}:${this.secret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new Error(`PayPal auth failed (${res.status}${res.status === 401 ? ': Client ID/Secret rejected for ' + this.env : ''})`);
    const j = await res.json();
    this.cached = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return this.cached.value;
  }

  async api(method, path, body, extraHeaders = {}) {
    const res = await this.fetch(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json', ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { message: text.slice(0, 200) }; } // never crash on an HTML error page
    if (!res.ok) {
      const err = new Error(`PayPal ${method} ${path} -> ${res.status} ${json.message ?? ''}`.trim());
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  createOrder({ amountCents, currency = 'USD' }) {
    return this.api('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{ amount: { currency_code: currency, value: (amountCents / 100).toFixed(2) } }],
    });
  }

  // PayPal-Request-Id makes the capture itself idempotent on PayPal's side, so a retry can never double charge.
  captureOrder(orderId) {
    return this.api('POST', `/v2/checkout/orders/${orderId}/capture`, undefined, { 'PayPal-Request-Id': `capture-${orderId}` });
  }

  getOrder(orderId) { return this.api('GET', `/v2/checkout/orders/${orderId}`); }

  // --- Authorize / capture / void: the "hold -> settled -> released" lifecycle used by Proof of Intent. ---
  // Docs: Orders v2 (intent=AUTHORIZE, /authorize) and Payments v2 (/authorizations/{id}/capture, /void).
  createAuthorizeOrder({ amountCents, currency = 'USD', referenceId, description }) {
    return this.api('POST', '/v2/checkout/orders', {
      intent: 'AUTHORIZE',
      purchase_units: [{
        reference_id: referenceId,
        description: description?.slice(0, 127),
        custom_id: referenceId,
        amount: { currency_code: currency, value: (amountCents / 100).toFixed(2) },
      }],
    }, { 'PayPal-Request-Id': `order-${referenceId}` });
  }

  /** Call after the buyer approves the order. Returns the order with payments.authorizations[]. */
  authorizeOrder(orderId) {
    return this.api('POST', `/v2/checkout/orders/${orderId}/authorize`, undefined, { 'PayPal-Request-Id': `authorize-${orderId}` });
  }

  captureAuthorization(authId, { amountCents, currency = 'USD' } = {}) {
    const body = { final_capture: true };
    if (amountCents != null) body.amount = { currency_code: currency, value: (amountCents / 100).toFixed(2) };
    return this.api('POST', `/v2/payments/authorizations/${authId}/capture`, body, { 'PayPal-Request-Id': `capture-${authId}` });
  }

  voidAuthorization(authId) {
    return this.api('POST', `/v2/payments/authorizations/${authId}/void`, undefined, { 'PayPal-Request-Id': `void-${authId}` });
  }

  async verifyWebhook(headers, event) {
    if (!this.webhookId) return { verified: false, skipped: true };
    const h = (k) => headers[k] ?? headers[k.toLowerCase()];
    const r = await this.api('POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: h('paypal-auth-algo'),
      cert_url: h('paypal-cert-url'),
      transmission_id: h('paypal-transmission-id'),
      transmission_sig: h('paypal-transmission-sig'),
      transmission_time: h('paypal-transmission-time'),
      webhook_id: this.webhookId,
      webhook_event: event,
    });
    return { verified: r.verification_status === 'SUCCESS', skipped: false };
  }
}

const WEBHOOK_TYPES = {
  'PAYMENT.CAPTURE.COMPLETED': T.CAPTURE_COMPLETED,
  'PAYMENT.CAPTURE.PENDING': T.CAPTURE_PENDING,
  'PAYMENT.CAPTURE.DENIED': T.CAPTURE_DENIED,
  'PAYMENT.CAPTURE.DECLINED': T.CAPTURE_DENIED,
  'PAYMENT.CAPTURE.REFUNDED': T.CAPTURE_REFUNDED,
  'PAYMENT.CAPTURE.REVERSED': T.CAPTURE_REVERSED,
  'CUSTOMER.DISPUTE.CREATED': T.DISPUTE_CREATED,
};

/**
 * Translate a PayPal webhook body into a LedgerTrue event.
 * `index` maps PayPal capture ids -> our payment (order) id, so events that only carry a capture id still land on the right payment.
 * Field paths follow PayPal's REST webhook payloads; confirm against a real sandbox delivery before relying on dispute/refund edge cases.
 */
export function mapWebhook(event, index = new Map()) {
  const r = event?.resource ?? {};
  let type = WEBHOOK_TYPES[event?.event_type];
  let captureId = r.id;
  let amount = r.amount?.value;
  let currency = r.amount?.currency_code;
  let ref = r.id;

  if (event?.event_type === 'CUSTOMER.DISPUTE.RESOLVED') {
    const code = String(r.dispute_outcome?.outcome_code ?? '');
    type = /BUYER/i.test(code) ? T.DISPUTE_RESOLVED_BUYER : /SELLER/i.test(code) ? T.DISPUTE_RESOLVED_SELLER : null;
  }
  if (!type) return null;

  if (event.event_type.startsWith('CUSTOMER.DISPUTE')) {
    captureId = r.disputed_transactions?.[0]?.seller_transaction_id;
    amount = r.dispute_amount?.value;
    currency = r.dispute_amount?.currency_code;
    ref = r.dispute_id;
  } else if (type === T.CAPTURE_REFUNDED) {
    const up = r.links?.find((l) => l.rel === 'up')?.href;
    captureId = up ? up.split('/').pop() : captureId;
  }

  const orderId = r.supplementary_data?.related_ids?.order_id;
  if (orderId && captureId) index.set(captureId, orderId);
  const paymentId = orderId ?? r.custom_id ?? index.get(captureId) ?? captureId;
  if (!paymentId) return null;

  return {
    eventId: event.id,
    paymentId,
    type,
    source: 'paypal_webhook',
    ts: event.create_time ?? r.create_time ?? Date.now(),
    amountCents: amount != null ? toCents(amount) : null,
    currency,
    ref,
    meta: { eventType: event.event_type, captureId },
  };
}

const STATUS_TYPES = {
  COMPLETED: T.CAPTURE_COMPLETED,
  PARTIALLY_REFUNDED: T.CAPTURE_COMPLETED, // the capture exists; refund amounts come from refund events
  PENDING: T.CAPTURE_PENDING,
  DECLINED: T.CAPTURE_DENIED,
  FAILED: T.CAPTURE_DENIED,
  REFUNDED: T.CAPTURE_REFUNDED,
};

/** An Order object (from GET order or the capture response) -> authoritative poll event. */
export function mapOrder(order, paymentId, ts = Date.now()) {
  const cap = order?.purchase_units?.[0]?.payments?.captures?.[0];
  const type = cap && STATUS_TYPES[cap.status];
  if (!type) return null;
  return {
    paymentId,
    type,
    source: 'paypal_poll',
    ts,
    amountCents: cap.amount ? toCents(cap.amount.value) : null,
    currency: cap.amount?.currency_code,
    ref: `poll:${cap.id}:${cap.status}`,
    meta: { captureId: cap.id, status: cap.status },
  };
}

export function makePayPalOracle(client) {
  return async (paymentId, { afterTs = 0 } = {}) => {
    const order = await client.getOrder(paymentId);
    return mapOrder(order, paymentId, Math.max(Date.now(), afterTs + 1));
  };
}
