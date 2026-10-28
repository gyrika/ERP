import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ONLINE_ANSWER_MS, ONLINE_SEEN_MS } from '../../src/domain/online.ts';
import { createCloud, sha256Hex, type CloudOptions } from './cloud.ts';
import { fakeD1 } from './fakeD1.ts';

const SHOP = 'cheesybeez-thalwila-ab12';

async function setup(order: Partial<Pick<CloudOptions, 'orderHours' | 'orderPhone' | 'orderAddress' | 'shopLocation' | 'deliveryPerKm' | 'deliveryMaxKm' | 'roadKm'>> = {}) {
  const { d1, db } = fakeD1();
  db.prepare("INSERT INTO shops (id, name, created_at) VALUES (?, 'CheesyBeez Thalwila', 0)").run(SHOP);
  db.prepare("INSERT INTO shops (id, name, created_at) VALUES ('other-shop', 'Other', 0)").run();
  for (const [tenant, token] of [[SHOP, 'server-a'], ['other-shop', 'server-b']]) {
    db.prepare("INSERT INTO devices (id, tenant_id, kind, token_hash, created_at) VALUES (?, ?, 'shop_server', ?, 0)")
      .run(`dev-${token}`, tenant, await sha256Hex(token));
  }
  const clock = { t: 1_000_000 };
  const handle = createCloud(d1, { now: () => clock.t, orderShop: SHOP, ...order });
  const call = async (path: string, body?: unknown, token?: string, ip = '1.2.3.4') => {
    const r = await handle(new Request(`https://cloud.test${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'cf-connecting-ip': ip, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
    return { status: r.status, body: await r.json() as Record<string, any> };
  };
  return { call, clock, db, d1 };
}

const pizza = { itemId: 'devilled-chicken', qty: 1, size: 'L', adds: [], outs: ['no-onion'] };
const customer = (phone = '0771234567', lines: unknown[] = [pizza]) => ({ name: 'Kasun', phone, lines, note: '' });

test('closed until the counter switches it on and the shop server is heard from', async () => {
  const { call, clock } = await setup();
  const shop = (await call('/api/v1/shop')).body;
  assert.deepEqual([shop.name, shop.open, shop.hours, shop.phone, shop.address, shop.menuState], ['CheesyBeez Thalwila', false, null, null, null, { overrides: {}, soldOut: {}, added: {} }]);
  assert.deepEqual((await (await setup({ orderHours: '11:00-21:00' })).call('/api/v1/shop')).body.hours, { opens: 660, closes: 1260 }, 'the hours, when set');
  const contact = (await (await setup({ orderPhone: '077 181 7968', orderAddress: ' 12 Main St ' })).call('/api/v1/shop')).body;
  assert.deepEqual([contact.phone, contact.address], ['0771817968', '12 Main St'], 'the contact, when set');
  assert.equal((await call('/api/v1/orders', customer())).status, 409);

  await call('/api/v1/online/poll', { open: true }, 'server-a');
  assert.equal((await call('/api/v1/shop')).body.open, true);
  clock.t += ONLINE_SEEN_MS + 1; // the shop PC went quiet (power cut, no internet)
  assert.equal((await call('/api/v1/shop')).body.open, false);
  await call('/api/v1/online/poll', { open: false }, 'server-a');
  assert.equal((await call('/api/v1/shop')).body.open, false, 'switched off at the counter');
});

test('order, accept, ready, collected: the customer follows it by their own link only', async () => {
  const { call, clock } = await setup();
  await call('/api/v1/online/poll', { open: true }, 'server-a');
  const placed = await call('/api/v1/orders', { ...customer(), lines: [{ ...pizza, qty: 2 }] });
  assert.equal(placed.status, 200);
  const { id, token, total } = placed.body;
  assert.ok(total > 0, 'priced by the cloud');

  const mine = () => call(`/api/v1/orders/${id}?t=${token}`);
  assert.equal((await mine()).body.status, 'new');
  assert.equal((await mine()).body.phone, undefined, 'the phone number is never sent back out');
  assert.equal((await call(`/api/v1/orders/${id}?t=wrong`)).status, 404, 'no link, no order');

  const polled = await call('/api/v1/online/poll', { open: true }, 'server-a');
  assert.deepEqual(polled.body.orders.map((o: any) => [o.id, o.name, o.phone]), [[id, 'Kasun', '0771234567']]);
  assert.deepEqual((await call('/api/v1/online/poll', { open: true }, 'server-b')).body.orders, [], "never another shop's");
  assert.equal((await call(`/api/v1/online/${id}`, { status: 'accepted', orderNumber: 1023, readyBy: clock.t }, 'server-b')).status, 404);

  assert.equal((await call(`/api/v1/online/${id}`, { status: 'ready' }, 'server-a')).status, 409, 'not before it is accepted');
  assert.equal((await call(`/api/v1/online/${id}`, { status: 'accepted' }, 'server-a')).status, 400, 'needs its number');
  const readyBy = clock.t + 20 * 60_000;
  const accepted = await call(`/api/v1/online/${id}`, { status: 'accepted', orderNumber: 1023, readyBy }, 'server-a');
  assert.equal(accepted.status, 200);
  assert.equal((await call(`/api/v1/online/${id}`, { status: 'accepted', orderNumber: 1023, readyBy }, 'server-a')).status, 200, 'twice is fine');
  assert.deepEqual([(await mine()).body.status, (await mine()).body.orderNumber, (await mine()).body.readyBy], ['accepted', 1023, readyBy]);

  await call(`/api/v1/online/${id}`, { status: 'ready' }, 'server-a');
  assert.equal((await mine()).body.status, 'ready');
  await call(`/api/v1/online/${id}`, { status: 'collected' }, 'server-a');
  assert.equal((await mine()).body.status, 'collected');
  assert.deepEqual((await call('/api/v1/online/poll', { open: true }, 'server-a')).body.orders, [], 'done: off the counter');
});

test('declined with a reason; unanswered orders run out and can no longer be accepted', async () => {
  const { call, clock } = await setup();
  await call('/api/v1/online/poll', { open: true }, 'server-a');
  const a = (await call('/api/v1/orders', customer('0771111111'))).body;
  const b = (await call('/api/v1/orders', customer('0772222222'))).body;
  assert.equal((await call(`/api/v1/online/${a.id}`, { status: 'declined', reason: '' }, 'server-a')).status, 400);
  await call(`/api/v1/online/${a.id}`, { status: 'declined', reason: 'Too busy right now' }, 'server-a');
  const seen = (await call(`/api/v1/orders/${a.id}?t=${a.token}`)).body;
  assert.deepEqual([seen.status, seen.reason], ['declined', 'Too busy right now']);

  clock.t += ONLINE_ANSWER_MS + 1;
  await call('/api/v1/online/poll', { open: true }, 'server-a');
  assert.equal((await call(`/api/v1/orders/${b.id}?t=${b.token}`)).body.status, 'expired');
  assert.equal((await call(`/api/v1/online/${b.id}`, { status: 'accepted', orderNumber: 1, readyBy: clock.t }, 'server-a')).status, 409);
  assert.deepEqual((await call('/api/v1/online/poll', { open: true }, 'server-a')).body.orders, []);
});

test('floods are slowed: two orders in play per phone, six an hour per connection', async () => {
  const { call } = await setup();
  await call('/api/v1/online/poll', { open: true }, 'server-a');
  assert.equal((await call('/api/v1/orders', customer('0771234567'))).status, 200);
  assert.equal((await call('/api/v1/orders', customer('0771234567'))).status, 200);
  assert.equal((await call('/api/v1/orders', customer('0771234567'))).status, 429);
  for (let i = 0; i < 4; i++) assert.equal((await call('/api/v1/orders', customer(`077000000${i}`))).status, 200);
  const sixth = await call('/api/v1/orders', customer('0779999999'));
  assert.equal(sixth.status, 429);
  assert.match(sixth.body.message, /call the shop/);
  assert.equal((await call('/api/v1/orders', customer('0779999999'), undefined, '5.6.7.8')).status, 200, 'another connection');
  assert.equal((await call('/api/v1/orders', { ...customer('0778888888'), lines: [{ itemId: 'lobster', qty: 1 }] }, undefined, '9.9.9.9')).body.message,
    'something on the order is not on the menu');
});

test("a customer's name and phone are blanked after 30 days", async () => {
  const { call, clock, db } = await setup();
  await call('/api/v1/online/poll', { open: true }, 'server-a');
  await call('/api/v1/orders', customer());
  clock.t += 31 * 24 * 60 * 60_000;
  await call('/api/v1/online/poll', { open: true }, 'server-a');
  assert.deepEqual({ ...db.prepare('SELECT name, phone, ip_hash FROM online_orders').get() }, { name: '', phone: '', ip_hash: null });
});

test("online orders follow the owner's menu: new prices, nothing sold out or hidden", async () => {
  const { call, clock, db } = await setup();
  const owner = { id: 'o', name: 'Nisal', role: 'owner' };
  let seq = 0;
  const menuEvent = (e: object) => db.prepare(`INSERT INTO events (tenant_id, id, source_seq, source_device, type, order_number, at, received_at, copied_at, body)
    VALUES (?, ?, ?, 'dev', ?, 0, 1, 1, 1, ?)`).run(SHOP, `m${++seq}`, seq, (e as { type: string }).type, JSON.stringify({ id: `m${seq}`, shopId: SHOP, at: 1, orderNumber: 0, actor: owner, ...e }));
  menuEvent({ type: 'menu.item_set', itemId: 'devilled-chicken', before: {}, after: { prices: { L: 300000 } } });
  menuEvent({ type: 'menu.sold_out', itemId: 'seafood', until: clock.t + 3_600_000 });
  menuEvent({ type: 'menu.item_set', itemId: 'chicken-burger', before: {}, after: { hidden: true } });
  menuEvent({ type: 'menu.item_added', itemId: 'new-cheese-burger', item: { category: 'burger', name: { en: 'Cheese Burger' }, description: '', prices: { one: 55000 } } });
  await call('/api/v1/online/poll', { open: true }, 'server-a');

  const shop = (await call('/api/v1/shop')).body;
  assert.equal(shop.menuState.overrides['devilled-chicken'].prices.L, 300000, 'the page gets the changes');
  assert.equal((await call('/api/v1/orders', customer())).body.total, 300000, 'priced with the new price');
  assert.match((await call('/api/v1/orders', customer('0772222222', [{ itemId: 'seafood', qty: 1, size: 'L' }]))).body.message, /sold out today/);
  assert.match((await call('/api/v1/orders', customer('0773333333', [{ itemId: 'chicken-burger', qty: 1 }]))).body.message, /not on the menu/);
  assert.equal(shop.menuState.added['new-cheese-burger'].name.en, 'Cheese Burger', "the page gets the owner's new items");
  assert.equal((await call('/api/v1/orders', customer('0774444444', [{ itemId: 'new-cheese-burger', qty: 2 }]))).body.total, 110000, 'and they can be ordered');
});

const DELIVERS = { shopLocation: '6.8235,79.8901', deliveryPerKm: '50', deliveryMaxKm: '5' };

test('delivery (SCRUM-193): offered only once set up; priced by road from the shop; the address reaches the counter, never the location to anyone else; out, then delivered', async () => {
  const pickupOnly = await setup();
  await pickupOnly.call('/api/v1/online/poll', { open: true }, 'server-a');
  assert.equal((await pickupOnly.call('/api/v1/shop')).body.delivery, null);
  const refused = await pickupOnly.call('/api/v1/orders', { ...customer(), kind: 'delivery', address: '12 Station Rd', pin: { lat: 6.84, lng: 79.9 } });
  assert.deepEqual([refused.status, refused.body.message], [400, 'the shop is not delivering right now: choose pickup']);

  const asked: unknown[] = [];
  let road: number | null = 2.1;
  const { call, clock, db } = await setup({ ...DELIVERS, roadKm: async (from, to) => { asked.push([from, to]); return road; } });
  await call('/api/v1/online/poll', { open: true }, 'server-a');
  assert.deepEqual((await call('/api/v1/shop')).body.delivery, { perKm: 5000, maxKm: 5 });
  const pin = { lat: 6.84, lng: 79.9 };
  assert.deepEqual((await call('/api/v1/delivery-quote', { pin })).body, { km: 2.1, fee: 15000 });
  assert.deepEqual(asked[0], [{ lat: 6.8235, lng: 79.8901 }, pin], 'from the shop to the customer');
  road = 7.4;
  assert.deepEqual((await call('/api/v1/delivery-quote', { pin })).body, { reason: 'you are 7.4 km away: we deliver up to 5 km. Choose pickup, or call the shop' });
  road = null; // the road service did not answer: the straight line × 1.3
  const guessed = (await call('/api/v1/delivery-quote', { pin: { lat: 6.8325, lng: 79.8901 } })).body;
  assert.deepEqual(guessed, { km: 1.3, fee: 10000 });
  road = 2.1;

  const pickup = await call('/api/v1/orders', customer('0770000001'));
  const placed = await call('/api/v1/orders', { ...customer(), kind: 'delivery', address: '12 Station Rd', pin, deliveryFee: 0 });
  assert.equal(placed.status, 200);
  assert.equal(placed.body.total, pickup.body.total + 15000, 'the fee is the cloud\'s, whatever the phone sent');
  const noPin = await call('/api/v1/orders', { ...customer('0770000002'), kind: 'delivery', address: '12 Station Rd' });
  assert.deepEqual([noPin.status, noPin.body.message], [400, 'share your location for delivery (the fee is by distance), or choose pickup']);

  const counter = (await call('/api/v1/online/poll', { open: true }, 'server-a')).body.orders.find((o: { id: string }) => o.id === placed.body.id);
  assert.deepEqual([counter.kind, counter.address, counter.pin, counter.distanceKm, counter.deliveryFee], ['delivery', '12 Station Rd', pin, 2.1, 15000]);
  const { id, token } = placed.body;
  const mine = async () => (await call(`/api/v1/orders/${id}?t=${token}`)).body;
  const own = await mine();
  assert.deepEqual([own.address, own.distanceKm, own.pin, own.phone], ['12 Station Rd', 2.1, undefined, undefined], 'their own page: no phone, no location');

  const answer = (body: unknown) => call(`/api/v1/online/${id}`, body, 'server-a');
  assert.equal((await answer({ status: 'accepted', orderNumber: 1030, readyBy: clock.t + 45 * 60_000 })).status, 200);
  assert.equal((await answer({ status: 'collected' })).status, 409, 'a delivery is never collected');
  assert.equal((await call(`/api/v1/online/${pickup.body.id}`, { status: 'out' }, 'server-a')).status, 409, 'pickup never goes out');
  assert.equal((await answer({ status: 'out' })).status, 200);
  assert.equal((await mine()).status, 'out');
  assert.ok((await call('/api/v1/online/poll', { open: true }, 'server-a')).body.orders.some((o: { id: string }) => o.id === id), 'still on the counter while out');
  assert.equal((await answer({ status: 'delivered' })).status, 200);
  assert.equal((await mine()).status, 'delivered');

  clock.t += 31 * 24 * 60 * 60_000;
  await call('/api/v1/online/poll', { open: true }, 'server-a');
  assert.deepEqual({ ...db.prepare('SELECT name, phone, address, pin FROM online_orders WHERE id = ?').get(id) }, { name: '', phone: '', address: null, pin: null },
    'the address and location go with the name after 30 days');
});
