import fs from 'node:fs';
import path from 'node:path';
import { normalizeEvent } from './events.js';

/**
 * Append-only event log. Nothing is ever updated or deleted.
 * `raw` keeps every delivery in arrival order (duplicates included, flagged);
 * `byPayment` keeps only the unique events the reducer folds over.
 * Swap this class for a MongoDB/Redis-Streams adapter with the same four methods if you need to scale out.
 */
export class EventStore {
  constructor({ file = null } = {}) {
    this.file = file;
    this.raw = [];
    this.ids = new Set();
    this.keys = new Map();
    this.byPayment = new Map();
    this.rawByPayment = new Map();
    this.arrivalSeq = 0;
    if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  append(input, { now = Date.now(), persist = true } = {}) {
    const ev = normalizeEvent(input, now);
    const arrival = ++this.arrivalSeq;

    let duplicateOf = null;
    if (this.ids.has(ev.eventId)) duplicateOf = ev.eventId;
    else if (this.keys.has(ev.naturalKey)) duplicateOf = this.keys.get(ev.naturalKey);

    const record = { ...ev, arrival, duplicate: duplicateOf !== null, duplicateOf };
    this.raw.push(record);
    if (!this.rawByPayment.has(ev.paymentId)) this.rawByPayment.set(ev.paymentId, []);
    this.rawByPayment.get(ev.paymentId).push(record);

    if (!record.duplicate) {
      this.ids.add(ev.eventId);
      this.keys.set(ev.naturalKey, ev.eventId);
      if (!this.byPayment.has(ev.paymentId)) this.byPayment.set(ev.paymentId, []);
      this.byPayment.get(ev.paymentId).push(record);
    }

    if (persist && this.file) {
      fs.appendFileSync(this.file, JSON.stringify({ ...ev, arrival }) + '\n');
    }
    return record;
  }

  eventsFor(paymentId) { return this.byPayment.get(paymentId) ?? []; }
  rawFor(paymentId) { return this.rawByPayment.get(paymentId) ?? []; }
  paymentIds() { return [...this.rawByPayment.keys()]; }

  static readLog(file) {
    if (!file || !fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  clearFile() {
    if (this.file && fs.existsSync(this.file)) fs.writeFileSync(this.file, '');
  }
}
