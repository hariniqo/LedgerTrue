// The owner's signing key. By default it is generated in this browser as NON-EXTRACTABLE: it can sign, but nothing,
// including this page's own code, can read the private key back out. It lives in IndexedDB so it survives reloads.
// Trade-off: clearing site data then loses control of every mandate that key owns. So the owner can instead choose a
// RECOVERABLE key: extractable only so it can be exported as a passphrase-encrypted backup file and restored elsewhere.
import { generateKeyPair, exportPublicJwk, exportPrivateJwk, importPrivateJwk, importPublicJwk, fingerprint, signText } from '/shared/crypto.js';
import { encryptBackup, decryptBackup } from '/shared/keyBackup.js';

let cached;

const idb = () => new Promise((resolve, reject) => {
  const open = indexedDB.open('ledgertrue', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('keys');
  open.onsuccess = () => resolve(open.result);
  open.onerror = () => reject(open.error);
});
const read = (db) => new Promise((res, rej) => { const r = db.transaction('keys').objectStore('keys').get('owner'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const write = (db, v) => new Promise((res, rej) => { const r = db.transaction('keys', 'readwrite').objectStore('keys').put(v, 'owner'); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });

async function persist(stored) {
  try { await write(await idb(), stored); return true; } catch { return false; }
}

async function wrap(stored) {
  const publicKeyJwk = await exportPublicJwk(stored.publicKey);
  return {
    publicKeyJwk,
    fingerprint: await fingerprint(publicKeyJwk),
    sessionOnly: Boolean(stored.session),
    recoverable: Boolean(stored.recoverable),
    sign: (text) => signText(stored.privateKey, text),
    /** Passphrase-encrypted backup file contents. Only possible for a recoverable key. */
    async exportBackup(passphrase) {
      if (!stored.recoverable) throw new Error('This key was created non-extractable, so it cannot be backed up. Create a recoverable key instead.');
      return encryptBackup(await exportPrivateJwk(stored.privateKey), passphrase);
    },
  };
}

export async function ownerKey() {
  if (cached) return cached;
  let stored = null; let db = null;
  try { db = await idb(); stored = await read(db); } catch { /* private window: fall back to a session key */ }
  if (!stored) {
    const pair = await generateKeyPair({ extractable: false });
    stored = { privateKey: pair.privateKey, publicKey: pair.publicKey, recoverable: false };
    if (db) { try { await write(db, stored); } catch { stored.session = true; } } else stored.session = true;
  }
  cached = await wrap(stored);
  return cached;
}

/** A NEW recoverable key. Mandates signed by the previous key stay controlled by the previous key. */
export async function createRecoverableKey() {
  const pair = await generateKeyPair({ extractable: true });
  const stored = { privateKey: pair.privateKey, publicKey: pair.publicKey, recoverable: true };
  if (!(await persist(stored))) stored.session = true;
  cached = await wrap(stored);
  return cached;
}

/** Replace this browser's key with one restored from a backup file. */
export async function restoreKey(file, passphrase) {
  const jwk = await decryptBackup(file, passphrase);
  const privateKey = await importPrivateJwk(jwk);
  const publicKey = await importPublicJwk(jwk);
  const stored = { privateKey, publicKey, recoverable: true };
  if (!(await persist(stored))) stored.session = true;
  cached = await wrap(stored);
  return cached;
}
