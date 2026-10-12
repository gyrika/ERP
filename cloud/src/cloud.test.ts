import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SyncEvent, SyncedEvent } from '../../src/domain/sync.ts';
import { createCloud, sha256Hex } from './cloud.ts';
import { fakeD1 } from './fakeD1.ts';

const SHOP = 'shop-a';

async function setup() {
  const { d1, db } = fakeD1();
  const add = async (tenant: string, kind: string, token: string) => {
    db.prepare('INSERT OR IGNORE INTO shops (id, name, created_at) VALUES (?, ?, 0)').run(tenant, tenant);
    db.prepare('INSERT INTO devices (id, tenant_id, kind, token_hash, created_at) VALUES (?, ?, ?, ?, 0)')
      .run(`dev-${token}`, tenant, kind, await sha256Hex(token));
  };
  await add(SHOP, 'shop_server', 'server-a');
  await add(SHOP, 'owner', 'owner-a');
  await add('shop-b', 'shop_server', 'server-b');
  const handle = createCloud(d1, () => 9000);
  const call = (path: string, token: string | null, body?: unknown) => handle(new Request(`https://cloud.test${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const del = (path: string, token: string) =>
    handle(new Request(`https://cloud.test${path}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }));
  return { call, del, db };
}

const synced = (id: string, seq: number, shopId = SHOP): SyncedEvent => ({
  seq, deviceId: 'dev-counter', receivedAt: 1000 + seq,
  event: { id, shopId, at: 500, orderNumber: 1001, ticketId: 't1', type: 'kitchen.seen' } as SyncEvent,
});

test('health needs no token', async () => {
  const { call } = await setup();
  assert.deepEqual(await (await call('/api/v1/health', null)).json(), { ok: true, serverTime: 9000 });
});

test('the shop server copies its events in; a repeat stores nothing twice', async () => {
  const { call } = await setup();
  assert.deepEqual(await (await call('/api/v1/replica', 'server-a')).json(), { lastSourceSeq: 0, serverTime: 9000 });

  const first = await (await call('/api/v1/replica', 'server-a', { events: [synced('a', 3), synced('b', 7)] })).json();
  assert.deepEqual(first, { stored: 2, lastSourceSeq: 7, serverTime: 9000 });
  const again = await (await call('/api/v1/replica', 'server-a', { events: [synced('b', 7), synced('c', 8)] })).json();
  assert.equal(again.stored, 1);
  assert.equal(again.lastSourceSeq, 8);

  const pulled = await (await call('/api/v1/events?after=0', 'owner-a')).json();
  assert.deepEqual(pulled.events.map((e: SyncedEvent) => e.event.id), ['a', 'b', 'c']);
  assert.deepEqual(pulled.events[0].event, synced('a', 3).event, 'the body comes back exactly as sent');
  assert.equal(pulled.events[0].receivedAt, 1003);
  assert.equal(pulled.more, false);
});

test('tokens, devices and shops are kept apart', async () => {
  const { call } = await setup();
  assert.equal((await call('/api/v1/replica', 'nope')).status, 401);
  assert.equal((await call('/api/v1/replica', 'owner-a', { events: [] })).status, 403, 'the owner reads, never writes');
  const wrong = await call('/api/v1/replica', 'server-a', { events: [synced('x', 1, 'shop-b')] });
  assert.equal(wrong.status, 403);
  await call('/api/v1/replica', 'server-b', { events: [synced('y', 1, 'shop-b')] });
  const a = await (await call('/api/v1/events', 'owner-a')).json();
  assert.deepEqual(a.events, [], "never another shop's events");
});

test('bad rows are refused whole, and nothing is stored', async () => {
  const { call } = await setup();
  const bad = [synced('ok', 1), { ...synced('no-seq', 2), seq: 0 }];
  assert.equal((await call('/api/v1/replica', 'server-a', { events: bad })).status, 400);
  const badEvent = [{ ...synced('z', 1), event: { ...synced('z', 1).event, type: 'order.hacked' } }];
  assert.equal((await call('/api/v1/replica', 'server-a', { events: badEvent })).status, 400);
  assert.equal((await (await call('/api/v1/replica', 'server-a')).json()).lastSourceSeq, 0);
});

test('the database itself refuses to change or delete an event', async () => {
  const { call, db } = await setup();
  await call('/api/v1/replica', 'server-a', { events: [synced('a', 1)] });
  assert.throws(() => db.exec("UPDATE events SET type = 'x'"), /never changed/);
  assert.throws(() => db.exec('DELETE FROM events'), /never deleted/);
});

test("owners' phones: the shop server adds one, the phone reads, and a lost phone is withdrawn", async () => {
  const { call, del } = await setup();
  await call('/api/v1/replica', 'server-a', { events: [synced('a', 1)] });
  const made = await (await call('/api/v1/devices', 'server-a', {})).json();
  assert.match(made.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await call('/api/v1/events', made.token)).status, 200, 'the new phone can read');
  assert.equal((await call('/api/v1/devices', made.token, {})).status, 403, 'a phone cannot make phones');

  const list = await (await call('/api/v1/devices', 'server-a')).json();
  assert.ok(list.devices.some((d: { id: string }) => d.id === made.id));
  assert.equal((await del(`/api/v1/devices/${made.id}`, 'server-b')).status, 404, "another shop's server cannot touch it");
  assert.equal((await del('/api/v1/devices/dev-server-a', 'server-a')).status, 404, 'never a shop server');
  assert.equal((await del(`/api/v1/devices/${made.id}`, 'server-a')).status, 200);
  assert.equal((await call('/api/v1/events', made.token)).status, 401, 'the withdrawn phone is out');
});
