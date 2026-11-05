// Thin wrapper over Web Crypto, which behaves the same in Node 20+ and every modern browser.
// Signatures: ECDSA P-256 / SHA-256, IEEE-P1363 (r||s) encoding, base64url.
import { canonical } from './canonical.js';

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const ALGO = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };

export const GENESIS = '0'.repeat(64);

export const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const b64u = (buf) => {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const fromB64u = (str) => {
  const s = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};

export async function sha256Hex(text) {
  return toHex(await subtle.digest('SHA-256', enc.encode(text)));
}

/** Non-extractable by default: the private key can sign but can never be read back out of the browser. */
export function generateKeyPair({ extractable = false } = {}) {
  return subtle.generateKey(ALGO, extractable, ['sign', 'verify']);
}

export async function exportPublicJwk(publicKey) {
  const { kty, crv, x, y } = await subtle.exportKey('jwk', publicKey);
  return { kty, crv, x, y };
}

export async function exportPrivateJwk(privateKey) {
  return subtle.exportKey('jwk', privateKey);
}

export function importPrivateJwk(jwk) {
  return subtle.importKey('jwk', jwk, ALGO, true, ['sign']);
}

export function importPublicJwk(jwk) {
  const { kty, crv, x, y } = jwk;
  return subtle.importKey('jwk', { kty, crv, x, y }, ALGO, true, ['verify']);
}

export async function fingerprint(jwk) {
  const { kty, crv, x, y } = jwk;
  return (await sha256Hex(canonical({ kty, crv, x, y }))).slice(0, 16);
}

export async function signText(privateKey, text) {
  return b64u(await subtle.sign(SIGN, privateKey, enc.encode(text)));
}

export async function verifyText(publicJwk, text, signature) {
  try {
    const key = await importPublicJwk(publicJwk);
    return await subtle.verify(SIGN, key, fromB64u(signature), enc.encode(text));
  } catch {
    return false;
  }
}

/** What the owner actually signs. Binding every field stops a signature being replayed for something else. */
export const messages = {
  mandate: (mandate) => canonical({ kind: 'mandate', mandate }),
  approval: ({ mandateId, requestId, decision, decisionHash }) =>
    canonical({ kind: 'approval', mandateId, requestId, decision, decisionHash }),
  revoke: ({ mandateId, headHash }) => canonical({ kind: 'revoke', mandateId, headHash }),
};
