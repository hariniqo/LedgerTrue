// Anchor mirror: keep a copy of the server's anchor log somewhere the operator cannot edit (a public repo, a laptop).
// Each fetch must EXTEND the mirror. If any earlier anchor differs, history was rewritten, even by the guard-key holder.
import { verifyAnchorLog } from './anchors.js';

/** mirror: { guard, entries } or null (first use). fresh: { guard, entries } as served by /.well-known/ledgertrue-anchors.json. */
export async function mergeMirror(mirror, fresh) {
  const issues = [];
  const guard = fresh?.guard;
  if (!guard?.publicKeyJwk || !Array.isArray(fresh?.entries)) return { ok: false, issues: ['The server reply is not an anchor log.'], merged: mirror, added: 0 };
  if (mirror && mirror.guard?.keyId !== guard.keyId) issues.push(`Guard key changed from ${mirror.guard?.keyId} to ${guard.keyId}. Treat this as a different operator until you can explain it.`);
  const v = await verifyAnchorLog(fresh.entries, guard.publicKeyJwk);
  issues.push(...v.issues);
  const old = mirror?.entries ?? [];
  if (fresh.entries.length < old.length) issues.push(`The log is shorter than your mirror (${fresh.entries.length} < ${old.length}): anchors were removed.`);
  for (let i = 0; i < Math.min(old.length, fresh.entries.length); i++) {
    if (old[i].hash !== fresh.entries[i].hash) { issues.push(`Anchor ${i} differs from the copy you saved: history was rewritten.`); break; }
  }
  if (issues.length) return { ok: false, issues, merged: mirror, added: 0 };
  return { ok: true, issues: [], merged: { guard, entries: fresh.entries, updatedAt: new Date().toISOString() }, added: fresh.entries.length - old.length };
}
