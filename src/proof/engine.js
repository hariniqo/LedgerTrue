import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { verifyText, messages } from '../../shared/crypto.js';
import { BLOCK, OUTCOME, STATUS, evaluate, validateMandate } from '../../shared/rules.js';
import { ValidationError, T } from '../events.js';
import { goalCheck } from './goalCheck.js';
import { GatewayTimeout } from './gateway.js';

const MAX_MANDATE_LIFETIME_MS = 366 * 24 * 3600 * 1000;
const CLOCK_SKEW_MS = 10 * 60 * 1000;

const str = (v, name, max, { required = true } = {}) => {
  if (v == null || v === '') { if (required) throw new ValidationError(`${name} is required`); return ''; }
  if (typeof v !== 'string') throw new ValidationError(`${name} must be text`);
  const s = v.trim();
  if (s.length > max) throw new ValidationError(`${name} is too long (max ${max})`);
  if (required && !s) throw new ValidationError(`${name} is required`);
  return s;
};

/**
 * Proof of Intent engine.
 * The rules decide. The chain remembers. The gateway (PayPal) moves money only after the rules said yes.
 * AI is consulted for one advisory flag and nothing else.
 */
export class ProofEngine extends EventEmitter {
  constructor({ store, gateway, recon = null, ai = {}, captureTimeoutMs = 8000, now = () => Date.now(), stateFile = null, riskScorer = null }) {
    super();
    this.store = store;
    this.gateway = gateway;
    this.recon = recon;
    this.ai = ai; // { apiKey, model, fetchImpl }
    this.riskScorer = riskScorer; // optional advisory scorer: async ({ mandate, request, blocks, ts }) => flag. It can only escalate.
    this.captureTimeoutMs = captureTimeoutMs;
    this.now = now;
    this.pendingOrders = new Map(); // `${mandateId}:${requestId}` -> { orderId, approveUrl }  (live PayPal: waiting for buyer)
    this.unknownCaptures = new Map(); // `${mandateId}:${requestId}` -> { orderId, tries }
    this.stateFile = stateFile;
    this.#restore();
    store.on('block', (e) => this.emit('block', e));
  }

  // Pending PayPal approvals and unconfirmed captures survive a restart. They are small and not part of the audit
  // chain (the chain only records what happened), so a plain JSON file written atomically is enough.
  #restore() {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      for (const [k, v] of Object.entries(saved.pendingOrders ?? {})) this.pendingOrders.set(k, v);
      for (const [k, v] of Object.entries(saved.unknownCaptures ?? {})) this.unknownCaptures.set(k, v);
    } catch { /* a corrupt state file must not stop the server; the chain is the source of truth */ }
  }

  #persist() {
    if (!this.stateFile) return;
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ pendingOrders: Object.fromEntries(this.pendingOrders), unknownCaptures: Object.fromEntries(this.unknownCaptures) }));
    fs.renameSync(tmp, this.stateFile);
  }

  /** Live PayPal: orders created for approved requests that still wait for the buyer to approve in PayPal. */
  pendingFor(mandateId) {
    const out = {};
    for (const [k, v] of this.pendingOrders) if (k.startsWith(`${mandateId}:`)) out[k.split(':')[1]] = v;
    return out;
  }

  ownerKey(mandateId) { return this.store.get(mandateId)?.blocks[0]?.data?.publicKeyJwk ?? null; }

  // ---------- mandate ----------
  async createMandate({ mandate, publicKeyJwk, signature }) {
    const errs = validateMandate(mandate);
    if (errs.length) throw new ValidationError(errs.join('; '));
    const t = this.now();
    if (Math.abs(mandate.createdAt - t) > CLOCK_SKEW_MS) throw new ValidationError('createdAt must be within 10 minutes of now');
    if (mandate.expiresAt - mandate.createdAt > MAX_MANDATE_LIFETIME_MS) throw new ValidationError('a mandate can last at most 366 days');
    if (!publicKeyJwk || publicKeyJwk.kty !== 'EC' || publicKeyJwk.crv !== 'P-256') throw new ValidationError('publicKeyJwk must be an EC P-256 key');
    if (!(await verifyText(publicKeyJwk, messages.mandate(mandate), String(signature ?? '')))) throw new ValidationError('owner signature does not match the mandate');
    if (this.store.has(mandate.id)) throw new ValidationError('mandate id already exists');
    const { kty, crv, x, y } = publicKeyJwk;
    return this.store.create(mandate.id, { mandate, publicKeyJwk: { kty, crv, x, y }, signature });
  }

  // ---------- agent request ----------
  async requestPayment(mandateId, raw) {
    const chain = this.store.get(mandateId);
    if (!chain) throw new ValidationError('unknown mandate');
    const mandate = chain.state.mandate;
    if (!Number.isInteger(raw?.amountCents) || raw.amountCents <= 0 || raw.amountCents > Number.MAX_SAFE_INTEGER) throw new ValidationError('amountCents must be a positive integer');
    const req = {
      requestId: 'r_' + crypto.randomBytes(5).toString('hex'),
      agentId: str(raw.agentId, 'agentId', 64),
      merchant: str(raw.merchant, 'merchant', 80),
      amountCents: raw.amountCents,
      currency: mandate.currency,
      reason: str(raw.reason, 'reason', 400),
      category: str(raw.category, 'category', 40, { required: false }),
      item: str(raw.item, 'item', 120, { required: false }),
    };

    // Advisory AI runs before the lock so a slow model never blocks other agents. It can only escalate.
    req.aiFlag = await goalCheck({ mandate, request: req }, this.ai);
    // Advisory spend-risk flag. Recorded only when it actually ran, so with the feature off the chain is byte-identical.
    if (this.riskScorer) {
      const flag = await Promise.resolve(this.riskScorer({ mandate, request: req, blocks: chain.blocks, ts: this.now() })).catch(() => null);
      if (flag?.checked) req.riskFlag = { checked: true, source: String(flag.source), modelVersion: String(flag.modelVersion ?? ''), score: Number(flag.score), level: String(flag.level), threshold: Number(flag.threshold), escalate: Boolean(flag.escalate) };
    }

    const result = await this.store.exclusive(mandateId, async ({ state, append }) => {
      const reqBlock = await append(BLOCK.REQUEST, req);
      const rq = state.requests[req.requestId];
      const verdict = evaluate(state.mandate, state, { ...rq.data }, reqBlock.ts);
      const decision = await append(BLOCK.DECISION, { requestId: req.requestId, outcome: verdict.outcome, checks: verdict.checks, reasons: verdict.reasons });
      return { verdict, decision, reqBlock };
    });

    let hold = null;
    if (result.verdict.outcome === OUTCOME.APPROVED) hold = await this.#beginHold(mandateId, req.requestId);
    return this.#view(mandateId, req.requestId, { verdict: result.verdict, hold });
  }

  // ---------- owner approval ----------
  async approve(mandateId, requestId, { decision, signature }) {
    if (decision !== 'APPROVE' && decision !== 'REJECT') throw new ValidationError('decision must be APPROVE or REJECT');
    const key = this.ownerKey(mandateId);
    if (!key) throw new ValidationError('unknown mandate');
    await this.store.exclusive(mandateId, async ({ state, blocks, append }) => {
      const rq = state.requests[requestId];
      if (!rq || rq.status !== STATUS.PENDING_APPROVAL) throw new ValidationError('this request is not waiting for approval');
      const decisionHash = blocks[rq.decisionBlock].hash;
      const ok = await verifyText(key, messages.approval({ mandateId, requestId, decision, decisionHash }), String(signature ?? ''));
      if (!ok) throw new ValidationError('owner signature does not verify');
      await append(BLOCK.APPROVAL, { requestId, decision, signature });
    });
    const hold = decision === 'APPROVE' ? await this.#beginHold(mandateId, requestId) : null;
    return this.#view(mandateId, requestId, { hold });
  }

  async revoke(mandateId, { signature }) {
    const key = this.ownerKey(mandateId);
    if (!key) throw new ValidationError('unknown mandate');
    return this.store.exclusive(mandateId, async ({ blocks, append }) => {
      const headHash = blocks.at(-1).hash;
      if (!(await verifyText(key, messages.revoke({ mandateId, headHash }), String(signature ?? '')))) throw new ValidationError('owner signature does not verify (sign the latest head hash)');
      return append(BLOCK.REVOKE, { signature });
    });
  }

  // ---------- hold / settle / release ----------
  async #beginHold(mandateId, requestId) {
    const { state } = this.store.get(mandateId);
    const rq = state.requests[requestId];
    const m = state.mandate;
    let created;
    try {
      created = await this.gateway.createHold({ requestId: `${mandateId}.${requestId}`.slice(-40), amountCents: rq.amountCents, currency: m.currency, description: `${m.title}: ${rq.data.item || rq.merchant}` });
    } catch (e) {
      await this.#safeVoid(mandateId, requestId, `gateway refused the hold: ${e.message}`);
      return { status: 'FAILED', error: e.message };
    }
    if (created.needsApproval) {
      this.pendingOrders.set(`${mandateId}:${requestId}`, { orderId: created.orderId, approveUrl: created.approveUrl });
      this.#persist();
      return { status: 'AWAITING_PAYPAL', orderId: created.orderId, approveUrl: created.approveUrl };
    }
    await this.#recordHold(mandateId, requestId, created);
    return { status: 'HELD', orderId: created.orderId };
  }

  /** Live PayPal only: the buyer approved the order in PayPal's popup, so authorize it and place the hold. */
  async completePayPalHold(mandateId, requestId, orderId) {
    const key = `${mandateId}:${requestId}`;
    const pending = this.pendingOrders.get(key);
    if (!pending || pending.orderId !== orderId) throw new ValidationError('no matching PayPal order is waiting for this request');
    let auth;
    try { auth = await this.gateway.completeHold(orderId); } catch (e) {
      await this.#safeVoid(mandateId, requestId, `PayPal did not authorize: ${e.message}`);
      this.pendingOrders.delete(key); this.#persist();
      throw e;
    }
    this.pendingOrders.delete(key); this.#persist();
    await this.#recordHold(mandateId, requestId, { orderId, authId: auth.authId });
    return this.#view(mandateId, requestId, {});
  }

  async #recordHold(mandateId, requestId, { orderId, authId }) {
    const { state } = this.store.get(mandateId);
    const rq = state.requests[requestId];
    await this.store.append(mandateId, BLOCK.HOLD, { requestId, amountCents: rq.amountCents, gateway: this.gateway.mode, orderId, authId });
    this.recon?.ingest({ paymentId: orderId, type: T.ORDER_INITIATED, source: 'app', ts: this.now(), amountCents: rq.amountCents, currency: state.mandate.currency });
  }

  #holdOf(mandateId, requestId) {
    const blocks = this.store.get(mandateId)?.blocks ?? [];
    return blocks.find((b) => b.type === BLOCK.HOLD && b.data.requestId === requestId)?.data ?? null;
  }

  async capture(mandateId, requestId, { amountCents } = {}) {
    const chain = this.store.get(mandateId);
    const rq = chain?.state.requests[requestId];
    if (!rq || rq.status !== STATUS.HELD) throw new ValidationError('this request has no active hold');
    const hold = this.#holdOf(mandateId, requestId);
    const amount = amountCents ?? rq.heldCents;
    if (!Number.isInteger(amount) || amount <= 0 || amount > rq.heldCents) throw new ValidationError('capture must be between 1 and the held amount');
    const currency = chain.state.mandate.currency;
    this.recon?.ingest({ paymentId: hold.orderId, type: T.PAYMENT_ATTEMPTED, source: 'app', ts: this.now(), amountCents: amount, currency });

    let captured = null;
    try {
      captured = await Promise.race([
        this.gateway.capture({ orderId: hold.orderId, authId: hold.authId, amountCents: amount, currency, requestId }),
        new Promise((_, rej) => { const t = setTimeout(() => rej(new GatewayTimeout('capture timed out')), this.captureTimeoutMs); t.unref?.(); }),
      ]);
    } catch (e) {
      if (!(e instanceof GatewayTimeout)) throw e;
      // The Ghost Balance moment: we do not know whether PayPal took the money. Ask, never guess.
      this.recon?.ingest({ paymentId: hold.orderId, type: T.CLIENT_TIMEOUT, source: 'app', ts: this.now(), ref: e.message });
      this.unknownCaptures.set(`${mandateId}:${requestId}`, { orderId: hold.orderId, amount, tries: 0 });
      this.#persist();
      const recovered = await this.#resolveUnknown(mandateId, requestId);
      if (!recovered) return this.#view(mandateId, requestId, { capture: { status: 'UNKNOWN', note: 'PayPal has not confirmed yet. LedgerTrue keeps asking; nothing is retried or charged twice.' } });
      return this.#view(mandateId, requestId, { capture: { status: 'RECOVERED' } });
    }

    this.recon?.ingest({ paymentId: hold.orderId, type: T.CAPTURE_COMPLETED, source: 'paypal_poll', ts: this.now(), amountCents: amount, currency, ref: `capture:${captured.captureId}` });
    await this.store.append(mandateId, BLOCK.CAPTURE, { requestId, amountCents: amount, orderId: hold.orderId, captureId: captured.captureId ?? null, via: 'gateway', witness: captured.witness ?? null });
    return this.#view(mandateId, requestId, { capture: { status: 'SETTLED' } });
  }

  async #resolveUnknown(mandateId, requestId) {
    const key = `${mandateId}:${requestId}`;
    const u = this.unknownCaptures.get(key);
    if (!u || !this.recon) return false;
    u.tries += 1;
    let res = null;
    try { res = await this.recon.verify(u.orderId); } catch { return false; }
    const snap = res?.snapshot ?? this.recon.get(u.orderId);
    if (!snap || !['SUCCESS', 'VERIFIED'].includes(snap.state)) return false;
    const mandate = this.store.get(mandateId)?.state.mandate;
    if (!mandate || snap.amountCents !== u.amount || snap.currency !== mandate.currency) return false;
    const rq = this.store.get(mandateId).state.requests[requestId];
    if (rq.status !== STATUS.HELD) { this.unknownCaptures.delete(key); this.#persist(); return true; }
    await this.store.exclusive(mandateId, async ({ append }) => {
      await append(BLOCK.CAPTURE, { requestId, amountCents: u.amount, orderId: u.orderId, captureId: null, via: 'reconciler-poll', witness: { provider: this.gateway.mode === 'paypal' ? 'paypal' : 'simulator', simulated: this.gateway.mode !== 'paypal', via: 'poll', orderId: u.orderId, reportedState: snap.state } });
      await append(BLOCK.RECON, { requestId, orderId: u.orderId, reconciledState: snap.state, ghostBalance: Boolean(snap.ghost), note: 'The capture response never arrived. PayPal confirmed the money moved, so the hold was settled exactly once.' });
    });
    this.unknownCaptures.delete(key); this.#persist();
    return true;
  }

  /** Called on a timer: keep asking PayPal about captures we could not confirm. Gives up after 10 tries (then it needs a human). */
  async sweepUnknown() {
    for (const key of [...this.unknownCaptures.keys()]) {
      const [mandateId, requestId] = key.split(':');
      if (this.unknownCaptures.get(key).tries >= 10) continue;
      await this.#resolveUnknown(mandateId, requestId).catch(() => {});
    }
  }

  async void(mandateId, requestId, { reason = 'released by operator' } = {}) {
    const chain = this.store.get(mandateId);
    const rq = chain?.state.requests[requestId];
    if (!rq || ![STATUS.HELD, STATUS.APPROVED, STATUS.PENDING_APPROVAL].includes(rq.status)) throw new ValidationError('nothing to release for this request');
    const hold = this.#holdOf(mandateId, requestId);
    if (rq.status === STATUS.HELD && hold?.authId) await this.gateway.void({ authId: hold.authId });
    await this.store.append(mandateId, BLOCK.VOID, { requestId, reason: str(reason, 'reason', 200), authId: hold?.authId ?? null });
    this.pendingOrders.delete(`${mandateId}:${requestId}`); this.#persist();
    return this.#view(mandateId, requestId, {});
  }

  async #safeVoid(mandateId, requestId, reason) {
    try { await this.store.append(mandateId, BLOCK.VOID, { requestId, reason, authId: null }); } catch { /* already released */ }
  }

  #view(mandateId, requestId, extra) {
    const chain = this.store.get(mandateId);
    const rq = chain.state.requests[requestId];
    const decisionBlock = chain.blocks[rq.decisionBlock];
    const pending = this.pendingOrders.get(`${mandateId}:${requestId}`);
    return {
      requestId,
      status: rq.status,
      outcome: decisionBlock?.data.outcome ?? null,
      reasons: decisionBlock?.data.reasons ?? [],
      checks: decisionBlock?.data.checks ?? [],
      amountCents: rq.amountCents,
      decisionHash: decisionBlock?.hash ?? null,
      paypal: pending ?? null,
      ...extra,
    };
  }
}
