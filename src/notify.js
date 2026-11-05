// Pushes a short phone/desktop alert when a request needs the owner's signature or was blocked by the rules.
// Works with any ntfy-compatible endpoint (https://ntfy.sh/<your-private-topic>). Text only: no amounts, keys or signatures.
// Read-only: it listens to chain events and can never approve, block or move money.
const clean = (s, n = 140) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n);

export function attachNotifier(engine, { url = '', publicUrl = '', fetchImpl = globalThis.fetch } = {}) {
  if (!url) return { enabled: false };
  const state = { enabled: true, sent: 0, lastError: null };
  engine.on('block', ({ mandateId, block }) => {
    if (block.type !== 'DECISION') return;
    const outcome = block.data?.outcome;
    if (outcome !== 'NEEDS_APPROVAL' && outcome !== 'BLOCKED') return;
    const needs = outcome === 'NEEDS_APPROVAL';
    const reasons = Array.isArray(block.data.reasons) ? block.data.reasons.map((r) => clean(r, 60)).join('; ') : '';
    const headers = { Title: needs ? 'LedgerTrue: your signature is needed' : 'LedgerTrue: a request was blocked', Priority: needs ? 'high' : 'default' };
    if (publicUrl) headers.Click = `${publicUrl.replace(/\/$/, '')}/#/m/${encodeURIComponent(mandateId)}`;
    Promise.resolve(fetchImpl(url, { method: 'POST', headers, body: clean(reasons || (needs ? 'Open the mandate to approve or reject.' : 'Blocked by the mandate rules.')), signal: AbortSignal.timeout?.(5000) }))
      .then((r) => { if (!r.ok) throw new Error(`notify answered ${r.status}`); state.sent += 1; state.lastError = null; })
      .catch((e) => { state.lastError = e.message; });
  });
  return state;
}