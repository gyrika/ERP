/**
 * Sealing customers' personal data in the cloud (accounts.ts). One secret, PROFILE_KEY (32 random
 * bytes, base64: npx wrangler secret put PROFILE_KEY), gives two keys through HKDF:
 * - AES-256-GCM for the data itself, bound to the row it belongs to (the AAD), so a sealed value
 *   copied into another account's row does not open;
 * - HMAC-SHA-256 for lookups (a Google account, a phone number) without keeping the value.
 * Without the secret, nothing is readable: not by whoever holds a copy of the database.
 */
export interface SealKeys { aes: CryptoKey; mac: CryptoKey }

const enc = new TextEncoder();
const dec = new TextDecoder();

const fromB64 = (s: string): Uint8Array<ArrayBuffer> => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const toB64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The two keys from the secret; null when it is missing or not 32 bytes (accounts stay off). */
export async function sealKeys(secret: string | undefined): Promise<SealKeys | null> {
  if (!secret) return null;
  let raw: Uint8Array<ArrayBuffer>;
  try { raw = fromB64(secret.trim()); } catch { return null; }
  if (raw.length !== 32) return null;
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  const derive = (info: string, alg: AesKeyGenParams | HmacImportParams, usages: KeyUsage[]) => crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(`cheesybeez-accounts:${info}`) }, base, alg, false, usages);
  return {
    aes: await derive('seal', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
    mac: await derive('lookup', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']),
  };
}

/** `value` as JSON, sealed for the row named by `aad` ("v1." + iv + ciphertext). */
export async function seal(keys: SealKeys, value: unknown, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const out = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, keys.aes, enc.encode(JSON.stringify(value))));
  const all = new Uint8Array(iv.length + out.length);
  all.set(iv);
  all.set(out, iv.length);
  return `v1.${toB64(all)}`;
}

/** Opens what seal() made for the same row; throws when the key, the row or the bytes differ. */
export async function unseal<T>(keys: SealKeys, sealed: string, aad: string): Promise<T> {
  if (!sealed.startsWith('v1.')) throw new Error('not sealed');
  const all = fromB64(sealed.slice(3));
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: all.slice(0, 12), additionalData: enc.encode(aad) }, keys.aes, all.slice(12));
  return JSON.parse(dec.decode(plain)) as T;
}

/** A keyed hash for looking something up (hex); `purpose` keeps a phone's hash apart from a Google id's. */
export async function lookupHash(keys: SealKeys, purpose: string, value: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', keys.mac, enc.encode(`${purpose}:${value}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
