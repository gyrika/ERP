import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import type { StreamMessage, SyncEvent } from '../src/domain/sync.ts';
import { createApp, type AppOptions } from './app.ts';
import type { RawPrinter } from './printer.ts';
import { PinTaken, memoryStore, type EventStore } from './store.ts';

const SHOP = 'shop-a';

const ev = (id: string, shopId = SHOP): SyncEvent =>
  ({ id, shopId, at: 1000, orderNumber: 1001, ticketId: 't1', type: 'kitchen.seen' });

async function start(store: EventStore = memoryStore(), printer?: RawPrinter, more: Partial<AppOptions> = {}) {
  const server = createApp({ store, printer, now: () => 5000, ...more });
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

test('health says when an update is under way, so the counter can show it', async () => {
  const update = { phase: 'downloading' as const, percent: 42, version: '1.0.10', at: 4000 };
  const s = await start(memoryStore(), undefined, { version: () => '1.0.9', updating: () => update });
  assert.deepEqual(await (await s.call('/api/v1/health', null)).json(), { ok: true, serverTime: 5000, version: '1.0.9', update });
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

test('print: only the counter, bytes delivered as sent, a printer failure is a clear 503', async () => {
  const printed: number[][] = [];
  let jammed = false;
  const printer: RawPrinter = {
    name: 'test',
    async print(bytes) { if (jammed) throw new Error('paper out'); printed.push([...bytes]); },
  };
  const s = await start(memoryStore(), printer);
  const data = Buffer.from([0x1b, 0x40, 0x48, 0x69]).toString('base64');

  assert.equal((await s.call('/api/v1/print', s.tokens.counter, { data })).status, 200);
  assert.deepEqual(printed, [[0x1b, 0x40, 0x48, 0x69]]);

  const kitchen = await s.call('/api/v1/print', s.tokens.kitchen, { data });
  assert.equal(kitchen.status, 403, 'a kitchen tablet must never open the cash drawer');
  assert.equal((await s.call('/api/v1/print', null, { data })).status, 401);
  assert.equal((await s.call('/api/v1/print', s.tokens.counter, { data: '' })).status, 400);

  jammed = true;
  const failed = await s.call('/api/v1/print', s.tokens.counter, { data });
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).error, 'printer');
  assert.equal(printed.length, 1);
  await s.stop();
});

test('print without a printer set up answers 503', async () => {
  const s = await start();
  const r = await s.call('/api/v1/print', s.tokens.counter, { data: Buffer.from('x').toString('base64') });
  assert.equal(r.status, 503);
  await s.stop();
});

// ----- logins and roles (SCRUM-40/41) -----

const order = (id: string, type: string, actor: { id: string; name: string; role: string }, at = 5000) =>
  ({ id, shopId: SHOP, at, actor, orderNumber: 1001, type, ticketId: 't', lines: [], addOn: false,
    totalBefore: 0, totalAfter: 0, before: null, after: { kind: 'percent', pct: 10 } });

async function staffed() {
  const store = memoryStore();
  const cashier = await store.addStaff(SHOP, 'Nimal', 'cashier', '1111');
  const manager = await store.addStaff(SHOP, 'Ravi', 'manager', '2580');
  const s = await start(store);
  const login = (pin: string, purpose = 'shift', token = s.tokens.counter) => s.call('/api/v1/login', token, { pin, purpose });
  return { ...s, store, cashier, manager, login };
}

test('login: the PIN finds the person; wrong PINs are slowed down', async () => {
  const s = await staffed();
  const ok = await s.login('1111');
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).actor, { id: s.cashier.id, name: 'Nimal', role: 'cashier' });

  assert.equal((await s.login('1111', 'manager')).status, 401, "a cashier's PIN does not open manager mode");
  assert.equal((await s.login('2580', 'manager')).status, 200);
  assert.equal((await s.login('12a4')).status, 401);
  for (let i = 0; i < 3; i++) assert.equal((await s.login('9999')).status, 401);
  // 5 wrong in a row (counting the two above): the device must wait, even with a right PIN.
  assert.equal((await s.login('9999')).status, 401);
  const blocked = await s.login('1111');
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error, 'too_many');
  await s.stop();
});

test('the server checks roles: a cashier cannot discount, even by sending the event itself', async () => {
  const s = await staffed();
  await s.login('1111');
  const nimal = { id: s.cashier.id, name: 'Nimal', role: 'cashier' };
  const ravi = { id: s.manager.id, name: 'Ravi', role: 'manager' };

  const r = await (await s.push(s.tokens.counter, [
    order('sale', 'order.sent', nimal),
    order('sneaky', 'order.discount_set', nimal),
    order('forged', 'order.discount_set', ravi), // Ravi never logged in on this device
    order('liar', 'order.discount_set', { ...nimal, role: 'manager' }), // claims a role it was not given
  ])).json();
  assert.deepEqual(r.accepted.map((a: { id: string }) => a.id), ['sale']);
  assert.deepEqual(r.rejected.map((x: { id: string }) => x.id), ['sneaky', 'forged', 'liar']);

  await s.login('2580', 'manager');
  const ok = await (await s.push(s.tokens.counter, [order('real', 'order.discount_set', ravi)])).json();
  assert.deepEqual(ok.accepted.map((a: { id: string }) => a.id), ['real']);
  assert.equal(ok.rejected, undefined);

  const pulled = await (await s.call('/api/v1/events', s.tokens.counter)).json();
  assert.deepEqual(pulled.events.map((e: { event: { id: string } }) => e.event.id), ['sale', 'real'], 'refused events are never stored');
  await s.stop();
});

test('a cashier records a kitchen Remake and its Undo, but not the bin\'s waste (SCRUM-177)', async () => {
  const s = await staffed();
  await s.login('1111');
  const nimal = { id: s.cashier.id, name: 'Nimal', role: 'cashier' };
  const waste = (id: string, extra: Record<string, unknown>) => ({
    ...order(id, 'stock.wasted', nimal), orderNumber: 0, what: { kind: 'dish', itemId: 'margherita', size: 'L' }, name: 'Margherita · Large', qty: 1, reason: 'burnt', ...extra,
  });
  const r = await (await s.push(s.tokens.counter, [
    waste('remake', { ticketId: 't1', lineId: 'L1' }),
    { ...order('undo', 'stock.waste_undone', nimal), orderNumber: 0, wasteId: 'remake', ticketId: 't1' },
    waste('bin', { ticketId: undefined }),
  ])).json();
  assert.deepEqual(r.accepted.map((a: { id: string }) => a.id), ['remake', 'undo']);
  assert.deepEqual(r.rejected.map((x: { id: string }) => x.id), ['bin']);
  await s.stop();
});

test('a session covers its own time only, and only on the device it was opened on', async () => {
  const s = await staffed();
  await s.login('1111');
  const nimal = { id: s.cashier.id, name: 'Nimal', role: 'cashier' };
  const r = await (await s.push(s.tokens.counter, [order('early', 'order.sent', nimal, 5000 - 10 * 60_000)])).json();
  assert.deepEqual(r.rejected.map((x: { id: string }) => x.id), ['early']);
  const kitchen = await (await s.push(s.tokens.kitchen, [order('k', 'order.sent', nimal), ev('tap')])).json();
  assert.deepEqual(kitchen.rejected.map((x: { id: string }) => x.id), ['k'], 'a kitchen device only records kitchen taps');
  assert.deepEqual(kitchen.accepted.map((a: { id: string }) => a.id), ['tap']);
  await s.stop();
});

test('order events must say who did them', async () => {
  const s = await staffed();
  const r = await s.push(s.tokens.counter, [{ ...order('x', 'order.sent', { id: 'a', name: 'A', role: 'cashier' }), actor: undefined }]);
  assert.equal(r.status, 400);
  await s.stop();
});

test('staff: a PIN belongs to one active person; a deactivated PIN stops working', async () => {
  const store = memoryStore();
  const a = await store.addStaff(SHOP, 'Nimal', 'cashier', '1111');
  await assert.rejects(store.addStaff(SHOP, 'Kamal', 'cashier', '1111'), PinTaken);
  await store.addStaff('other-shop', 'Elsewhere', 'cashier', '1111'); // another shop may reuse it
  assert.equal((await store.staffByPin(SHOP, '1111'))?.id, a.id);
  assert.equal(await store.deactivateStaff(SHOP, a.id), true);
  assert.equal(await store.staffByPin(SHOP, '1111'), null);
  await store.addStaff(SHOP, 'Kamal', 'cashier', '1111'); // free again
});

test('stock: only a logged-in manager or owner may change it, and only from the counter', async () => {
  const s = await staffed();
  await s.login('1111');
  await s.login('2580');
  const stock = (id: string, actor: { id: string; name: string; role: string }) =>
    ({ id, shopId: SHOP, at: 5000, orderNumber: 0, actor, type: 'stock.unit_set', itemId: 'inv-0001', name: 'Tray', base: 30 });
  const r = await (await s.push(s.tokens.counter, [
    stock('by-cashier', { id: s.cashier.id, name: 'Nimal', role: 'cashier' }),
    stock('by-manager', { id: s.manager.id, name: 'Ravi', role: 'manager' }),
  ])).json();
  assert.deepEqual(r.accepted.map((a: { id: string }) => a.id), ['by-manager']);
  assert.deepEqual(r.rejected.map((x: { id: string }) => x.id), ['by-cashier']);
  const kitchen = await (await s.push(s.tokens.kitchen, [stock('k', { id: s.manager.id, name: 'Ravi', role: 'manager' })])).json();
  assert.deepEqual(kitchen.rejected.map((x: { id: string }) => x.id), ['k']);
  await s.stop();
});

test('numbers: the server numbers each new PO and GRN, devices cannot number documents themselves', async () => {
  const s = await staffed();
  await s.login('2580');
  const by = { id: s.manager.id, name: 'Ravi', role: 'manager' };
  const doc = (id: string, type: string, rest: object) => ({ id, shopId: SHOP, at: 5000, orderNumber: 0, actor: by, type, ...rest });
  const po = (id: string) => doc(id, 'stock.ordered', { supplierId: 'sup', lines: [{ itemId: 'inv-0001', packs: 2 }] });
  const grn = doc('g1', 'stock.grn', { orderId: 'p1', supplierId: 'sup', lines: [{ itemId: 'inv-0001', ordered: 2, received: 2, accepted: 2 }], approvedBy: null });
  const numbers = async () => Object.fromEntries(((await (await s.call('/api/v1/events?after=0', s.tokens.counter)).json()).events as { event: { type: string; docId?: string; number?: string } }[])
    .filter((e) => e.event.type === 'stock.numbered').map((e) => [e.event.docId, e.event.number]));

  await s.push(s.tokens.counter, [po('p1'), grn]);
  await s.push(s.tokens.counter, [po('p2')]);
  await s.push(s.tokens.counter, [po('p1')]); // the device pushes again: nothing new
  assert.deepEqual(await numbers(), { p1: 'PO-0001', g1: 'GRN-0001', p2: 'PO-0002' });

  const cheat = await (await s.push(s.tokens.counter, [doc('n1', 'stock.numbered', { docId: 'p9', kind: 'PO', number: 'PO-0001' })])).json();
  assert.deepEqual(cheat.rejected.map((x: { id: string; reason: string }) => x.reason), ['only the shop server numbers documents']);
  assert.equal(Object.keys(await numbers()).length, 3);
  await s.stop();
});

test('production: a held batch reaches the kitchen when the server sees its input made; devices cannot release one', async () => {
  const s = await staffed();
  const owner = await s.store.addStaff(SHOP, 'Anton', 'owner', '3690');
  await s.login('3690');
  const by = { id: owner.id, name: 'Anton', role: 'owner' };
  const doc = (id: string, type: string, rest: object) => ({ id, shopId: SHOP, at: 5000, orderNumber: 0, actor: by, type, ...rest });
  const answer = (id: string, question: string, after: object) => doc(id, 'recipe.answer_set', { question, before: null, after });
  const released = async () => ((await (await s.call('/api/v1/events?after=0', s.tokens.counter)).json()).events as { event: { id: string; type: string } }[])
    .filter((e) => e.event.type === 'prep.released').map((e) => e.event.id);

  await s.push(s.tokens.counter, [
    answer('a1', 'prep:kculture', { kind: 'prep', name: 'Culture', makes: { qty: 2000, unit: 'g' }, lines: [{ name: 'stock:inv-0001', qty: 1000, unit: 'g' }] }),
    answer('a2', 'prep:kdough', { kind: 'prep', name: 'Dough', makes: { qty: 10000, unit: 'g' }, lines: [{ name: 'kitchen:kculture', qty: 2000, unit: 'g' }] }),
    doc('o1', 'prep.ordered', { ticketId: 'culture-1', prepId: 'kitchen:kculture', name: 'Culture', qty: 2000, unit: 'g' }),
    doc('o2', 'prep.ordered', { ticketId: 'dough-1', prepId: 'kitchen:kdough', name: 'Dough', qty: 10000, unit: 'g', waitFor: ['Culture'], plan: 'dough-1' }),
  ]);
  assert.deepEqual(await released(), [], 'the culture is not made yet');

  const cheat = await (await s.push(s.tokens.counter, [doc('r1', 'prep.released', { ticketId: 'dough-1', prepId: 'kitchen:kdough', name: 'Dough', qty: 10000, unit: 'g', waited: ['Culture'] })])).json();
  assert.deepEqual(cheat.rejected.map((x: { reason: string }) => x.reason), ['only the shop server sends held batches to the kitchen']);

  await s.push(s.tokens.kitchen, [{ id: 'b1', shopId: SHOP, at: 5000, orderNumber: 0, ticketId: 'culture-1', type: 'kitchen.bumped' }]);
  assert.deepEqual(await released(), ['rel-dough-1'], 'the culture is Done: the dough goes, once');
  await s.push(s.tokens.kitchen, [{ id: 'b2', shopId: SHOP, at: 5000, orderNumber: 0, ticketId: 'none', type: 'kitchen.seen' }]);
  assert.deepEqual(await released(), ['rel-dough-1']);
  await s.stop();
});

test('purchasing: the server re-checks the order against what it stored, and says what to do', async () => {
  const s = await staffed();
  await s.login('2580');
  const by = { id: s.manager.id, name: 'Ravi', role: 'manager' };
  const doc = (id: string, type: string, rest: object) => ({ id, shopId: SHOP, at: 5000, orderNumber: 0, actor: by, type, ...rest });
  const order = doc('p1', 'stock.ordered', { supplierId: 'sup', lines: [{ itemId: 'inv-0001', packs: 2 }] });
  const grn = (id: string, extra: object = {}) => doc(id, 'stock.grn', { orderId: 'p1', supplierId: 'sup', lines: [{ itemId: 'inv-0001', ordered: 2, received: 2, accepted: 2 }], approvedBy: null, ...extra });
  const reasons = async (events: unknown[]) => ((await (await s.push(s.tokens.counter, events)).json()).rejected ?? []).map((x: { reason: string }) => x.reason);

  assert.deepEqual(await reasons([order, grn('g1')]), []);
  assert.match((await reasons([grn('g2')]))[0], /is closed/, 'a second device receiving the same order');
  assert.match((await reasons([doc('e1', 'stock.order_edited', { orderId: 'p1', lines: [{ itemId: 'inv-0001', packs: 9 }] })]))[0], /already being received/);
  assert.deepEqual(await reasons([order, grn('g1')]), [], 'sent again: nothing new to refuse');

  // A manager's name on the device is not enough: it must be a real manager of this shop.
  const o2 = doc('p2', 'stock.ordered', { supplierId: 'sup', lines: [{ itemId: 'inv-0001', packs: 2 }] });
  const short = grn('g3', { orderId: 'p2', lines: [{ itemId: 'inv-0001', ordered: 2, received: 1, accepted: 1 }], shortDecision: 'close' });
  assert.match((await reasons([o2, { ...short, approvedBy: { id: 'made-up', name: 'Boss', role: 'owner' } }]))[0], /not from a manager or the owner/);
  assert.deepEqual(await reasons([{ ...short, approvedBy: by }]), []);
  await s.stop();
});

test('sync retry: pushing the same documents again stores them once and numbers them once', async () => {
  const s = await staffed();
  await s.login('2580');
  const by = { id: s.manager.id, name: 'Ravi', role: 'manager' };
  const events = [
    { id: 'p1', shopId: SHOP, at: 5000, orderNumber: 0, actor: by, type: 'stock.ordered', supplierId: 'sup', lines: [{ itemId: 'inv-0001', packs: 2 }] },
    { id: 'g1', shopId: SHOP, at: 5000, orderNumber: 0, actor: by, type: 'stock.grn', orderId: 'p1', supplierId: 'sup', lines: [{ itemId: 'inv-0001', ordered: 2, received: 2, accepted: 2 }], approvedBy: null },
  ];
  for (let i = 0; i < 3; i++) assert.deepEqual(((await (await s.push(s.tokens.counter, events)).json()).rejected ?? []), []);
  const all = ((await (await s.call('/api/v1/events?after=0', s.tokens.counter)).json()).events as { event: { id: string; type: string } }[]).map((e) => `${e.event.type}:${e.event.id}`);
  assert.deepEqual(all.sort(), ['stock.grn:g1', 'stock.numbered:num-g1', 'stock.numbered:num-p1', 'stock.ordered:p1']);
  await s.stop();
});

test('menu: only a logged-in owner changes prices and names; a manager may mark things sold out', async () => {
  const s = await staffed();
  const owner = await s.store.addStaff(SHOP, 'Nisal', 'owner', '1234');
  await s.login('2580');
  await s.login('1234');
  const who = (role: 'manager' | 'owner') => (role === 'owner' ? { id: owner.id, name: 'Nisal', role } : { id: s.manager.id, name: 'Ravi', role });
  const set = (id: string, role: 'manager' | 'owner') =>
    ({ id, shopId: SHOP, at: 5000, orderNumber: 0, actor: who(role), type: 'menu.item_set', itemId: 'margherita', before: {}, after: { prices: { M: 160000 } } });
  const sold = (id: string, role: 'manager' | 'owner') =>
    ({ id, shopId: SHOP, at: 5000, orderNumber: 0, actor: who(role), type: 'menu.sold_out', itemId: 'seafood', until: 9999 });
  const r = await (await s.push(s.tokens.counter, [set('price-by-owner', 'owner'), set('price-by-manager', 'manager'), sold('sold-by-manager', 'manager')])).json();
  assert.deepEqual(r.accepted.map((a: { id: string }) => a.id), ['price-by-owner', 'sold-by-manager']);
  assert.deepEqual(r.rejected.map((x: { id: string }) => x.id), ['price-by-manager']);
  await s.stop();
});

// ----- the manager's phone and shelf photos (SCRUM-94) -----

const counted = (id: string, actor: { id: string; name: string; role: string }, photo?: string) =>
  ({ id, shopId: SHOP, at: 5000, orderNumber: 0, actor, type: 'stock.counted', itemId: 'inv-0006', counted: 1000, expected: 2000,
    entries: [], reason: 'unknown', valueCents: -260000, tier: 'daily', ...(photo ? { photo } : {}) });

test('a manager-kind device (the phones\' inbox) opens for managers and owners only, and records stock only', async () => {
  const store = memoryStore();
  await store.addStaff(SHOP, 'Nimal', 'cashier', '1111');
  const manager = await store.addStaff(SHOP, 'Ravi', 'manager', '2580');
  const s = await start(store);
  const phone = await store.addDevice(SHOP, 'Shop A', 'manager');
  const login = (pin: string) => s.call('/api/v1/login', phone.token, { pin, purpose: 'shift' });
  assert.equal((await login('1111')).status, 401, "a cashier's PIN does not open the manager phone");
  assert.equal((await login('2580')).status, 200);

  const ravi = { id: manager.id, name: 'Ravi', role: 'manager' };
  const r = await (await s.push(phone.token, [counted('c', ravi), order('o', 'order.sent', ravi), ev('tap')])).json();
  assert.deepEqual(r.accepted.map((a: { id: string }) => a.id), ['c']);
  assert.deepEqual(r.rejected.map((x: { id: string }) => x.id), ['o', 'tap']);
  await s.stop();
});

test('only the owner sets how often an item is counted, even sending the event itself', async () => {
  const store = memoryStore();
  const manager = await store.addStaff(SHOP, 'Ravi', 'manager', '2580');
  const owner = await store.addStaff(SHOP, 'Owner', 'owner', '9999');
  const s = await start(store);
  await s.call('/api/v1/login', s.tokens.counter, { pin: '2580', purpose: 'shift' });
  await s.call('/api/v1/login', s.tokens.counter, { pin: '9999', purpose: 'shift' });
  const tier = (id: string, actor: { id: string; name: string; role: string }) =>
    ({ id, shopId: SHOP, at: 5000, orderNumber: 0, actor, type: 'stock.tier_set', itemId: 'inv-0006', tier: 'daily' });
  const r = await (await s.push(s.tokens.counter, [
    tier('m', { id: manager.id, name: 'Ravi', role: 'manager' }), tier('o', { id: owner.id, name: 'Owner', role: 'owner' }),
  ])).json();
  assert.deepEqual(r.accepted.map((a: { id: string }) => a.id), ['o']);
  assert.deepEqual(r.rejected.map((x: { id: string }) => x.id), ['m']);
  await s.stop();
});

test('photos at the counter: from the cloud the first time, then from this PC; never on the kitchen tablet', async () => {
  const saved = new Map<string, Buffer>();
  const photos = {
    save: (t: string, id: string, b: Buffer) => { if (!saved.has(`${t}/${id}`)) saved.set(`${t}/${id}`, b); },
    read: (t: string, id: string) => saved.get(`${t}/${id}`) ?? null,
  };
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  let asked = 0;
  const cloudPhoto = async (_t: string, id: string) => { asked++; return id === 'ph-abcdefgh12' ? jpeg : null; };
  const s = await start(memoryStore(), undefined, { photos, cloudPhoto });
  const id = 'ph-abcdefgh12';
  for (let i = 0; i < 2; i++) {
    const back = await s.call(`/api/v1/photos/${id}`, s.tokens.counter);
    assert.equal(back.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await back.arrayBuffer()), jpeg);
  }
  assert.equal(asked, 1, 'kept on this PC after the first time');
  assert.equal((await s.call('/api/v1/photos/ph-unknown123', s.tokens.counter)).status, 404);
  assert.equal((await s.call(`/api/v1/photos/${id}`, s.tokens.kitchen)).status, 403);
  assert.equal((await s.call('/api/v1/photos', s.tokens.counter, { id, data: jpeg.toString('base64') })).status, 404, 'phones send photos to the cloud, not here');
  await s.stop();
});

// ----- voice at the counter (SCRUM-145) -----

test("voice: the counter's request goes to the cloud as it is and the answer comes back; never from a kitchen tablet", async () => {
  const asked: { tenantId: string; task: string; body: string; type: string }[] = [];
  const cloudAi: AppOptions['cloudAi'] = async (tenantId, task, body, type) => {
    asked.push({ tenantId, task, body: body.toString('utf8'), type });
    return { status: 200, body: Buffer.from(task === 'command' ? '{"id":"stock","cached":false}' : '{"text":"open stock"}') };
  };
  const s = await start(memoryStore(), undefined, { cloudAi });
  const pick = await s.call('/api/v1/ai/command', s.tokens.counter, { text: 'open stock', commands: [{ id: 'stock', label: 'Stock' }] });
  assert.deepEqual(await pick.json(), { id: 'stock', cached: false });
  assert.equal(asked[0].tenantId, SHOP);
  assert.equal(asked[0].task, 'command');
  assert.match(asked[0].body, /open stock/);
  assert.equal((await s.call('/api/v1/ai/command', s.tokens.kitchen, { text: 'x', commands: [] })).status, 403);
  assert.equal((await s.call('/api/v1/ai/command', null, { text: 'x', commands: [] })).status, 401);
  await s.stop();
});

test('voice without the cloud answers 503, so the counter says it needs the internet', async () => {
  const s = await start(memoryStore(), undefined, { cloudAi: async () => null });
  const r = await s.call('/api/v1/ai/transcribe', s.tokens.counter, {});
  assert.equal(r.status, 503);
  assert.equal(((await r.json()) as { error: string }).error, 'unavailable');
  const none = await start();
  assert.equal((await none.call('/api/v1/ai/command', none.tokens.counter, {})).status, 503);
  await s.stop();
  await none.stop();
});
