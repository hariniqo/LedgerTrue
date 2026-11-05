import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { GENESIS } from '../../shared/crypto.js';
import { blockHash, verifyBundle } from '../../shared/verify.js';
import { emptyState, checkTransition, applyBlock, budgetViolation, summarize, BLOCK } from '../../shared/rules.js';

/** Promise-based mutex. Hashing and signing are async, so without this two appends could interleave and fork the chain. */
export class Mutex {
  #tail = Promise.resolve();
  run(fn) {
    const next = this.#tail.then(fn, fn);
    this.#tail = next.catch(() => {});
    return next;
  }
}

export class ChainError extends Error {
  constructor(message, violations = []) { super(message); this.name = 'ChainError'; this.violations = violations; }
}

/**
 * One append-only chain per mandate. Blocks are only ever added. On disk each chain is a JSONL file.
 * On boot every chain is re-verified; a chain that fails is quarantined (readable, but it refuses new blocks).
 */
export class ChainStore extends EventEmitter {
  constructor({ dir = null, guard, now = () => Date.now() }) {
    super();
    this.dir = dir;
    this.guard = guard;
    this.now = now;
    this.chains = new Map(); // mandateId -> { blocks, state, mutex, quarantined }
    if (dir) fs.mkdirSync(dir, { recursive: true });
  }

  async load() {
    if (!this.dir) return { loaded: 0, quarantined: [] };
    const quarantined = [];
    for (const f of fs.readdirSync(this.dir).filter((x) => /^m_[a-f0-9]{24}\.jsonl$/.test(x))) {
      const id = f.slice(0, -6);
      const blocks = fs.readFileSync(path.join(this.dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const bundle = { mandateId: id, guard: { keyId: this.guard.keyId, publicKeyJwk: this.guard.publicKeyJwk }, blocks };
      const res = await verifyBundle(bundle);
      const chain = { blocks, state: emptyState(), mutex: new Mutex(), quarantined: !res.ok };
      if (res.ok) for (const b of blocks) applyBlock(chain.state, b);
      else quarantined.push({ id, firstBadIndex: res.firstBadIndex, issues: res.blocks.find((b) => !b.ok)?.issues ?? res.issues });
      this.chains.set(id, chain);
    }
    return { loaded: this.chains.size, quarantined };
  }

  has(id) { return this.chains.has(id); }
  ids() { return [...this.chains.keys()]; }
  get(id) { return this.chains.get(id) ?? null; }

  /** Create a chain with its signed MANDATE block. */
  create(mandateId, data) {
    if (this.chains.has(mandateId)) throw new ChainError('mandate already exists');
    const chain = { blocks: [], state: emptyState(), mutex: new Mutex(), quarantined: false };
    this.chains.set(mandateId, chain);
    return chain.mutex.run(async () => {
      try { return await this.#append(mandateId, chain, BLOCK.MANDATE, data); } catch (e) { this.chains.delete(mandateId); throw e; }
    });
  }

  /** Run `fn` while holding the chain's lock. Everything inside sees a stable state. */
  exclusive(mandateId, fn) {
    const chain = this.#need(mandateId);
    return chain.mutex.run(() => fn({
      state: chain.state,
      blocks: chain.blocks,
      append: (type, data) => this.#append(mandateId, chain, type, data),
    }));
  }

  /** Convenience: lock, append one block, release. */
  append(mandateId, type, data) {
    return this.exclusive(mandateId, ({ append }) => append(type, data));
  }

  #need(id) {
    const c = this.chains.get(id);
    if (!c) throw new ChainError('unknown mandate');
    return c;
  }

  async #append(mandateId, chain, type, data) {
    if (chain.quarantined) throw new ChainError('chain failed integrity check and is quarantined');
    const prev = chain.blocks.at(-1);
    const block = {
      index: chain.blocks.length,
      ts: Math.max(this.now(), prev?.ts ?? 0), // never goes backwards
      type,
      mandateId,
      data,
      prevHash: prev?.hash ?? GENESIS,
    };
    // Refuse to write anything the rules would later call illegal. The verifier is the second line of defence.
    const violations = checkTransition(chain.state, block);
    if (violations.length) throw new ChainError(violations[0], violations);
    block.hash = await blockHash(block);
    block.guardSig = await this.guard.sign(block.hash);

    const shadow = structuredClone(chain.state);
    applyBlock(shadow, block);
    const bv = budgetViolation(shadow);
    if (bv) throw new ChainError(bv, [bv]);

    if (this.dir) fs.appendFileSync(path.join(this.dir, `${mandateId}.jsonl`), JSON.stringify(block) + '\n');
    chain.blocks.push(block);
    applyBlock(chain.state, block);
    this.emit('block', { mandateId, block, summary: summarize(chain.state) });
    return block;
  }

  bundle(mandateId) {
    const c = this.#need(mandateId);
    return {
      version: 1,
      mandateId,
      guard: { keyId: this.guard.keyId, publicKeyJwk: this.guard.publicKeyJwk },
      quarantined: c.quarantined,
      head: { index: c.blocks.length - 1, hash: c.blocks.at(-1)?.hash ?? null },
      blocks: c.blocks,
    };
  }

  summary(mandateId) {
    const c = this.#need(mandateId);
    const m = c.state.mandate;
    return {
      id: mandateId,
      title: m?.title, goal: m?.goal, helper: m?.helper, currency: m?.currency, expiresAt: m?.expiresAt, createdAt: m?.createdAt,
      height: c.blocks.length, headHash: c.blocks.at(-1)?.hash ?? null, quarantined: c.quarantined,
      ...summarize(c.state),
    };
  }
}
