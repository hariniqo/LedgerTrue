import crypto from 'node:crypto';

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Roles
 *  operator : settle / release holds, run reconciliation tools, reset the demo
 *  agent    : submit payment requests
 *  owner    : proven by signature on the chain, not by a token
 *  public   : read-only receipts and verification
 * Only an explicit DEMO_MODE=true enables open demo access.
 * Otherwise both tokens are mandatory: the server refuses to start without them.
 */
export function makeAuth(env = process.env) {
  const demo = String(env.DEMO_MODE ?? 'false') === 'true';
  const tokens = { operator: env.OPERATOR_TOKEN || '', agent: env.AGENT_TOKEN || '' };
  if (demo && !tokens.operator && !tokens.agent && String(env.NODE_ENV ?? '') === 'production') {
    throw new Error('Open demo mode (DEMO_MODE=true without tokens) is refused when NODE_ENV=production. Set OPERATOR_TOKEN and AGENT_TOKEN.');
  }
  if (env.TOKEN_SECRET && String(env.TOKEN_SECRET).length < 16) {
    throw new Error('TOKEN_SECRET must be at least 16 characters');
  }
  if (!demo && (!tokens.operator || !tokens.agent)) {
    throw new Error('Set OPERATOR_TOKEN and AGENT_TOKEN, or explicitly set DEMO_MODE=true for a local demo');
  }
  const bearer = (req) => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  return {
    demo,
    open: demo && !tokens.operator && !tokens.agent,
    can(req, role) {
      if (demo && !tokens.operator && !tokens.agent) return true;
      const t = bearer(req);
      if (!t) return false;
      if (tokens.operator && safeEqual(t, tokens.operator)) return true; // operator may do everything an agent can
      const p = env.TOKEN_SECRET ? verifyToken(env.TOKEN_SECRET, t) : null; // short-lived signed token
      if (p) return p.role === 'operator' || (role === 'agent' && p.role === 'agent');
      return role === 'agent' && tokens.agent && safeEqual(t, tokens.agent);
    },
  };
}

/** Fixed-window limiter per IP and bucket. In-memory: fine for one node, use Redis behind a load balancer. */
export function makeLimiter({ windowMs = 10_000, max = 60 } = {}) {
  const hits = new Map();
  const timer = setInterval(() => { const cut = Date.now() - windowMs; for (const [k, v] of hits) if (v.start < cut) hits.delete(k); }, windowMs);
  timer.unref?.();
  return {
    check(key) {
      const now = Date.now();
      const h = hits.get(key);
      if (!h || now - h.start > windowMs) { hits.set(key, { start: now, n: 1 }); return true; }
      h.n += 1;
      return h.n <= max;
    },
    stop() { clearInterval(timer); },
  };
}

export function securityHeaders(extra = {}) {
  const csp = [
    "default-src 'self'",
    "script-src 'self' https://www.paypal.com https://www.sandbox.paypal.com https://*.paypal.com",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https://*.paypal.com",
    "connect-src 'self' https://*.paypal.com",
    'frame-src https://*.paypal.com',
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    ...extra,
  };
}

/** Short-lived signed token: base64url(JSON{role,exp}).HMAC-SHA256. Mint one per judge, it expires by itself. */
export function signToken(secret, role, ttlSec = 3600, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ role, exp: Math.floor(now / 1000) + ttlSec })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(secret, token, now = Date.now()) {
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  const good = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig); const b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.role && p.exp * 1000 > now ? p : null;
  } catch { return null; }
}
