import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import type { StreamMessage, SyncEvent } from '../src/domain/sync.ts';
import { createApp } from './app.ts';
import { memoryStore, type EventStore } from './store.ts';

const SHOP = 'shop-a';

const ev = (id: string, shopId = SHOP): SyncEvent =>
  ({ id, shopId, at: 1000, orderNumber: 1001, ticketId: 't1', type: 'kitchen.seen' });

async function start(store: EventStore = memoryStore()) {
  const server = createApp({ store, now: () => 5000 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const counter = await store.addDevice(SHOP, 'Shop A', 'counter');
  const kitchen = await store.addDevice(SHOP, 'Shop A', 'kitchen');
  const other = await store.addDevice('shop-b', 'Shop B', 'counter');
  const call = (path: string, token: string | null, body?: unknown) =>
    fetch(`http://${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const push = (token: string, events: unknown[]) => call('/api/v1/events', token, { deviceId: 'x', events });
  /** Opens a stream and collects its messages. */
  const stream = async (token: string, after = 0) => {
    const ws = new WebSocket(`ws://${base}/api/v1/stream?after=${after}&token=${encodeURIComponent(token)}`);
    const got: StreamMessage[] = [];
    ws.on('message', (m) => got.push(JSON.parse(String(m)) as StreamMessage));
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    return { ws, got };
  };
  const stop = () => new Promise<void>((r) => server.close(() => r()));
  return { call, push, stream, stop, tokens: { counter: counter.token, kitchen: kitchen.token, other: other.token } };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check(), 'timed out');
};

test('health needs no token', async () => {
  const s = await start();
  const r = await s.call('/api/v1/health', null);
  assert.deepEqual(await r.json(), { ok: true, serverTime: 5000 });
  await s.stop();
});

test('push is idempotent: the same batch twice is stored once, with the same seq', async () => {
  const s = await start();
  const first = await (await s.push(s.tokens.counter, [ev('a'), ev('b')])).json();
  const again = await (await s.push(s.tokens.counter, [ev('a'), ev('b'), ev('c')])).json();
  assert.deepEqual(first.accepted, [{ id: 'a', seq: 1 }, { id: 'b', seq: 2 }]);
  assert.deepEqual(again.accepted, [{ id: 'a', seq: 1 }, { id: 'b', seq: 2 }, { id: 'c', seq: 3 }]);
  const pulled = await (await s.call('/api/v1/events?after=0', s.tokens.kitchen)).json();
  assert.deepEqual(pulled.events.map((e: { event: SyncEvent }) => e.event.id), ['a', 'b', 'c']);
  assert.equal(pulled.events[0].receivedAt, 5000);
  await s.stop();
});

test('bad token 401, another shop 403, bad shape 400; nothing stored', async () => {
  const s = await start();
  assert.equal((await s.push('nope', [ev('a')])).status, 401);
  const wrong = await s.push(s.tokens.counter, [ev('a'), ev('b', 'shop-b')]);
  assert.equal(wrong.status, 403);
  assert.equal((await wrong.json()).error, 'wrong_shop');
  assert.equal((await s.push(s.tokens.counter, [{ ...ev('a'), type: 'order.hacked' }])).status, 400);
  assert.equal((await s.push(s.tokens.counter, [{ ...ev('a'), id: '' }])).status, 400);
  const pulled = await (await s.call('/api/v1/events', s.tokens.counter)).json();
  assert.deepEqual(pulled.events, []);
  await s.stop();
});

test('pull pages with after/limit and says when there is more', async () => {
  const s = await start();
  await s.push(s.tokens.counter, ['a', 'b', 'c'].map((id) => ev(id)));
  const p1 = await (await s.call('/api/v1/events?after=0&limit=2', s.tokens.counter)).json();
  assert.equal(p1.more, true);
  assert.equal(p1.lastSeq, 2);
  const p2 = await (await s.call(`/api/v1/events?after=${p1.lastSeq}&limit=2`, s.tokens.counter)).json();
  assert.equal(p2.more, false);
  assert.deepEqual(p2.events.map((e: { seq: number }) => e.seq), [3]);
  await s.stop();
});

test('stream: hello, catch-up, then live events; only to the same shop', async () => {
  const s = await start();
  await s.push(s.tokens.counter, [ev('a')]);
  const kitchen = await s.stream(s.tokens.kitchen, 0);
  const otherShop = await s.stream(s.tokens.other, 0);
  await until(() => kitchen.got.length === 2);
  assert.deepEqual(kitchen.got[0], { type: 'hello', lastSeq: 1, serverTime: 5000 });

  await s.push(s.tokens.counter, [ev('b')]);
  await s.push(s.tokens.counter, [ev('b')]); // a repeat is not streamed again
  await until(() => kitchen.got.length === 3);
  await new Promise((r) => setTimeout(r, 50));
  const ids = kitchen.got.flatMap((m) => (m.type === 'event' ? [m.data.event.id] : []));
  assert.deepEqual(ids, ['a', 'b']);
  assert.deepEqual(otherShop.got.map((m) => m.type), ['hello']);

  kitchen.ws.close();
  otherShop.ws.close();
  await s.stop();
});

test('stream refuses a bad token', async () => {
  const s = await start();
  await assert.rejects(s.stream('nope'));
  await s.stop();
});
