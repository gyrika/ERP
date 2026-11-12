import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptFor, newVapidJson, sendPush, shopVapid, vapidAuth, vapidFromJson } from './webpush.ts';

const subtle = globalThis.crypto.subtle;
const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');
const enc = new TextEncoder();

/** A phone's side: its keys, and how it opens a message (RFC 8291), written apart from the sender on purpose. */
const phone = async () => {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const uaPublic = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const auth = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: { p256dh: b64u(uaPublic), auth: b64u(auth) } };
  const hkdf = async (salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: string | Uint8Array<ArrayBuffer>, bytes: number) =>
    new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: typeof info === 'string' ? enc.encode(info) : info },
      await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), bytes * 8));
  const open = async (body: Uint8Array): Promise<string> => {
    const salt = body.slice(0, 16);
    const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
    assert.equal(rs, 4096);
    const idlen = body[20];
    const asPublic = body.slice(21, 21 + idlen);
    const cipher = body.slice(21 + idlen);
    const shared = new Uint8Array(await subtle.deriveBits(
      { name: 'ECDH', public: await subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []) }, pair.privateKey, 256));
    const info = new Uint8Array([...enc.encode('WebPush: info\0'), ...uaPublic, ...asPublic]);
    const ikm = await hkdf(auth, shared, info, 32);
    const key = await subtle.importKey('raw', await hkdf(salt, ikm, 'Content-Encoding: aes128gcm\0', 16), 'AES-GCM', false, ['decrypt']);
    const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: await hkdf(salt, ikm, 'Content-Encoding: nonce\0', 12) }, key, cipher));
    assert.equal(plain[plain.length - 1], 2, 'the last record ends with its delimiter');
    return new TextDecoder().decode(plain.slice(0, -1));
  };
  return { sub, open };
};

test('a message is encrypted to one phone: that phone opens it, the bytes say nothing', async () => {
  const p = await phone();
  const message = JSON.stringify({ title: 'Weekend offer', body: 'නිමල් 2 pizzas, 1 price · இன்று மட்டும்' });
  const body = await encryptFor(p.sub, enc.encode(message));
  assert.ok(!Buffer.from(body).toString('latin1').includes('Weekend'), 'nothing readable on the wire');
  assert.equal(await p.open(body), message);
  const other = await phone();
  await assert.rejects(other.open(body), 'another phone cannot open it');
});

test('VAPID: signed for the push service\'s origin, for 12 hours, checkable with the public key', async () => {
  const vapid = await vapidFromJson(await newVapidJson());
  const now = Date.UTC(2026, 10, 11, 6, 0);
  const header = await vapidAuth('https://fcm.googleapis.com/fcm/send/abc', vapid, 'https://cheesybeez.com', now);
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
  assert.ok(m);
  const [, h, c, sig, k] = m;
  assert.equal(k, vapid.publicKey);
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url').toString()), { aud: 'https://fcm.googleapis.com', exp: now / 1000 + 43200, sub: 'https://cheesybeez.com' });
  const pub = await subtle.importKey('raw', Buffer.from(k, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, Buffer.from(sig, 'base64url'), enc.encode(`${h}.${c}`)));
});

test('sending: what the push service answers decides what happens to the phone', async () => {
  const p = await phone();
  const vapid = await vapidFromJson(await newVapidJson());
  const seen: { url: string; headers: Headers; body: Uint8Array }[] = [];
  const answer = (status: number) => (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), headers: new Headers(init?.headers), body: init?.body as Uint8Array });
    return new Response(null, { status });
  }) as typeof fetch;
  const msg = { title: 'Weekend offer', body: 'Two pizzas, one price.' };
  assert.equal(await sendPush(p.sub, msg, vapid, { fetch: answer(201) }), 'sent');
  assert.equal(seen[0].url, p.sub.endpoint);
  assert.equal(seen[0].headers.get('content-encoding'), 'aes128gcm');
  assert.match(seen[0].headers.get('authorization')!, /^vapid t=/);
  assert.equal(JSON.parse(await p.open(seen[0].body)).title, 'Weekend offer');
  assert.equal(await sendPush(p.sub, msg, vapid, { fetch: answer(410) }), 'gone', 'unsubscribed');
  assert.equal(await sendPush(p.sub, msg, vapid, { fetch: answer(404) }), 'gone');
  assert.equal(await sendPush(p.sub, msg, vapid, { fetch: answer(429) }), 'failed', 'try later');
  assert.equal(await sendPush(p.sub, msg, vapid, { fetch: (async () => { throw new Error('offline'); }) as typeof fetch }), 'failed');
  assert.equal(await sendPush({ ...p.sub, endpoint: 'http://insecure.example/x' }, msg, vapid, { fetch: answer(201) }), 'gone');
});

test('the shop\'s key pair is made once and kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-vapid-'));
  const a = await shopVapid(dir);
  const b = await shopVapid(dir);
  assert.equal(a.publicKey, b.publicKey);
  assert.equal(Buffer.from(a.publicKey, 'base64url').length, 65);
  rmSync(dir, { recursive: true, force: true });
});
