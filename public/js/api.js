import { remember } from './dom.js';

let token = remember('lt-token') || '';
export const setToken = (t) => { token = t.trim(); remember('lt-token', token); };
export const hasToken = () => Boolean(token);

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(res.status === 401 ? 'This action needs the operator token. Use "Operator access" in the sidebar.' : data.error || `Request failed (${res.status})`);
    e.status = res.status;
    throw e;
  }
  return data;
}

let cfgPromise = null;
/** One shared /api/config request for the whole page (app.js and the sign-in gate both use it). */
export const getConfig = () => (cfgPromise ??= api('GET', '/api/config').catch((e) => { cfgPromise = null; throw e; }));

/** Decimal text -> minor units without floats ("19.99" -> 1999). */
export function toMinor(text) {
  const m = String(text).trim().replace(/,/g, '').match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new Error(`"${text}" is not a valid amount`);
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0);
}
