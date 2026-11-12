import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCloud, sha256Hex } from './cloud.ts';
import { fakeD1 } from './fakeD1.ts';

// Offers on the customer's phone: the cloud only passes sign-ups to the shop PC, then forgets them.

const SHOP = 'cheesybeez-thalwila-a1b2';
const KEY = 'B'.repeat(87);
const sub = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/phone-${n}`, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) }, expirationTime: null });

async function setup() {
  const { d1, db } = fakeD1();
  db.prepare("INSERT INTO shops (id, name, created_at) VALUES (?, 'CheesyBeez Thalwila', 0)").run(SHOP);
  db.prepare("INSERT INTO shops (id, name, created_at) VALUES ('other-shop', 'Other', 0)").run();
  for (const [tenant, token, kind] of [[SHOP, 'server-a', 'shop_server'], ['other-shop', 'server-b', 'shop_server'], [SHOP, 'owner-a', 'owner']]) {
    db.prepare('INSERT INTO devices (id, tenant_id, kind, token_hash, created_at) VALUES (?, ?, ?, ?, 0)').run(`dev-${token}`, tenant, kind, await sha256Hex(token));
  }
  const clock = { t: Date.UTC(2026, 10, 11, 6, 0) };
  const handle = createCloud(d1, { now: () => clock.t, orderShop: SHOP });
  const call = async (path: string, body?: unknown, token?: string, ip = '1.2.3.4') => {
    const r = await handle(new Request(`https://cloud.test${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'cf-connecting-ip': ip, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
    return { status: r.status, body: await r.json() as Record<string, any> };
  };
  return { call, clock, db };
}

test('the app gets the shop\'s push key once the shop PC has handed it over', async () => {
  const { call } = await setup();
  assert.deepEqual((await call('/api/v1/push/key')).body, { key: null });
  assert.equal((await call('/api/v1/push/key', { key: KEY })).status, 401, 'only the shop PC');
  assert.equal((await call('/api/v1/push/key', { key: KEY }, 'owner-a')).status, 403, 'not the owner\'s phone');
  assert.equal((await call('/api/v1/push/key', { key: 'short' }, 'server-a')).status, 400);
  assert.equal((await call('/api/v1/push/key', { key: KEY }, 'server-a')).status, 200);
  assert.deepEqual((await call('/api/v1/push/key')).body, { key: KEY });
});

test('a sign-up waits for the shop PC, which takes it and has it deleted; another shop never sees it', async () => {
  const { call, db } = await setup();
  assert.equal((await call('/api/v1/push/subscribe', { phone: '011 234 5678', subscription: sub(1) })).status, 400, 'a landline');
  assert.equal((await call('/api/v1/push/subscribe', { phone: '0770000001', subscription: { endpoint: 'http://x' } })).status, 400);
  assert.equal((await call('/api/v1/push/subscribe', { phone: '077 000 0001', subscription: sub(1) })).status, 200);
  assert.equal((await call('/api/v1/push/unsubscribe', { endpoint: sub(2).endpoint })).status, 200);

  const inbox = await call('/api/v1/push/inbox', undefined, 'server-a');
  assert.deepEqual(inbox.body.rows.map((r: { kind: string; phone?: string; endpoint?: string }) => [r.kind, r.phone ?? r.endpoint]),
    [['subscribe', '+94770000001'], ['unsubscribe', sub(2).endpoint]]);
  assert.deepEqual(inbox.body.rows[0].subscription, { endpoint: sub(1).endpoint, keys: sub(1).keys }, 'only what is needed is kept');
  assert.deepEqual((await call('/api/v1/push/inbox', undefined, 'server-b')).body.rows, [], 'another shop');
  assert.equal((await call('/api/v1/push/inbox')).status, 401);

  await call('/api/v1/push/inbox/ack', { ids: [inbox.body.rows[0].id] }, 'server-b'); // not theirs: nothing happens
  assert.equal((await call('/api/v1/push/inbox', undefined, 'server-a')).body.rows.length, 2);
  await call('/api/v1/push/inbox/ack', { ids: inbox.body.rows.map((r: { id: string }) => r.id) }, 'server-a');
  assert.deepEqual((await call('/api/v1/push/inbox', undefined, 'server-a')).body.rows, []);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM push_inbox').get() as { n: number }).n, 0, 'nothing kept once taken');
});

test('nothing waits longer than 30 days, and one address cannot flood the letterbox', async () => {
  const { call, clock } = await setup();
  await call('/api/v1/push/subscribe', { phone: '0770000001', subscription: sub(1) });
  clock.t += 31 * 86_400_000;
  assert.deepEqual((await call('/api/v1/push/inbox', undefined, 'server-a')).body.rows, []);
  for (let i = 0; i < 10; i++) assert.equal((await call('/api/v1/push/subscribe', { phone: '0770000001', subscription: sub(i) }, undefined, '9.9.9.9')).status, 200);
  assert.equal((await call('/api/v1/push/subscribe', { phone: '0770000001', subscription: sub(11) }, undefined, '9.9.9.9')).status, 429);
  assert.equal((await call('/api/v1/push/subscribe', { phone: '0770000001', subscription: sub(12) }, undefined, '8.8.8.8')).status, 200, 'someone else');
});

test('the Android app is vouched for only once its package and key fingerprint are set', async () => {
  const { assetLinks } = await import('./worker.ts');
  assert.deepEqual(assetLinks(undefined, undefined), []);
  assert.deepEqual(assetLinks('com.cheesybeez.app', 'not a fingerprint'), []);
  const print = Array.from({ length: 32 }, (_, i) => (i * 7 % 256).toString(16).padStart(2, '0')).join(':');
  assert.deepEqual(assetLinks('com.cheesybeez.app', ` ${print} `), [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: 'com.cheesybeez.app', sha256_cert_fingerprints: [print.toUpperCase()] },
  }]);
});
