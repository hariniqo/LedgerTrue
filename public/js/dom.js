// Tiny DOM toolkit. Text is always inserted as text nodes, never parsed as HTML, so request text written by an
// agent (which is untrusted) cannot inject markup. There is no innerHTML anywhere in the app.

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  put(el, kids);
  return el;
}

export function put(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return el;
}

export const clear = (el, ...kids) => { el.replaceChildren(); return put(el, kids); };

const NS = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const k of kids.flat()) if (k) el.append(k);
  return el;
}

const ICONS = {
  shield: 'M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z M9 12l2 2 4-4',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6L6 18',
  clock: 'M12 7v5l3 2 M12 3a9 9 0 100 18 9 9 0 000-18z',
  lock: 'M7 11V8a5 5 0 0110 0v3 M6 11h12v9H6z',
  link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1 M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',
  home: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z',
  file: 'M7 3h7l4 4v14H7z M14 3v4h4',
  scale: 'M12 4v16 M6 20h12 M5 8l-3 7a4 4 0 006 0L5 8z M19 8l-3 7a4 4 0 006 0l-3-7z M5 8h14',
  plus: 'M12 5v14M5 12h14',
  key: 'M14 10a4 4 0 11-3.3 6.2L4 17v-3l1-1h2v-2l2.8-2.8A4 4 0 0114 10z',
  qr: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h2v2h-2z M18 14h2v6h-4 M14 18v2',
  play: 'M8 5l11 7-11 7z',
  alert: 'M12 4l9 16H3z M12 10v4 M12 17v.5',
  grid: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
  chat: 'M20 11.5a7.5 7.5 0 01-8 7.5 8.5 8.5 0 01-4-.9L4 20l1.5-3.5A7.2 7.2 0 014 11.5 7.5 7.5 0 0112 4a7.5 7.5 0 018 7.5z M8 11h.01 M12 11h.01 M16 11h.01',
  sun: 'M12 3v2 M12 19v2 M3 12h2 M19 12h2 M5.6 5.6L7 7 M17 17l1.4 1.4 M18.4 5.6L17 7 M7 17l-1.4 1.4 M16 12a4 4 0 11-8 0 4 4 0 018 0z',
  moon: 'M20.5 14.2A8.5 8.5 0 019.8 3.5 8.5 8.5 0 1020.5 14.2z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  chart: 'M4 20V4 M4 20h16 M8 16v-5 M12 16V8 M16 16v-8',
};
export function icon(name, size = 18) {
  return svg('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'icon' }, svg('path', { d: ICONS[name] ?? '' }));
}

export const shortHash = (hash, n = 10) => (hash ? `${hash.slice(0, n)}…` : '—');
export const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const dateTime = (ts) => new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

let toastHost;
export function toast(message, kind = 'info') {
  if (!toastHost) { toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(toastHost); }
  const t = h('div', { class: `toast ${kind}` }, message);
  toastHost.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 7000 : 3500);
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); } catch { toast('Copy failed. Select the text and copy it manually.', 'error'); }
}

export function remember(key, value) {
  try { if (value === undefined) return sessionStorage.getItem(key); sessionStorage.setItem(key, value); } catch { /* storage blocked */ }
  return null;
}

/** Run an async action behind a button: disables it, shows a busy label, reports errors as toasts. */
export function busy(button, label, fn) {
  return async (...args) => {
    const old = button.textContent;
    button.disabled = true; button.textContent = label;
    try { return await fn(...args); } catch (e) { toast(e.message, 'error'); } finally { button.disabled = false; button.textContent = old; }
  };
}
