import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PushSub } from './store.ts';

/**
 * Web Push from the shop PC (CRM campaigns): the standard every phone browser speaks, so the
 * CheesyBeez app (a TWA of cheesybeez.com, Chrome inside) needs no Firebase and costs nothing.
 * - VAPID (RFC 8292): the shop signs each request with its own key pair, so a push service accepts
 *   messages for the app only from this shop. The pair lives in <data>\crm-vapid.json (made once);
 *   the public half goes to the cloud, which hands it to the app when a customer signs up.
 * - The message is encrypted to that one phone (RFC 8291, aes128gcm): the push service carries it
 *   but cannot read it, and no copy stays anywhere else.
 * Built on WebCrypto (in Node), no library.
 */
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');
type Bytes = Uint8Array<ArrayBuffer>;
const unb64u = (s: string): Bytes => new Uint8Array(Buffer.from(s, 'base64url'));
const concat = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};

export interface Vapid {
  /** The uncompressed P-256 public key, base64url (what the app's applicationServerKey is). */
  publicKey: string;
  privateKey: CryptoKey;
}

export const newVapidJson = async (): Promise<{ publicKey: string; privateJwk: JsonWebKey }> => {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  return { publicKey: b64u(await subtle.exportKey('raw', pair.publicKey)), privateJwk: await subtle.exportKey('jwk', pair.privateKey) };
};

export const vapidFromJson = async (j: { publicKey: string; privateJwk: JsonWebKey }): Promise<Vapid> =>
  ({ publicKey: j.publicKey, privateKey: await subtle.importKey('jwk', j.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) });

/** The shop's VAPID pair from <dir>\crm-vapid.json, made the first time. */
export const shopVapid = async (dir: string): Promise<Vapid> => {
  const file = join(dir, 'crm-vapid.json');
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(await newVapidJson()), { mode: 0o600, flag: 'wx' });
  }
  return vapidFromJson(JSON.parse(readFileSync(file, 'utf8')) as { publicKey: string; privateJwk: JsonWebKey });
};

/** The VAPID header for one push service (its origin), valid 12 hours. */
export const vapidAuth = async (endpoint: string, vapid: Vapid, subject: string, now: number): Promise<string> => {
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const signature = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapid.privateKey, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${vapid.publicKey}`;
};

const hkdf = async (salt: Bytes, ikm: Bytes, info: Bytes, bytes: number): Promise<Bytes> =>
  new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), bytes * 8));

/** The message, encrypted to this phone alone (RFC 8291, one aes128gcm record). */
export const encryptFor = async (sub: PushSub, plaintext: Uint8Array): Promise<Bytes> => {
  const uaPublic = unb64u(sub.keys.p256dh);
  const auth = unb64u(sub.keys.auth);
  const local = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPublic = new Uint8Array(await subtle.exportKey('raw', local.publicKey));
  const shared = new Uint8Array(await subtle.deriveBits(
    { name: 'ECDH', public: await subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []) }, local.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
};

/** What the push service said: delivered, gone for good (forget the phone), or failed (try again later). */
export type PushResult = 'sent' | 'gone' | 'failed';

/** What a notification says: no name, nothing personal (campaigns.ts). */
export interface PushMessage { title: string; body: string }

export const sendPush = async (
  sub: PushSub, message: PushMessage, vapid: Vapid,
  o: { subject?: string; now?: number; fetch?: typeof fetch; ttlSeconds?: number } = {},
): Promise<PushResult> => {
  try {
    const url = new URL(sub.endpoint);
    if (url.protocol !== 'https:') return 'gone';
    const body = await encryptFor(sub, enc.encode(JSON.stringify(message)));
    const r = await (o.fetch ?? fetch)(sub.endpoint, {
      method: 'POST',
      headers: {
        authorization: await vapidAuth(sub.endpoint, vapid, o.subject ?? 'https://cheesybeez.com', o.now ?? Date.now()),
        'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream',
        ttl: String(o.ttlSeconds ?? 2 * 24 * 3600), urgency: 'normal',
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status === 404 || r.status === 410) return 'gone';
    return r.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
};
