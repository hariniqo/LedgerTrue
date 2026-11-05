import crypto from 'node:crypto';
import { canonical } from '../../shared/canonical.js';
import { sha256Hex } from '../../shared/crypto.js';
import { toCents } from '../money.js';

export class GatewayTimeout extends Error {
  constructor(message = 'gateway timeout') { super(message); this.name = 'GatewayTimeout'; }
}

const rid = (p) => `${p}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

/**
 * Gateway contract (what the engine needs from a payment rail):
 *   createHold({requestId, amountCents, currency, description}) -> { orderId, authId?, needsApproval?, approveUrl? }
 *   completeHold(orderId) -> { authId }                      (live PayPal only: after the buyer approves)
 *   capture({orderId, authId, amountCents, currency}) -> { captureId }   throws GatewayTimeout when the answer never came back
 *   void({authId}) -> {}
 */
export class SimGateway {
  mode = 'simulator';
  constructor(sim) { this.sim = sim; this.ghost = new Set(); }

  /** Make the next capture for this request time out even though the money moves (a real Ghost Balance). */
  armGhost(requestId) { this.ghost.add(requestId); }

  async createHold({ requestId }) {
    return { orderId: rid('ORD'), authId: rid('AUTH'), requestId };
  }

  async completeHold() { throw new Error('simulator holds need no buyer approval'); }

  async capture({ orderId, authId, amountCents, currency, requestId }) {
    this.sim?.set(orderId, { status: 'COMPLETED', amountCents, currency });
    if (this.ghost.delete(requestId)) throw new GatewayTimeout('capture response never arrived');
    const captureId = rid('CAP');
    return { captureId, authId, witness: { provider: 'simulator', simulated: true, captureId } };
  }

  async void() { return {}; }
}

export class PayPalGateway {
  mode = 'paypal';
  constructor(client) { this.client = client; }

  async createHold({ requestId, amountCents, currency, description }) {
    const order = await this.client.createAuthorizeOrder({ amountCents, currency, referenceId: requestId, description });
    const approveUrl = order.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href ?? null;
    return { orderId: order.id, needsApproval: true, approveUrl };
  }

  async completeHold(orderId) {
    const order = await this.client.authorizeOrder(orderId);
    const auth = order.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (!auth?.id || auth.status === 'DENIED') throw new Error(`PayPal did not authorize the order (${auth?.status ?? order.status})`);
    return { authId: auth.id, status: auth.status };
  }

  async capture({ authId, amountCents, currency }) {
    try {
      const cap = await this.client.captureAuthorization(authId, { amountCents, currency });
      if (cap.status === 'PENDING' || !cap.status) throw new GatewayTimeout('PayPal capture is not confirmed as completed');
      if (cap.status !== 'COMPLETED') throw new Error(`capture ${cap.status}`);
      let actualAmount;
      try {
        if (cap.amount?.value == null || !cap.amount.currency_code) throw new Error('missing amount or currency');
        actualAmount = toCents(cap.amount.value);
      } catch {
        throw new GatewayTimeout('PayPal capture response is missing a valid amount or currency');
      }
      if (actualAmount !== amountCents || cap.amount.currency_code !== currency) {
        throw new GatewayTimeout('PayPal capture amount or currency does not match the authorized request');
      }
      // Witness: a hash of PayPal's own reply. Anyone with access to the PayPal account can fetch the same capture and
      // compare. This is evidence from the counterparty, not a PayPal signature (PayPal does not co-sign receipts).
      return { captureId: cap.id, witness: { provider: 'paypal', simulated: false, captureId: cap.id, status: cap.status ?? null, evidenceHash: await sha256Hex(canonical(cap)) } };
    } catch (e) {
      // Network failures and 5xx mean "we do not know", which is exactly the Ghost Balance case.
      if (!e.status || e.status >= 500 || e.name === 'TimeoutError') throw new GatewayTimeout(e.message);
      throw e;
    }
  }

  async void({ authId }) { await this.client.voidAuthorization(authId); return {}; }
}
