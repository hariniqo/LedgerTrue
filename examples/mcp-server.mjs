#!/usr/bin/env node
// A real agent connector. This is a zero-dependency MCP (Model Context Protocol) server over stdio, so any MCP client
// (Claude Desktop, Claude Code, an agent SDK) can spend money ONLY through a LedgerTrue mandate.
// The agent cannot raise its own limits: every request goes through the server's deterministic rules.
//
//   LEDGERTRUE_URL=http://localhost:3000 MANDATE_ID=m_... AGENT_ID=my-agent [AGENT_TOKEN=...] node examples/mcp-server.mjs
//
// Claude Desktop / Claude Code config:  { "command": "node", "args": ["examples/mcp-server.mjs"], "env": { ... } }
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const BASE = (process.env.LEDGERTRUE_URL || 'http://localhost:3000').replace(/\/$/, '');
const MANDATE = process.env.MANDATE_ID || '';
const AGENT = process.env.AGENT_ID || 'mcp-agent';
const TOKEN = process.env.AGENT_TOKEN || '';

export const toMinor = (text) => {
  const m = String(text).trim().replace(/,/g, '').match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new Error(`"${text}" is not a valid amount (use digits with at most 2 decimals)`);
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0);
};

const call = async (method, path, body) => {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `LedgerTrue answered ${res.status}`);
  return j;
};

const TOOLS = [
  {
    name: 'request_payment',
    description: 'Ask to spend money from your spending mandate. The mandate\'s rules decide, not you: the request may be approved (funds are held), blocked, or sent to the human owner for approval. Never retry a blocked request with different wording to get around a rule.',
    inputSchema: {
      type: 'object', required: ['merchant', 'amount', 'reason'],
      properties: {
        merchant: { type: 'string', description: 'Who gets paid, exactly as in the mandate\'s allowed list' },
        amount: { type: 'string', description: 'Amount as decimal text, e.g. "249.99"' },
        reason: { type: 'string', description: 'Why this purchase serves the mandate goal, in plain words' },
        item: { type: 'string', description: 'What is being bought' },
        category: { type: 'string', description: 'Purchase category, e.g. "office"' },
      },
    },
  },
  { name: 'check_budget', description: 'See the mandate goal, budget, what is already spent or on hold, and what is still available.', inputSchema: { type: 'object', properties: {} } },
  { name: 'proof_link', description: 'Get the public link where anyone can verify everything this mandate has done.', inputSchema: { type: 'object', properties: {} } },
];

const text = (s, isError = false) => ({ content: [{ type: 'text', text: s }], isError });

export async function runTool(name, args = {}) {
  if (!MANDATE) return text('MANDATE_ID is not set for this connector.', true);
  try {
    if (name === 'request_payment') {
      const r = await call('POST', `/api/mandates/${MANDATE}/requests`, {
        agentId: AGENT, merchant: String(args.merchant ?? ''), amountCents: toMinor(args.amount), reason: String(args.reason ?? ''),
        item: args.item ? String(args.item) : undefined, category: args.category ? String(args.category) : undefined,
      });
      const why = r.reasons?.length ? ` Reasons: ${r.reasons.join(', ')}.` : '';
      const next = r.outcome === 'NEEDS_APPROVAL' ? ' The human owner must approve before any money moves. Wait; do not resubmit.' : r.outcome === 'BLOCKED' ? ' Do not try to work around this. Tell the user.' : '';
      return text(`Request ${r.requestId}: ${r.outcome}. Status ${r.status}.${why}${next}`);
    }
    if (name === 'check_budget') {
      const { summary: s } = await call('GET', `/api/mandates/${MANDATE}`);
      const f = (c) => `${(c / 100).toFixed(2)} ${s.currency}`;
      return text(`Goal: ${s.goal}. Budget available: ${f(s.availableCents)} (settled ${f(s.settledCents)}, on hold ${f(s.heldCents)}). Valid until ${new Date(s.expiresAt).toISOString()}${s.revoked ? ' (REVOKED)' : ''}.`);
    }
    if (name === 'proof_link') return text(`${BASE}/verify/${MANDATE}`);
    return text(`Unknown tool ${name}`, true);
  } catch (e) { return text(`LedgerTrue error: ${e.message}`, true); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.id === undefined) return; // notifications need no reply
    if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ledgertrue', version: '1.1.0' } } });
    if (m.method === 'ping') return send({ id: m.id, result: {} });
    if (m.method === 'tools/list') return send({ id: m.id, result: { tools: TOOLS } });
    if (m.method === 'tools/call') return send({ id: m.id, result: await runTool(m.params?.name, m.params?.arguments) });
    send({ id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
  });
}
