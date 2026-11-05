// Data minimisation: the ML service receives only what the models use. No free text (reason, item), no signatures,
// no hashes, no PayPal ids. A mandate's chain is already public via /bundle, but the model never needs the prose.
const PICK = {
  MANDATE: (d) => ({ mandate: d.mandate }),
  REQUEST: (d) => ({ requestId: d.requestId, agentId: d.agentId, merchant: d.merchant, amountCents: d.amountCents, category: d.category }),
  DECISION: (d) => ({ requestId: d.requestId, outcome: d.outcome, reasons: d.reasons }),
  APPROVAL: (d) => ({ requestId: d.requestId, decision: d.decision }),
  HOLD: (d) => ({ requestId: d.requestId, amountCents: d.amountCents }),
  CAPTURE: (d) => ({ requestId: d.requestId, amountCents: d.amountCents }),
  VOID: (d) => ({ requestId: d.requestId }),
  RECON: (d) => ({ requestId: d.requestId }),
  REVOKE: () => ({}),
};

export function slimBlocks(blocks) {
  return blocks.map((b) => ({ index: b.index, ts: b.ts, type: b.type, data: (PICK[b.type] ?? (() => ({})))(b.data ?? {}) }));
}

export function slimEvents(raws) {
  return raws.map((r) => ({
    type: r.type, source: r.source, ts: r.ts, amountCents: r.amountCents ?? null,
    duplicate: Boolean(r.duplicate), arrival: r.arrival, receivedAt: r.receivedAt,
  }));
}
