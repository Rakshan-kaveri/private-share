// Browser-side cryptography for Private Share. Uses only WebCrypto.
//
//  - Each browser holds a long-term ECDSA P-256 identity key (IndexedDB, private key non-extractable).
//  - Each call uses fresh ECDH P-256 keys; the shared secret goes through HKDF-SHA-256.
//  - Every key bundle and every SDP (which carries the DTLS fingerprint) is signed with the
//    identity key, so the signalling server cannot swap keys or insert itself into the media path.
//  - Peer identity keys are pinned on first use (TOFU); the safety code lets people confirm them.
//  - File chunks: AES-256-GCM, one key per file, nonce = 8-byte random prefix || 4-byte index,
//    AAD binds call, file, chunk index and chunk count. The sender signs a manifest over a
//    SHA-256 hash list of the plaintext chunks.

const enc = new TextEncoder();
const subtle = () => {
  if (!globalThis.crypto?.subtle) throw new Error('This page must be opened over HTTPS (or localhost) for encryption to work.');
  return crypto.subtle;
};

export function b64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export const unb64 = str => Uint8Array.from(atob(str), c => c.charCodeAt(0));
export const randomHex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(x => x.toString(16).padStart(2, '0')).join('');
export const sha256 = async data => new Uint8Array(await subtle().digest('SHA-256', data));

// ------------------------------------------------------------ identity store
const DB_NAME = 'private-share-identity-v1';
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys');
      if (!db.objectStoreNames.contains('peers')) db.createObjectStore('peers');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbGet(store, key) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const r = db.transaction(store, 'readonly').objectStore(store).get(key);
      r.onsuccess = () => resolve(r.result ?? null); r.onerror = () => reject(r.error);
    });
  } finally { db.close(); }
}
async function dbPut(store, key, value) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export function normJwk(jwk) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') throw new Error('Invalid public key');
  return { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
}

let identityPromise = null;
export function identity() {
  if (!identityPromise) identityPromise = (async () => {
    const existing = await dbGet('keys', 'identity');
    if (existing?.privateKey && existing?.publicKey) return { privateKey: existing.privateKey, publicKey: normJwk(existing.publicKey) };
    const pair = await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const publicKey = normJwk(await subtle().exportKey('jwk', pair.publicKey));
    // Re-import the private key as non-extractable before storing it.
    const pkcs8 = await subtle().exportKey('pkcs8', pair.privateKey);
    const privateKey = await subtle().importKey('pkcs8', pkcs8, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    await dbPut('keys', 'identity', { privateKey, publicKey });
    return { privateKey, publicKey };
  })().catch(e => { identityPromise = null; throw e; });
  return identityPromise;
}

const verifyKeys = new Map();
async function verifyKey(jwk) {
  const k = JSON.stringify(normJwk(jwk));
  if (!verifyKeys.has(k)) verifyKeys.set(k, subtle().importKey('jwk', normJwk(jwk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']));
  return verifyKeys.get(k);
}
async function signParts(parts) {
  const id = await identity();
  return b64(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, id.privateKey, enc.encode(JSON.stringify(parts))));
}
async function verifyParts(jwk, parts, sig) {
  if (typeof sig !== 'string') return false;
  try {
    return await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, await verifyKey(jwk), unb64(sig), enc.encode(JSON.stringify(parts)));
  } catch { return false; }
}

export async function keyFingerprint(jwk) {
  const d = await sha256(enc.encode(JSON.stringify(normJwk(jwk))));
  return [...d.slice(0, 16)].map(x => x.toString(16).padStart(2, '0')).join('').match(/.{4}/g).join(' ').toUpperCase();
}

// ------------------------------------------------------------ trust on first use
// Returns {status: 'new' | 'known' | 'changed', verified}
export async function checkPeerKey(accountId, jwk) {
  const key = normJwk(jwk);
  const rec = await dbGet('peers', String(accountId));
  if (!rec) {
    await dbPut('peers', String(accountId), { publicKey: key, fingerprint: await keyFingerprint(key), firstSeen: Date.now(), verified: false });
    return { status: 'new', verified: false };
  }
  if (JSON.stringify(normJwk(rec.publicKey)) === JSON.stringify(key)) return { status: 'known', verified: !!rec.verified };
  return { status: 'changed', verified: false };
}
export async function trustPeerKey(accountId, jwk) {
  const key = normJwk(jwk);
  await dbPut('peers', String(accountId), { publicKey: key, fingerprint: await keyFingerprint(key), firstSeen: Date.now(), verified: false });
}
export async function markVerified(accountId, jwk) {
  const rec = await dbGet('peers', String(accountId));
  if (!rec || JSON.stringify(normJwk(rec.publicKey)) !== JSON.stringify(normJwk(jwk))) return false;
  await dbPut('peers', String(accountId), { ...rec, verified: true });
  return true;
}

// Same 12 digits on both screens when both browsers hold each other's real keys.
export async function safetyCode(jwkA, jwkB) {
  const [x, y] = [JSON.stringify(normJwk(jwkA)), JSON.stringify(normJwk(jwkB))].sort();
  const d = await sha256(enc.encode(`ps-safety-v1|${x}|${y}`));
  const v = new DataView(d.buffer);
  return [0, 4, 8].map(o => String(v.getUint32(o) % 10000).padStart(4, '0')).join(' ');
}

// ------------------------------------------------------------ call key bundles
const FILE_ID = /^[a-f0-9]{32}$/;
export function cleanFileList(list) {
  if (!Array.isArray(list) || list.length > 50) throw new Error('Invalid file list');
  return list.map(f => {
    if (!f || !FILE_ID.test(f.id) || typeof f.name !== 'string' || f.name.length > 255 || !Number.isSafeInteger(f.size) || f.size < 0) throw new Error('Invalid file list');
    return { id: f.id, name: f.name, size: f.size };
  });
}

export async function makeBundle({ sid, from, to, role, intent, files = [] }) {
  const ecdh = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const ecdhPub = normJwk(await subtle().exportKey('jwk', ecdh.publicKey));
  const id = await identity();
  const fileList = cleanFileList(files);
  const parts = ['bundle-v2', sid, from, to, role, intent, ecdhPub, id.publicKey, fileList];
  const bundle = { v: 2, sid, from, to, role, intent, ecdh: ecdhPub, identity: id.publicKey, files: fileList, sig: await signParts(parts) };
  return { bundle, ecdhPrivate: ecdh.privateKey };
}

export async function openBundle(b, expect) {
  if (!b || b.v !== 2) throw new Error('This contact is using an incompatible version of the app.');
  for (const k of ['sid', 'from', 'to', 'role']) if (b[k] !== expect[k]) throw new Error('Key exchange does not match this call.');
  const ecdh = normJwk(b.ecdh), ident = normJwk(b.identity), files = cleanFileList(b.files || []);
  const parts = ['bundle-v2', b.sid, b.from, b.to, b.role, b.intent, ecdh, ident, files];
  if (!(await verifyParts(ident, parts, b.sig))) throw new Error('Key exchange signature is invalid. Call blocked.');
  return { ...b, ecdh, identity: ident, files };
}

export async function sessionMaterial(ecdhPrivate, peerEcdhJwk) {
  const pub = await subtle().importKey('jwk', normJwk(peerEcdhJwk), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await subtle().deriveBits({ name: 'ECDH', public: pub }, ecdhPrivate, 256);
  return subtle().importKey('raw', bits, 'HKDF', false, ['deriveKey']);
}
export function fileKey(material, { sid, fileId, senderId }) {
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(fileId), info: enc.encode(`ps-file-v2|${sid}|${senderId}`) },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// ------------------------------------------------------------ signed SDP
export const signSdp = ({ sid, from, to, type, sdp, mids }) => signParts(['sdp-v2', sid, from, to, type, sdp, mids || null]);
export const verifySdp = (jwk, { sid, from, to, type, sdp, mids }, sig) => verifyParts(jwk, ['sdp-v2', sid, from, to, type, sdp, mids || null], sig);

// ------------------------------------------------------------ file chunks
export function nonce(prefix, index) {
  const n = new Uint8Array(12); n.set(prefix, 0); new DataView(n.buffer).setUint32(8, index); return n;
}
export const chunkAad = (sid, fileId, index, total) => enc.encode(`${sid}|${fileId}|${index}|${total}`);
export const encryptChunk = (key, iv, aad, data) => subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, data);
export const decryptChunk = (key, iv, aad, data) => subtle().decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, data);

const manifestParts = m => ['manifest-v2', m.sid, m.id, m.from, m.to, m.name, m.size, m.mime, m.total, m.chunkSize, m.digest];
export const signManifest = m => signParts(manifestParts(m));
export const verifyManifest = (jwk, m, sig) => verifyParts(jwk, manifestParts(m), sig);
