#!/usr/bin/env node
// Lists the chat models your NVIDIA key can use right now, optionally testing each one.
//   node --env-file=.env tools/list-models.mjs            list model IDs
//   node --env-file=.env tools/list-models.mjs --test nemotron   test models whose ID contains "nemotron"
import { nvidiaChatCompletion, DEFAULT_NVIDIA_BASE_URL } from '../src/nvidia.js';

const e = process.env;
const key = e.AI_API_KEY || e.NVIDIA_API_KEY;
const base = (e.AI_BASE_URL || e.NVIDIA_BASE_URL || DEFAULT_NVIDIA_BASE_URL).replace(/\/+$/, '');
if (!key) { console.log('No AI_API_KEY / NVIDIA_API_KEY in .env'); process.exit(1); }

const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
if (!res.ok) { console.log(`Could not list models: HTTP ${res.status}`); process.exit(1); }
const ids = (await res.json()).data.map((m) => m.id).filter((id) => !/embed|rerank|parse|clip|vision|vl\b|guard|safety|reward|speech|tts|asr|image|video/i.test(id)).sort();

const i = process.argv.indexOf('--test');
if (i < 0) { console.log(ids.join('\n')); console.log(`\n${ids.length} models. Test some with: --test <word>`); process.exit(0); }

const word = (process.argv[i + 1] || '').toLowerCase();
for (const id of ids.filter((x) => x.toLowerCase().includes(word)).slice(0, 8)) {
  const t = Date.now();
  try {
    const out = await nvidiaChatCompletion({ apiKey: key, model: id, baseUrl: base, maxTokens: 300, timeoutMs: 25_000,
      messages: [{ role: 'system', content: 'Reply with JSON only: {"answer":"..."}' }, { role: 'user', content: 'Say hello.' }] });
    const jsonOk = /\{[\s\S]*\}/.test(out);
    console.log(`OK    ${id}  ${Date.now() - t} ms  json=${jsonOk}`);
  } catch (err) { console.log(`FAIL  ${id}  ${err.code ?? err.name}`); }
}
