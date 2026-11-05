// Encrypted backup of the owner's signing key, so clearing browser data no longer means losing a mandate.
// PBKDF2-SHA256 (600k iterations) derives an AES-256-GCM key from the owner's passphrase. Nothing leaves the browser.
// Works in Node 20+ and every modern browser (Web Crypto).
import { b64u, fromB64u, fingerprint } from './crypto.js';

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
export const BACKUP_FORMAT = 'ledgertrue-owner-key/1';
export const DEFAULT_ITERATIONS = 600_000;

const derive = async (passphrase, salt, iterations) => {
  const base = await subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
};

export async function encryptBackup(privateJwk, passphrase, { iterations = DEFAULT_ITERATIONS } = {}) {
  if (typeof passphrase !== 'string' || passphrase.length < 10) throw new Error('Use a passphrase of at least 10 characters.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(passphrase, salt, iterations);
  const publicKeyJwk = { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, y: privateJwk.y };
  const aad = enc.encode(JSON.stringify(publicKeyJwk)); // binds the ciphertext to the public key it claims to belong to
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, enc.encode(JSON.stringify(privateJwk)));
  return { format: BACKUP_FORMAT, kdf: 'PBKDF2-SHA256', iterations, salt: b64u(salt), iv: b64u(iv), ciphertext: b64u(ct), publicKeyJwk, fingerprint: await fingerprint(publicKeyJwk), createdAt: Date.now() };
}

export async function decryptBackup(file, passphrase) {
  if (file?.format !== BACKUP_FORMAT) throw new Error('This is not a LedgerTrue owner-key backup.');
  if (!Number.isInteger(file.iterations) || file.iterations < 100_000 || file.iterations > 5_000_000) throw new Error('Backup file has unreasonable key-derivation settings.');
  const key = await derive(String(passphrase ?? ''), fromB64u(file.salt), file.iterations);
  let plain;
  try {
    plain = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(file.iv), additionalData: enc.encode(JSON.stringify(file.publicKeyJwk)) }, key, fromB64u(file.ciphertext));
  } catch { throw new Error('Wrong passphrase, or the backup file was modified.'); }
  const jwk = JSON.parse(new TextDecoder().decode(plain));
  if (jwk.x !== file.publicKeyJwk.x || jwk.y !== file.publicKeyJwk.y) throw new Error('Backup contents do not match its public key.');
  return jwk;
}
