import { h, clear, icon, toast, remember } from './dom.js';
import { api, setToken, hasToken, getConfig } from './api.js';
import { home } from './views/home.js';

// Speed: only the home view is loaded up front. Other pages, the key dialog and the assistant are fetched on demand,
// the web fonts load without blocking first paint, and /api/config is requested once, immediately, in parallel.
const loadFonts = () => {
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Unbounded:wght@500;700&family=Schibsted+Grotesk:wght@400;500;600;700&display=swap';
  document.head.append(l);
};
loadFonts();
const keyDialog = async (...a) => (await import('./views/keyDialog.js')).keyDialog(...a);

const bus = new EventTarget();
const ctx = { cfg: null, bus, owner: null, navigate: (to) => { location.hash = to; } };
ctx.cfgReady = getConfig().then((c) => { ctx.cfg = c; return c; }).catch(() => null);
ctx.ownerReady = import('./keys.js').then((m) => m.ownerKey()).then((o) => { ctx.owner = o; return o; })
  .catch(() => { toast('This browser blocked cryptographic keys, so mandates cannot be signed here.', 'error'); return null; });
const savedTheme = remember('lt-theme');
if (savedTheme === 'light' || savedTheme === 'dark') document.documentElement.dataset.theme = savedTheme;

const routes = [
  [/^#?\/?$/, () => home(ctx)],
  [/^#\/new$/, async () => (await import('./views/newMandate.js')).newMandate(ctx)],
  [/^#\/m\/(m_[a-f0-9]{24})(?:\/(activity|chain|proof))?$/, async (m) => (await import('./views/mandate.js')).mandateDetail(ctx, m[1], m[2] ?? 'activity')],
  [/^#\/reconcile$/, async () => (await import('./views/reconcile.js')).reconcile(ctx)],
  [/^#\/intel(?:\/(m_[a-f0-9]{24}))?$/, async (m) => (await import('./views/intel.js')).intel(ctx, m[1])],
];

const NAV = [
  ['#/', 'Overview', 'grid'],
  ['#/new', 'New mandate', 'plus'],
  ['#/reconcile', 'Reconciliation', 'scale'],
  ['#/intel', 'Intelligence', 'chart'],
];

const main = h('main', { class: 'main', id: 'main', tabindex: '-1' });
const nav = h('nav', { class: 'nav', 'aria-label': 'Main' });
const modeLine = h('div', { class: 'mode' });
const pageTitle = h('strong', { class: 'topbar-title' }, 'Overview');
const shell = h('div', { class: 'shell' });
const foot = h('div', { class: 'rail-foot' });
const railStatus = h('div', { class: 'rail-status' });
const accessButton = h('button', { class: 'access-button', onclick: tokenDialog }, 'Operator access');
const ownerButton = h('button', { onclick: () => keyDialog(ctx, renderFoot) }, icon('key', 16), 'Owner key');

function renderNav() {
  const here = location.hash || '#/';
  clear(nav, NAV.map(([href, label, ic]) => h('a', { href, 'aria-current': (href === '#/' ? /^#?\/?$|^#\/m\//.test(here) : (href === '#/intel' ? here.startsWith('#/intel') : here === href)) ? 'page' : null },
    h('span', { class: 'nav-icon' }, icon(ic)), h('span', { class: 'nav-label' }, label))));
}

function tokenDialog() {
  const input = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Paste the operator token', 'aria-label': 'Operator token' });
  const dlg = h('dialog', {},
    h('form', { method: 'dialog', onsubmit: () => { setToken(input.value); toast('Operator token saved for this tab'); renderFoot(); } },
      h('h2', {}, 'Operator access'),
      h('p', { class: 'muted small' }, 'Settling, releasing and resetting need the operator token set on the server. It is kept only in this tab\'s session storage.'),
      input,
      h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, 'Save token'), h('button', { type: 'button', onclick: () => dlg.close() }, 'Cancel'))));
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener('close', () => dlg.remove());
}

function renderFoot() {
  const c = ctx.cfg;
  clear(foot,
    ownerButton,
    h('span', { class: 'security-foot' }, c?.authRequired ? 'Protected workspace' : 'Open local demo'),
    h('span', { class: 'hide-sm' }, 'Independent hackathon project. Not affiliated with PayPal.'));
  clear(railStatus, modeLine);
  ownerButton.lastChild.textContent = ctx.owner?.recoverable ? 'Owner key · backup enabled' : 'Owner key';
  accessButton.hidden = !c?.authRequired;
  accessButton.textContent = hasToken() ? 'Operator access set' : 'Operator access';
  clear(modeLine, h('span', { class: `dot ${c?.mode === 'simulator' ? 'sim' : ''}` }), c ? `PayPal: ${c.mode}` : 'connecting…');
}

function syncThemeButton() {
  const dark = document.documentElement.dataset.theme === 'dark'
    || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  const target = dark ? 'light' : 'dark';
  themeButton.setAttribute('aria-label', `Switch to ${target} theme`);
  themeButton.title = `Switch to ${target} theme`;
  clear(themeButton, icon(dark ? 'sun' : 'moon', 18));
}

function toggleTheme() {
  const currentTheme = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = nextTheme;
  remember('lt-theme', nextTheme);
  syncThemeButton();
}
const themeButton = h('button', { class: 'icon-button', type: 'button', onclick: toggleTheme, 'aria-label': 'Switch theme', title: 'Switch theme' }, icon('moon', 18));
const topOwnerButton = h('button', { class: 'icon-button top-owner-key', type: 'button', onclick: () => keyDialog(ctx, renderFoot), 'aria-label': 'Manage owner signing key', title: 'Manage owner key' }, icon('key', 18));
const sidebarToggle = h('button', { class: 'icon-button rail-toggle', type: 'button', 'aria-label': 'Collapse navigation', 'aria-expanded': 'true', onclick: () => {
  const collapsed = shell.classList.toggle('sidebar-collapsed');
  sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
  sidebarToggle.setAttribute('aria-label', collapsed ? 'Expand navigation' : 'Collapse navigation');
} }, icon('menu', 18));

let current = null;
let seq = 0;
async function render() {
  renderNav();
  current?.destroy?.();
  current = null;
  const my = ++seq;
  const hash = location.hash || '#/';
  for (const [re, make] of routes) {
    const m = hash.match(re);
    if (!m) continue;
    if (!main.firstChild) clear(main, h('div', { class: 'empty' }, h('p', { class: 'muted' }, 'Loading…')));
    main.classList.add('loading'); // instant feedback while the page's data arrives
    let made;
    try {
      if (!/^#?\/?$/.test(hash)) await Promise.all([ctx.cfgReady, ctx.ownerReady]); // the home page waits for config itself, in parallel with its data
      made = await make(m);
    } catch (e) { made = { el: h('div', { class: 'callout bad' }, icon('alert'), e.message) }; }
    if (my !== seq) { made?.destroy?.(); return; } // the user already moved on to another page
    current = made;
    main.classList.remove('loading');
    clear(main, current.el);
    pageTitle.textContent = current.title ?? 'LedgerTrue';
    document.title = `${current.title ? current.title + ' · ' : ''}LedgerTrue`;
    window.scrollTo(0, 0);
    return;
  }
  clear(main, h('div', { class: 'empty' }, h('h2', {}, 'Page not found'), h('a', { class: 'btn primary', href: '#/' }, 'Back to mandates')));
}

function connect() {
  const es = new EventSource('/api/events');
  for (const name of ['block', 'raw', 'payment', 'reset']) es.addEventListener(name, (e) => bus.dispatchEvent(new CustomEvent(name, { detail: JSON.parse(e.data) })));
  es.onerror = () => { modeLine.lastChild && (modeLine.lastChild.textContent = 'reconnecting…'); };
  es.onopen = () => renderFoot();
}

(async function boot() {
  const rail = h('aside', { class: 'rail' },
    h('div', { class: 'rail-head' },
      h('a', { class: 'brand', href: '#/' }, h('span', { class: 'mark' }, icon('shield', 18)), h('span', { class: 'brand-name' }, 'LedgerTrue')),
      sidebarToggle),
    nav,
    railStatus,
    h('div', { class: 'rail-bottom' }, foot));
  const topbar = h('header', { class: 'topbar' },
    h('div', { class: 'topbar-heading' }, h('span', { class: 'topbar-kicker' }, 'WORKSPACE /'), pageTitle),
    h('div', { class: 'topbar-actions' }, themeButton, topOwnerButton, accessButton, h('span', { class: 'profile-mark', 'aria-hidden': 'true' }, 'LT')));
  shell.append(rail, h('div', { class: 'workspace' }, topbar, main));
  document.body.append(shell);
  syncThemeButton();
  renderNav();
  renderFoot();
  window.addEventListener('hashchange', render);
  render(); // first paint no longer waits for config, the signing key, the SSE stream or the assistant
  ctx.cfgReady.then((c) => {
    if (!c) toast('Cannot reach the LedgerTrue server.', 'error');
    renderFoot();
    if (c?.boot?.quarantined?.length) toast(`${c.boot.quarantined.length} chain(s) failed their integrity check and are quarantined.`, 'error');
  });
  ctx.ownerReady.then(() => renderFoot());
  connect();
  setTimeout(() => import('./assistant.js').then((m) => {
    const assistantUi = m.assistant(ctx);
    window.addEventListener('beforeunload', () => assistantUi.destroy(), { once: true });
  }), 0);
  remember('lt-visited', '1');
})();
