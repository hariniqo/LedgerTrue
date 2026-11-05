#!/usr/bin/env node
// Pre-submission check against the PayPal AI Hackathon rules and basic hygiene. Never prints a secret value.
//   node tools/preflight.mjs [directory]        exit 0 = no failures (warnings may remain), 1 = fix before publishing
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function preflight(root) {
  const fails = []; const warns = []; const passes = [];
  const rel = (f) => path.relative(root, f);
  const exists = (p) => fs.existsSync(path.join(root, p));
  const read = (p) => (exists(p) ? fs.readFileSync(path.join(root, p), 'utf8') : '');

  // 1. Open-source license file (rule: public repo with a detectable license).
  const lic = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].find(exists);
  if (!lic) fails.push('No LICENSE file. The rules require an open-source license that is detectable in the repo.');
  else if (/MIT License|Apache License|BSD|GNU General Public/i.test(read(lic))) passes.push(`${lic} present`);
  else warns.push(`${lic} exists but is not a recognizable open-source license.`);

  // 2. Secrets. Walk every text file; report file:line and the kind, never the value.
  const walk = (d, out = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.git'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p, out); else if (e.isFile() && fs.statSync(p).size < 2_000_000) out.push(p);
    }
    return out;
  };
  const placeholder = (v) => !v || /^(your|xxx|<|changeme|example|placeholder)/i.test(v) || /\.\.\.|<.*>/.test(v);
  const KEY_LINE = /^\s*(PAYPAL_CLIENT_ID|PAYPAL_CLIENT_SECRET|PAYPAL_WEBHOOK_ID|NVIDIA_API_KEY|OPERATOR_TOKEN|AGENT_TOKEN|ANCHOR_WEBHOOK_TOKEN)\s*=\s*(.*?)\s*$/;
  let leaks = 0;
  for (const f of walk(root)) {
    const text = fs.readFileSync(f, 'utf8');
    if (text.includes('\0')) continue;
    text.split('\n').forEach((line, i) => {
      const m = line.match(KEY_LINE);
      if (m && !placeholder(m[2].replace(/^['"]|['"]$/g, '')) && /\.env/.test(path.basename(f))) { leaks++; fails.push(`${rel(f)}:${i + 1} holds a real-looking ${m[1]} value. Put secrets only in .env (gitignored), never in .env.example. Rotate this key: treat it as leaked.`); }
      else if (/nvapi-[A-Za-z0-9_-]{20,}/.test(line)) { leaks++; fails.push(`${rel(f)}:${i + 1} contains an NVIDIA key. Rotate it and remove it from the file.`); }
      else if (/"d"\s*:\s*"[A-Za-z0-9_-]{40,}"/.test(line) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(line)) {
        leaks++; fails.push(`${rel(f)}:${i + 1} contains a private key.`);
      }
    });
  }
  if (!leaks) passes.push('no secrets found in any text file');
  for (const p of ['.env', 'data/guard-key.json']) if (exists(p)) fails.push(`${p} is in this folder. Exclude it from anything you publish; keep local runtime keys intact.`);
  if (exists('data')) warns.push('data/ exists (chains, anchors, guard key). Make sure it is not committed.');

  // 3. .gitignore protects the secrets.
  const gi = read('.gitignore');
  for (const need of ['.env', 'data/']) if (!gi.split('\n').some((l) => l.trim() === need || l.trim() === need.replace(/\/$/, ''))) fails.push(`.gitignore does not ignore ${need}`);
  if (gi) passes.push('.gitignore reviewed');

  // 4. Required documents for judges.
  const readme = read('README.md');
  for (const [label, re] of [['how to run it', /## Run it/i], ['hackathon section', /## .*Hackathon/i], ['responsible AI section', /## .*Responsible AI/i]]) {
    if (re.test(readme)) passes.push(`README: ${label}`); else fails.push(`README is missing: ${label}`);
  }
  for (const f of ['docs/SUBMISSION.md', 'docs/VIDEO_SCRIPT.md', 'docs/RESPONSIBLE_AI.md', 'SECURITY.md']) if (!exists(f)) fails.push(`${f} is missing`); else passes.push(`${f} present`);

  // 5. Things only the entrant can supply. Warnings, not failures: they cannot be generated.
  const sub = read('docs/SUBMISSION.md');
  const todos = [...sub.matchAll(/TODO[^\n]*/g)].map((m) => m[0].slice(0, 90));
  for (const t of todos) warns.push(`SUBMISSION.md: ${t}`);

  const pkg = (() => { try { return JSON.parse(read('package.json')); } catch { return {}; } })();
  if (!pkg.license) fails.push('package.json has no license field'); else passes.push(`package.json license: ${pkg.license}`);
  return { fails, warns, passes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(process.argv[2] ?? '.');
  const { fails, warns, passes } = preflight(root);
  for (const p of passes) console.log(`  ok    ${p}`);
  for (const w of warns) console.log(`  WARN  ${w}`);
  for (const f of fails) console.log(`  FAIL  ${f}`);
  console.log(fails.length ? `\n${fails.length} problem(s) to fix before publishing.` : `\nNo failures.${warns.length ? ` ${warns.length} item(s) only you can complete (see WARN).` : ''}`);
  process.exit(fails.length ? 1 : 0);
}
