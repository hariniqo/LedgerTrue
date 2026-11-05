// Usage: TOKEN_SECRET=... node tools/mint-token.mjs agent 3600
// Prints a signed token that expires after the given seconds (default 1 hour). Roles: agent | operator.
import { signToken } from '../src/security.js';
const [role = 'agent', ttl = '3600'] = process.argv.slice(2);
if (!process.env.TOKEN_SECRET) { console.error('Set TOKEN_SECRET first'); process.exit(1); }
if (!['agent', 'operator'].includes(role)) { console.error('Role must be agent or operator'); process.exit(1); }
console.log(signToken(process.env.TOKEN_SECRET, role, Number(ttl)));
