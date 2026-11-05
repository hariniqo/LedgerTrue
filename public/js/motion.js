// Motion layer: staggers, KPI count-up and the sign-in gate. Text is set with textContent only.
import { setToken, getConfig } from './api.js';
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const el = (t, c, txt) => { const e = document.createElement(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e; };
const STAG = '.blk,.req,.activity-row,.feed .ev,.story li,.assistant-message,.flow-step,.kpi';

function countUp(v) {
  if (RM || v.dataset.ltc) return;
  const m = v.textContent.match(/^(\D*)([\d,]+(?:\.\d+)?)(\D*)$/);
  if (!m) return;
  v.dataset.ltc = 1;
  const to = parseFloat(m[2].replace(/,/g, '')), dec = (m[2].split('.')[1] || '').length, t0 = performance.now();
  const f = (t) => {
    const p = Math.min(1, (t - t0) / 400);
    v.textContent = m[1] + (to * (1 - Math.pow(1 - p, 3))).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + m[3];
    if (p < 1) requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
}
function enhance(n) {
  if (n.nodeType !== 1) return;
  for (const e of [n, ...n.querySelectorAll(STAG)]) {
    if (!e.matches(STAG) || e.dataset.ltm || !e.parentElement) continue;
    e.dataset.ltm = 1;
    e.style.setProperty('--i', [...e.parentElement.children].indexOf(e));
  }
  for (const v of [n, ...n.querySelectorAll('.kpi-value')]) if (v.matches('.kpi-value')) countUp(v);
}
new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach(enhance))).observe(document.body, { childList: true, subtree: true });

async function gate() {
  try { if (sessionStorage.getItem('lt-gate')) return; } catch { /* storage blocked: show the gate each time */ }
  let cfg = {};
  try { cfg = await getConfig(); } catch { /* offline: the app shows its own error */ }
  // Open demo mode has nothing to sign in to, so the full-screen intro only delayed the home page. Add ?intro to a URL to play it.
  if (!cfg.authRequired && !new URLSearchParams(location.search).has('intro')) { try { sessionStorage.setItem('lt-gate', '1'); } catch { /* ignore */ } return; }
  const root = el('div', 'gate'), left = el('div'), form = el('form'), h1 = el('h1');
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Sign in to LedgerTrue');
  ['Don\u2019t just trust the payment.', 'Verify the intent.'].forEach((t) => { const l = el('span', 'ln'); l.append(el('span', null, t)); h1.append(l); });
  const viz = el('div', 'viz');
  for (let i = 0; i < 4; i++) {
    if (i) { const k = el('i', 'gk'); k.style.setProperty('--d', (0.3 + i * 0.12 - 0.05) + 's'); viz.append(k); }
    const b = el('div', 'gl'); b.style.setProperty('--d', (0.3 + i * 0.12) + 's'); viz.append(b);
  }
  left.append(el('div', 'brand-name', 'LedgerTrue'), h1,
    el('p', 'lead', 'Signed spending mandates, PayPal holds and captures, and a hash-chained ledger anyone can verify.'), viz);
  const token = el('input'); token.type = 'password'; token.autocomplete = 'off'; token.placeholder = 'Paste the operator token';
  form.append(el('h2', null, 'Sign in'));
  if (cfg.authRequired) { const lb = el('label', null, 'Operator token'); lb.append(token); form.append(lb); }
  else form.append(el('p', 'muted small', 'Demo mode is on, so no token is needed. PayPal runs as: ' + (cfg.mode || 'sandbox') + '.'));
  const go = el('button', 'primary', cfg.authRequired ? 'Sign in as operator' : 'Enter the demo workspace'); go.type = 'submit';
  const view = el('button', null, 'Continue as viewer'); view.type = 'button';
  form.append(go, view, el('p', 'fine', cfg.authRequired ? 'Operators can settle, release and reset. Viewers can only read and verify.' : 'Demo mode is open on this machine, so this screen only introduces the workspace.'));
  root.append(left, form);
  const done = (reload) => {
    try { sessionStorage.setItem('lt-gate', '1'); } catch { /* ignore */ }
    root.classList.add('leave');
    setTimeout(() => { root.remove(); if (reload) location.reload(); }, RM ? 0 : 250);
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    if (cfg.authRequired) { const v = token.value.trim(); if (!v) { token.focus(); return; } setToken(v); done(true); } else done(false);
  };
  view.onclick = () => done(false);
  if (!cfg.authRequired && !RM) setTimeout(() => { if (root.isConnected && !root.classList.contains('leave')) done(false); }, 1500); // open demo: no token to enter, so don't make people wait for a click
  document.body.append(root);
  (cfg.authRequired ? token : go).focus();
}
gate();
