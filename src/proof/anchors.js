import fs from 'node:fs';
import path from 'node:path';
import { GENESIS } from '../../shared/crypto.js';
import { anchorHash, verifyAnchorLog } from '../../shared/anchors.js';
import { Mutex } from './chainStore.js';

/**
 * Append-only anchor log. Every chain block produces one guard-signed anchor entry linked to the previous one.
 * The log is only useful if it lives somewhere the operator cannot edit, so each anchor can be pushed out:
 *   ANCHOR_WEBHOOK_URL  : POSTed as JSON (point it at a GitHub Action, a Slack channel, a timestamping service)
 *   /.well-known/ledgertrue-anchors.json : the whole log, public, for anyone to mirror
 * Without a webhook the log is still signed and verifiable, but it is only as independent as wherever you copy it.
 */
export class AnchorLog {
  constructor({ file = null, guard, now = () => Date.now(), webhookUrl = '', fetchImpl = globalThis.fetch } = {}) {
    this.file = file; this.guard = guard; this.now = now; this.webhookUrl = webhookUrl; this.fetchImpl = fetchImpl;
    this.entries = [];
    this.mutex = new Mutex();
    this.broken = null;
    this.published = 0; this.lastPublishError = null;
    this.outbox = []; this.draining = false;
    if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
    this.publishedFile = file ? `${file}.published` : null; // how many anchors the webhook has acknowledged; survives restarts
    this.retryTimer = null;
  }

  #readPublished() {
    try { return Number(fs.readFileSync(this.publishedFile, 'utf8')) || 0; } catch { return 0; }
  }
  #writePublished(n) {
    if (!this.publishedFile) return;
    try { fs.writeFileSync(this.publishedFile, String(n)); } catch (e) { this.lastPublishError = `could not save publish progress: ${e.message}`; }
  }
  /** Re-queue anchors the webhook never acknowledged (crash, restart, outage) and keep retrying while any are stuck. */
  #resumePublishing() {
    if (!this.webhookUrl) return;
    const done = this.publishedFile ? this.#readPublished() : this.entries.length;
    this.outbox = this.entries.slice(done);
    if (this.outbox.length) this.#drain();
    if (!this.retryTimer) {
      this.retryTimer = setInterval(() => { if (this.outbox.length && !this.draining) this.#drain(); }, 60_000);
      this.retryTimer.unref?.();
    }
  }
  stop() { if (this.retryTimer) clearInterval(this.retryTimer); this.retryTimer = null; }

  async load() {
    if (!this.file || !fs.existsSync(this.file)) return { loaded: 0, ok: true };
    this.entries = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const res = await verifyAnchorLog(this.entries, this.guard.publicKeyJwk);
    if (!res.ok) this.broken = res.issues; // readable, but we refuse to extend a log that fails its own check
    this.#resumePublishing();
    return { loaded: this.entries.length, ok: res.ok, issues: res.issues };
  }

  record(mandateId, block) {
    return this.mutex.run(async () => {
      if (this.broken) throw new Error('anchor log failed its integrity check');
      const prev = this.entries.at(-1);
      const a = { seq: this.entries.length, ts: this.now(), mandateId, headIndex: block.index, headHash: block.hash, prev: prev?.hash ?? GENESIS };
      a.hash = await anchorHash(a);
      a.guardSig = await this.guard.sign(a.hash);
      if (this.file) fs.appendFileSync(this.file, JSON.stringify(a) + '\n');
      this.entries.push(a);
      this.#publish(a);
      return a;
    });
  }

  #publish(a) {
    if (!this.webhookUrl) return;
    this.outbox.push(a);
    this.#drain();
  }

  async #drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.outbox.length) {
        const a = this.outbox[0];
        let ok = false;
        for (let attempt = 0; attempt < 5 && !ok; attempt++) {
          try {
            const r = await this.fetchImpl(this.webhookUrl, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ kind: 'ledgertrue-anchor', anchor: a, guardKeyId: this.guard.keyId }),
              signal: AbortSignal.timeout?.(5000),
            });
            if (!r.ok) throw new Error(`webhook answered ${r.status}`);
            ok = true; this.published += 1; this.lastPublishError = null;
            this.#writePublished(a.seq + 1);
          } catch (e) {
            this.lastPublishError = e.message;
            if (attempt < 4) await new Promise((res) => { const t = setTimeout(res, Math.min(30_000, 500 * 2 ** attempt)); t.unref?.(); });
          }
        }
        if (!ok) break;          // keep it queued, order preserved, retried on the next anchor
        this.outbox.shift();
      }
    } finally { this.draining = false; }
  }

  /** Resolves when every queued anchor has been written (used by tests and by graceful shutdown). */
  idle() { return this.mutex.run(async () => {}); }

  forMandate(id) { return this.entries.filter((a) => a.mandateId === id); }
  head() { const e = this.entries.at(-1); return e ? { seq: e.seq, hash: e.hash } : null; }
  status() { return { count: this.entries.length, head: this.head(), webhook: Boolean(this.webhookUrl), published: this.published, lastPublishError: this.lastPublishError, broken: this.broken }; }
}
