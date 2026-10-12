import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SyncEvent } from '../src/domain/sync.ts';
import { createCloud, sha256Hex } from '../cloud/src/cloud.ts';
import { fakeD1 } from '../cloud/src/fakeD1.ts';
import { startOnline } from './online.ts';

const SHOP = 'cheesybeez-thalwila-ab12';
const pizza = { itemId: 'devilled-chicken', qty: 1, size: 'L', adds: [], outs: [] };

/** The real cloud on Node's SQLite, a shop server talking to it, and a switch for the internet. */
async function setup(at = new Date(2026, 9, 13, 19, 0).getTime()) {
  const { d1, db } = fakeD1();
  db.prepare("INSERT INTO shops (id, name, created_at) VALUES (?, 'CheesyBeez Thalwila', 0)").run(SHOP);
  db.prepare("INSERT INTO devices (id, tenant_id, kind, token_hash, created_at) VALUES ('d', ?, 'shop_server', ?, 0)").run(SHOP, await sha256Hex('server-key'));
  const clock = { t: at };
  const cloud = createCloud(d1, { now: () => clock.t, orderShop: SHOP });
  const net = { up: true };
  const http = (async (url: string, init?: RequestInit) => {
    if (!net.up) throw new TypeError('fetch failed');
    return cloud(new Request(url, init));
  }) as typeof fetch;
  let open = true;
  const online = startOnline({
    url: 'https://cloud.test', token: 'server-key', fetch: http, every: 3_600_000, now: () => clock.t,
    isOpen: () => open, setOpen: (v) => { open = v; },
  });
  const customer = async (phone = '0771234567') => (await cloud(new Request('https://cloud.test/api/v1/orders', {
    method: 'POST', body: JSON.stringify({ name: 'Kasun', phone, lines: [pizza], note: 'Ring the bell' }),
  }))).json() as Promise<{ id: string; token: string }>;
  const status = async (o: { id: string; token: string }) =>
    ((await (await cloud(new Request(`https://cloud.test/api/v1/orders/${o.id}?t=${o.token}`))).json()) as { status: string }).status;
  await online.pollNow(); // the shop says it is open
  return { online, customer, status, clock, net, isOpen: () => open };
}

const ev = (type: string, orderNumber: number) => ({ type, orderNumber } as unknown as SyncEvent);

test('an online order reaches the counter; accepted, ready when the kitchen taps Done, collected when paid', async () => {
  const { online, customer, status, clock } = await setup();
  const mine = await customer();
  await online.pollNow();
  const v = online.view();
  assert.equal(v.connected, true);
  assert.deepEqual(v.orders.map((o) => [o.id, o.status, o.name, o.phone, o.note]), [[mine.id, 'new', 'Kasun', '0771234567', 'Ring the bell']]);

  await online.answer(mine.id, { status: 'accepted', orderNumber: 1023, readyBy: clock.t + 20 * 60_000 });
  assert.equal(await status(mine), 'accepted');
  online.onEvents([ev('kitchen.bumped', 999), ev('kitchen.bumped', 1023)]);
  await online.pollNow();
  assert.equal(await status(mine), 'ready');
  online.onEvents([ev('order.paid', 1023)]);
  await online.pollNow();
  assert.equal(await status(mine), 'collected');
  assert.deepEqual(online.view().orders, [], 'done: off the counter');
  online.stop();
});

test('the internet drops after Accept: the counter sees it at once, the customer as soon as it is back', async () => {
  const { online, customer, status, clock, net } = await setup();
  const mine = await customer();
  await online.pollNow();
  net.up = false;
  await online.answer(mine.id, { status: 'accepted', orderNumber: 1024, readyBy: clock.t + 15 * 60_000 });
  assert.equal(online.view().orders[0].status, 'accepted', 'the counter is not kept waiting');
  await online.pollNow();
  assert.equal(online.view().orders[0].status, 'accepted', 'still, while the cloud cannot be reached');
  net.up = true;
  assert.equal(await status(mine), 'new');
  await online.pollNow();
  assert.equal(await status(mine), 'accepted');
  online.stop();
});

test('declining an order the customer can no longer get is refused with a reason; online orders close overnight', async () => {
  const { online, customer, clock, isOpen } = await setup();
  const mine = await customer();
  clock.t += 11 * 60_000; // nobody answered: it expired
  await assert.rejects(online.answer(mine.id, { status: 'declined', reason: 'Too busy right now' }), /expired/);
  assert.equal(isOpen(), true);
  clock.t = new Date(2026, 9, 14, 3, 0).getTime();
  await online.pollNow();
  assert.equal(isOpen(), false, 'a forgotten switch never takes orders at 3 am');
  online.setOpen(true); // open late tonight: switched back on at the counter
  clock.t += 30 * 60_000;
  await online.pollNow();
  assert.equal(isOpen(), true, 'once a night only: it stays on');
  online.stop();
});
