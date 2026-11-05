// Thin client for the optional Python ML service. Every failure becomes a clean "unavailable", never an exception
// that could break a payment. A small circuit breaker stops a dead service from slowing every request.
export function makeMlClient({ url = '', token = '', timeoutMs = 4000, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const base = String(url || '').replace(/\/+$/, '');
  let fails = 0;
  let openUntil = 0;
  const enabled = Boolean(base);

  async function call(method, path, body, { timeout = timeoutMs } = {}) {
    if (!enabled) return { ok: false, reason: 'not_configured' };
    if (now() < openUntil) return { ok: false, reason: 'circuit_open' };
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status >= 500) throw new Error(`status ${res.status}`);
        return { ok: false, reason: `rejected_${res.status}`, detail: data };
      }
      fails = 0;
      return { ok: true, data };
    } catch (e) {
      fails += 1;
      if (fails >= 3) openUntil = now() + 30_000;
      return { ok: false, reason: e?.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
    }
  }

  return {
    enabled,
    get open() { return now() < openUntil; },
    models: () => call('GET', '/v1/models', undefined, { timeout: 2000 }),
    health: () => call('GET', '/healthz', undefined, { timeout: 1500 }),
    monitor: () => call('GET', '/v1/monitor', undefined, { timeout: 2000 }),
    analyzeMandate: (body) => call('POST', '/v1/analyze/mandate', body),
    analyzePayments: (body) => call('POST', '/v1/analyze/payments', body),
    scoreRequest: (body, timeout = 1500) => call('POST', '/v1/score/request', body, { timeout }),
    synthetic: (seed) => call('POST', '/v1/synthetic/mandate', { seed }),
  };
}
