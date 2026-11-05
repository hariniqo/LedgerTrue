#!/usr/bin/env node
// Copy the anchor log out of the server into a file YOU control, and fail loudly if history was rewritten.
//   node tools/anchor-mirror.mjs https://your-app.example mirror/anchors.json
// Run it on a schedule from a place the operator cannot edit (see .github/workflows/anchor-mirror.yml).
// Then verify any proof file against it:  node tools/verify-proof.mjs proof.json --anchors mirror/anchors.json
import fs from 'node:fs';
import path from 'node:path';
import { mergeMirror } from '../shared/mirror.js';

const [base, file] = process.argv.slice(2);
if (!base || !file) { console.error('usage: node tools/anchor-mirror.mjs <server-url> <mirror-file>'); process.exit(2); }
const res = await fetch(new URL('/.well-known/ledgertrue-anchors.json', base));
if (!res.ok) { console.error(`Could not fetch anchors: HTTP ${res.status}`); process.exit(2); }
const mirror = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const r = await mergeMirror(mirror, await res.json());
if (!r.ok) { console.error('MIRROR CHECK FAILED'); for (const i of r.issues) console.error('  ' + i); process.exit(1); }
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(r.merged, null, 2) + '\n');
console.log(`OK: ${r.merged.entries.length} anchors mirrored (${r.added} new). History extends your earlier copy.`);
