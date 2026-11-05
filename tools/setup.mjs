// One-command first-run setup: creates .env from .env.example if it does not exist. Never overwrites, never prints secrets.
import fs from 'node:fs';
if (fs.existsSync('.env')) console.log('.env already exists. Left untouched.');
else { fs.copyFileSync('.env.example', '.env'); console.log('Created .env (local demo mode, loopback only). Add AI_API_KEY and PayPal sandbox keys there if you have them.'); }
console.log('Next: npm start, then open http://localhost:3000');
