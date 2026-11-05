// Deterministic text screening. Shared by the guard (to decide) and the verifier (to re-check the guard).
// Anything an agent writes is untrusted input: it is scanned, never obeyed.

const INJECTION = [
  /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?|prompts?|limits?)/i,
  /disregard\s+.{0,40}(rules?|instructions?|mandate|limits?|budget)/i,
  /(reveal|print|show)\s+.{0,20}(system\s+prompt|api\s*key|secret)/i,
  /you\s+are\s+now\s+/i,
  /override\s+(the\s+)?(limit|budget|mandate|rules?|cap)/i,
  /do\s+not\s+(tell|inform|notify|alert)\s+(the\s+)?(user|owner|human)/i,
  /(approve|authori[sz]e)\s+(this\s+)?(automatically|without\s+(asking|approval|review))/i,
  /new\s+instructions?\s*:/i,
];

const RESTRICTED = [
  'gift card', 'giftcard', 'prepaid card', 'crypto', 'bitcoin', 'usdt', 'wire transfer',
  'western union', 'moneygram', 'cash advance', 'casino', 'gambling', 'lottery',
];

export function scanText(...parts) {
  const text = parts.filter(Boolean).join(' \n ');
  const injection = INJECTION.filter((re) => re.test(text)).map((re) => re.source.slice(0, 40));
  const lower = text.toLowerCase();
  const restricted = RESTRICTED.filter((w) => lower.includes(w));
  return { injection, restricted };
}

const STOP = new Set('the a an and or for with from this that your our their into onto over under about have has will shall must buy purchase pay payment order items item need needs get set'.split(' '));
const tokens = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !STOP.has(t));

/** Cheap offline goal check: does the request share any vocabulary with the mandate goal? Escalates only. */
export function goalOverlap(goal, ...requestParts) {
  const g = new Set(tokens(goal));
  if (!g.size) return { applicable: false, overlap: true };
  const r = tokens(requestParts.join(' '));
  return { applicable: true, overlap: r.some((t) => g.has(t) || [...g].some((x) => x.startsWith(t.slice(0, 5)) && t.length >= 5)) };
}
