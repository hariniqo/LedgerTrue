import { fmt } from './money.js';
import { groundCheck } from '../shared/grounding.js';
import { DEFAULT_NVIDIA_MODEL, chatEndpoint } from './nvidia.js';

const iso = (ts) => new Date(ts).toISOString().slice(11, 19) + 'Z';

function facts(snapshot, timeline) {
  return {
    paymentId: snapshot.paymentId,
    reconciledState: snapshot.state,
    amount: fmt(snapshot.amountCents, snapshot.currency),
    refunded: fmt(snapshot.refundedCents, snapshot.currency),
    confirmedByPayPalApi: snapshot.confirmed,
    naiveSystemWouldShow: snapshot.naive.state,
    recommendedAction: snapshot.recommended.label,
    anomalies: snapshot.anomalies.map((a) => `[${a.severity}] ${a.code}: ${a.message}`),
    transitions: snapshot.timeline.map((t) => `${iso(t.ts)} ${t.source} ${t.type}: ${t.from ?? 'NEW'} -> ${t.to}`),
    arrivals: timeline.map((t) => `#${t.arrival} ${iso(t.ts)} ${t.source} ${t.type}${t.duplicate ? ' (duplicate, ignored)' : ''}`),
  };
}

/** Deterministic note. Also used whenever NVIDIA NIM is unavailable, so the demo never breaks. */
export function fallbackNote(snapshot, timeline) {
  const f = facts(snapshot, timeline);
  const lines = [
    `Payment ${f.paymentId} for ${f.amount} is ${f.reconciledState}${f.confirmedByPayPalApi ? ' and confirmed by the PayPal API' : ''}.`,
  ];
  const first = snapshot.timeline[0];
  const last = snapshot.timeline.at(-1);
  if (first && last) lines.push(`It moved ${first.from ?? 'NEW'} -> ${last.to} across ${snapshot.timeline.length} transition(s), last at ${iso(last.ts)}.`);
  if (snapshot.ghost) lines.push(`A client timeout was recorded, but PayPal reports the money moved. A naive integration would show "${f.naiveSystemWouldShow}" and risk charging the customer twice.`);
  else if (f.naiveSystemWouldShow !== snapshot.state) lines.push(`A naive arrival-order integration would show "${f.naiveSystemWouldShow}", which is wrong.`);
  for (const a of snapshot.anomalies.filter((x) => x.severity !== 'info' && x.code !== 'GHOST_BALANCE').slice(0, 3)) lines.push(a.message);
  lines.push(`Recommended action: ${f.recommendedAction}`);
  return lines.join(' ');
}

export async function explain(snapshot, timeline, { apiKey, model = DEFAULT_NVIDIA_MODEL, baseUrl, fetchImpl = globalThis.fetch } = {}) {
  const fallback = fallbackNote(snapshot, timeline);
  if (!apiKey) return { note: fallback, source: 'fallback' };
  try {
    const res = await fetchImpl(chatEndpoint(baseUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              'You are a payments reconciliation analyst writing an audit note for a finance team. ' +
              'Use ONLY the facts provided. Do not invent events, times, amounts or causes. ' +
              'Write 3 to 5 plain-English sentences: what happened, why the system chose this state, ' +
              'what a naive integration would have got wrong (only if the facts show it), and the recommended action.',
          },
          { role: 'user', content: JSON.stringify(facts(snapshot, timeline), null, 2) },
        ],
        temperature: 0.2,
        max_tokens: 1200,
        stream: false,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`NVIDIA API ${res.status}`);
    const j = await res.json();
    const note = j.choices?.[0]?.message?.content?.trim();
    if (!note) throw new Error('empty response');
    const g = groundCheck(note, JSON.stringify(facts(snapshot, timeline)));
    if (!g.ok) return { note: fallback, source: 'fallback', rejected: g.problems };
    return { note, source: 'nvidia', model, grounded: true };
  } catch (e) {
    return { note: fallback, source: 'fallback', error: e.message };
  }
}
