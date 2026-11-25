import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { CampaignEvent } from '../../src/domain/campaigns.ts';
import type { ModuleEvent } from '../../src/domain/modules.ts';
import type { SyncEvent } from '../../src/domain/sync.ts';
import { createApp } from '../app.ts';
import { memoryStore } from '../store.ts';
import { AUTOMATIC, startCrmJobs } from './jobs.ts';
import { crmApi } from './routes.ts';
import { memoryCustomers, type PushSub } from './store.ts';
import { newVapidJson, vapidFromJson } from './webpush.ts';

const DAY = 86_400_000;
/** 11 Nov 2026, 11:00 in Thalwila: inside the automatic message's hours. */
const T0 = Date.UTC(2026, 10, 11, 5, 30);
const SHOP = 'cheesybeez-thalwila-a1b2';

const b64u = (b: ArrayBuffer) => Buffer.from(new Uint8Array(b)).toString('base64url');
/** A phone that allowed notifications: real keys, so the message really is encrypted to it. */
const phoneSub = async (n: number): Promise<PushSub> => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  return { endpoint: `https://fcm.googleapis.com/fcm/send/phone-${n}`, keys: { p256dh: b64u(await crypto.subtle.exportKey('raw', pair.publicKey)), auth: b64u(crypto.getRandomValues(new Uint8Array(16)).buffer) } };
};

async function shop() {
  const clock = { now: T0 };
  const store = memoryStore();
  const customers = memoryCustomers();
  const vapid = vapidFromJson(await newVapidJson());
  /** The push service: what it was given, and what it answers per phone. */
  const pushed: string[] = [];
  const answers = new Map<string, number>();
  const pushService = (async (url: string | URL | Request) => {
    pushed.push(String(url));
    return new Response(null, { status: answers.get(String(url)) ?? 201 });
  }) as typeof fetch;
  let server: ReturnType<typeof createApp> | null = null;
  const crm = crmApi({ events: store, customers, vapid: () => vapid, ingest: (d, e) => server!.ingest(d, e), fetch: pushService, now: () => clock.now });
  server = createApp({ store, crm, now: () => clock.now });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/crm`;
  const counter = await store.addDevice(SHOP, 'CheesyBeez', 'counter');
  const owner = await store.addStaff(SHOP, 'Owner', 'owner', '1234');
  const manager = await store.addStaff(SHOP, 'Mala', 'manager', '2222');
  const cashier = await store.addStaff(SHOP, 'Nimal', 'cashier', '1111');
  for (const p of [owner, manager, cashier]) await store.startSession(counter.device, p, T0 - DAY, T0 + 400 * DAY);
  await server.ingest(counter.device, [{
    id: 'crm-on', shopId: SHOP, at: T0 - DAY, orderNumber: 0, actor: { id: 'developers', name: 'Developers', role: 'owner' },
    type: 'shop.module_set', module: 'crm', on: true, codeId: '0123456789abcdef',
  } satisfies ModuleEvent]);

  const post = async (path: string, staff: string, body: unknown) => {
    const r = await fetch(`${base}${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${counter.token}`, 'x-staff-id': staff, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };
  const get = async (path: string, staff: string) => {
    const r = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${counter.token}`, 'x-staff-id': staff } });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };
  /** A paid sale for a customer, as the Register records it. */
  let n = 1000;
  const sale = async (customerId: string, at: number, total = 290000) => {
    n++;
    await server!.ingest(counter.device, [{
      id: `paid-${n}`, shopId: SHOP, at, orderNumber: n, actor: { id: cashier.id, name: 'Nimal', role: 'cashier' },
      type: 'order.paid', total, tender: 'cash', tendered: total, customerId,
    } as SyncEvent]);
  };
  const recorded = async () => (await store.pull(SHOP, 0, 500)).map((r) => r.event).filter((e): e is CampaignEvent => e.type.startsWith('crm.'));
  const stop = () => new Promise<void>((r) => server!.close(() => r()));
  return { clock, store, customers, crm, post, get, sale, recorded, stop, pushed, answers, owner, manager, cashier, counter };
}

test('at Charge: anyone at the counter finds a customer by number; a new number becomes a customer only when paid', async () => {
  const s = await shop();
  assert.deepEqual((await s.post('/lookup', s.cashier.id, { phone: '077 000 0001' })).body, { customer: null });
  assert.equal((await s.customers.list(SHOP)).length, 0, 'looking makes nobody');
  const made = await s.post('/ensure', s.cashier.id, { phone: '0770000001' });
  assert.equal(made.body.created, true);
  const id = (made.body.customer as { id: string }).id;
  assert.match(id, /^cus-[0-9a-f]{16}$/);
  const again = await s.post('/ensure', s.cashier.id, { phone: '+94 77 000 0001' });
  assert.deepEqual(again.body, { customer: { id, name: null, nickname: null }, created: false }, 'the same number, written another way');
  assert.deepEqual((await s.post('/lookup', s.cashier.id, { phone: '770000001' })).body, { customer: { id, name: null, nickname: null } });
  assert.equal((await s.post('/lookup', s.cashier.id, { phone: '011 234 5678' })).status, 400, 'a landline');
  // The full name at the counter, so two Kasuns are told apart (owner, 2026-11-25).
  await s.customers.importRows(SHOP, [{ row: 2, kind: 'fill_name', phone: '+94770000001', name: 'Kasun Perera', id, notes: [] }], { id: 'x', name: 'x', role: 'owner' }, T0);
  assert.deepEqual((await s.post('/lookup', s.cashier.id, { phone: '0770000001' })).body, { customer: { id, name: 'Kasun Perera', nickname: null } });
  // A name typed instead of the number: the full name, the nickname and the last 3 digits.
  assert.deepEqual((await s.post('/search', s.cashier.id, { q: 'kas per' })).body, { matches: [{ id, name: 'Kasun Perera', nickname: null, ends: '001' }] });
  // A manager gives him a nickname: the counter finds him by it and sees it beside his name; the cashier cannot give one.
  assert.equal((await s.post('/customers/edit', s.cashier.id, { id, phone: '0770000001', name: 'Kasun Perera', nickname: 'Malli' })).status, 403);
  const nicked = await s.post('/customers/edit', s.manager.id, { id, phone: '0770000001', name: 'Kasun Perera', nickname: '  Malli ' });
  assert.equal((nicked.body.customer as { nickname: string }).nickname, 'Malli');
  assert.equal((nicked.body.before as { nickname: null }).nickname, null, 'before, for Undo');
  assert.deepEqual((await s.post('/search', s.cashier.id, { q: 'mal' })).body, { matches: [{ id, name: 'Kasun Perera', nickname: 'Malli', ends: '001' }] });
  assert.deepEqual((await s.post('/lookup', s.cashier.id, { phone: '0770000001' })).body, { customer: { id, name: 'Kasun Perera', nickname: 'Malli' } });
  await s.post('/customers/edit', s.manager.id, { id, phone: '0770000001', name: 'Kasun Perera' });
  assert.equal((await s.customers.byPhone(SHOP, '+94770000001'))?.nickname, 'Malli', 'left out: unchanged');
  await s.post('/customers/edit', s.manager.id, { id, phone: '0770000001', name: 'Kasun Perera', nickname: '' });
  assert.equal((await s.customers.byPhone(SHOP, '+94770000001'))?.nickname, null, 'emptied: none');
  assert.deepEqual((await s.post('/search', s.cashier.id, { q: 'k' })).body, { matches: [] });
  // A name given at the counter is kept for someone new, never over a name the list already has.
  const named = await s.post('/ensure', s.cashier.id, { phone: '0770000002', name: '  Dilani   Silva ' });
  assert.deepEqual((named.body.customer as { name: string }).name, 'Dilani Silva');
  assert.equal((await s.customers.byPhone(SHOP, '+94770000002'))?.name, 'Dilani Silva');
  assert.equal(((await s.post('/ensure', s.cashier.id, { phone: '0770000001', name: 'Someone Else' })).body.customer as { name: string }).name, 'Kasun Perera');
  assert.equal((await s.customers.byPhone(SHOP, '+94770000001'))?.name, 'Kasun Perera');
  assert.equal(((await s.post('/ensure', s.cashier.id, { phone: '0770000003', name: '---' })).body.customer as { name: null }).name, null, 'no letters: no name');
  // + New at the counter: a nickname too, kept for someone who has none, never over one they have.
  const newNick = await s.post('/ensure', s.cashier.id, { phone: '0770000006', name: 'Amali Fernando', nickname: ' Ami ' });
  assert.deepEqual((newNick.body.customer as { name: string; nickname: string }), { id: (newNick.body.customer as { id: string }).id, name: 'Amali Fernando', nickname: 'Ami' });
  await s.post('/ensure', s.cashier.id, { phone: '0770000006', nickname: 'Someone' });
  assert.equal((await s.customers.byPhone(SHOP, '+94770000006'))?.nickname, 'Ami');
  // An online order from a signed-in customer (cheesybeez.com account) comes from the app; anything else is the counter's.
  await s.post('/ensure', s.cashier.id, { phone: '0770000004', name: 'Ama', source: 'app' });
  await s.post('/ensure', s.cashier.id, { phone: '0770000005', source: 'web-hack' });
  assert.deepEqual([(await s.customers.byPhone(SHOP, '+94770000004'))?.source, (await s.customers.byPhone(SHOP, '+94770000005'))?.source], ['app', 'pos']);
  // The list is for managers and the owner.
  assert.equal((await s.get('/customers', s.cashier.id)).status, 403);
  const list = await s.get('/customers', s.manager.id);
  assert.equal((list.body.customers as unknown[]).length, 6);
  assert.equal((await s.get('/customers', s.manager.id)).body.withApp instanceof Array, true);
  await s.stop();
});

test('opt-out: a manager records it; campaigns leave the customer out from then on', async () => {
  const s = await shop();
  const { customer } = await s.customers.ensure(SHOP, '+94770000001', 'app', 'app', T0);
  await s.customers.addSub(SHOP, customer.id, await phoneSub(1), T0);
  assert.deepEqual((await s.post('/campaigns/reach', s.owner.id, { audience: 'all' })).body, { customers: 1, reachable: 1 });
  assert.equal((await s.post('/customers/opt-out', s.cashier.id, { id: customer.id, optedOut: true })).status, 403);
  assert.deepEqual((await s.post('/customers/opt-out', s.manager.id, { id: customer.id, optedOut: true })).body, { optedOut: true });
  assert.deepEqual((await s.post('/campaigns/reach', s.owner.id, { audience: 'all' })).body, { customers: 1, reachable: 0 });
  const sent = await s.post('/campaigns/send', s.owner.id, { audience: 'all', title: 'Offer', body: 'Two pizzas, one price.' });
  assert.equal((sent.body.events as CampaignEvent[])[0].type, 'crm.campaign_sent');
  assert.deepEqual(s.pushed, [], 'nothing went to an opted-out customer');
  assert.equal((await s.post('/customers/opt-out', s.manager.id, { id: 'cus-ffffffffffffffff', optedOut: true })).status, 404);
  await s.stop();
});

test('a campaign: the owner only, to a segment, once per customer, counts recorded without names; gone phones are forgotten', async () => {
  const s = await shop();
  const mk = async (phone: string, subs: number) => {
    const { customer } = await s.customers.ensure(SHOP, phone, 'pos', 'x', T0 - 100 * DAY);
    for (let i = 0; i < subs; i++) await s.customers.addSub(SHOP, customer.id, await phoneSub(Number(phone.slice(-2)) * 10 + i), T0);
    return customer.id;
  };
  const regular = await mk('+94770000011', 1); // bought 50 and 5 days ago: Regular
  const vip = await mk('+94770000012', 2); // spent big: VIP, two phones
  const gone = await mk('+94770000013', 1); // last bought 60 days ago: Inactive
  await mk('+94770000014', 0); // Regular, no app
  await s.sale(regular, T0 - 50 * DAY); await s.sale(regular, T0 - 5 * DAY);
  await s.sale(vip, T0 - 3 * DAY, 2_000_000);
  await s.sale(gone, T0 - 60 * DAY);
  await s.sale('cus-' + '0'.repeat(14) + '14', T0 - 1); // a sale for someone not on the list: harmless

  assert.equal((await s.post('/campaigns/reach', s.manager.id, { audience: 'all' })).status, 403, "campaigns are the owner's");
  assert.deepEqual((await s.post('/campaigns/reach', s.owner.id, { audience: 'vip' })).body, { customers: 1, reachable: 1 });
  assert.equal((await s.post('/campaigns/send', s.owner.id, { audience: 'vip', title: '', body: 'x' })).status, 400);
  assert.match(String((await s.post('/campaigns/send', s.owner.id, { audience: 'vip', title: 'Hi', body: '<script>' })).body.message), /< and >/);

  s.answers.set('https://fcm.googleapis.com/fcm/send/phone-121', 410); // one of the VIP's phones was uninstalled
  const sent = await s.post('/campaigns/send', s.owner.id, { audience: 'vip', title: 'Thank you', body: 'A free garlic bread with your next pizza.' });
  const event = (sent.body.events as CampaignEvent[])[0] as Extract<CampaignEvent, { type: 'crm.campaign_sent' }>;
  assert.deepEqual({ audience: event.audience, kind: event.kind, customers: event.customers, reachable: event.reachable, delivered: event.delivered, failed: event.failed },
    { audience: 'vip', kind: 'campaign', customers: 1, reachable: 1, delivered: 1, failed: 0 });
  assert.equal(s.pushed.length, 2, 'both of the VIP\'s phones were tried');
  assert.equal((await s.customers.subs(SHOP)).filter((x) => x.customerId === vip).length, 1, 'the uninstalled phone is forgotten');
  assert.ok(!JSON.stringify(event).includes('+9477'), 'no number in the record');
  assert.equal((await s.recorded()).length, 1, 'recorded once, synced like any event');

  // A test to the owner's own number (it must have the app).
  assert.match(String((await s.post('/campaigns/send', s.owner.id, { audience: 'test', title: 'T', body: 'T', testPhone: '0770000099' })).body.message), /not signed up/);
  const test1 = await s.post('/campaigns/send', s.owner.id, { audience: 'test', title: 'T', body: 'T', testPhone: '0770000011' });
  assert.equal(((test1.body.events as CampaignEvent[])[0] as { delivered: number }).delivered, 1);
  await s.stop();
});

test('campaign results: who it reached and came in within a week, beside those it could not reach; counts only, managers too', async () => {
  const s = await shop();
  const mk = async (phone: string, app: boolean) => {
    const { customer } = await s.customers.ensure(SHOP, phone, 'pos', 'x', T0 - 100 * DAY);
    if (app) await s.customers.addSub(SHOP, customer.id, await phoneSub(Number(phone.slice(-2))), T0);
    await s.sale(customer.id, T0 - 60 * DAY); // all Inactive when the offer goes out
    return customer.id;
  };
  const back = await mk('+94770000021', true); // reached, came back
  await mk('+94770000022', true); // reached, did not
  const anyway = await mk('+94770000023', false); // no app, came anyway
  await mk('+94770000024', false); // no app, did not

  const sent = await s.post('/campaigns/send', s.owner.id, { audience: 'inactive', title: 'We kept your table', body: 'A free drink with any pizza this week.' });
  const id = (sent.body.events as CampaignEvent[])[0].id;
  s.clock.now = T0 + 2 * DAY;
  await s.sale(back, T0 + DAY, 350000);
  await s.sale(back, T0 + 2 * DAY - 1, 150000);
  await s.sale(anyway, T0 + DAY, 90000);
  // A test to the owner's number has no result: it is not a campaign to anyone.
  await s.post('/campaigns/send', s.owner.id, { audience: 'test', title: 'Test', body: 'Just me.', testPhone: '077 000 0021' });

  assert.equal((await s.post('/campaigns/results', s.cashier.id, {})).status, 403);
  const mid = (await s.post('/campaigns/results', s.manager.id, {})).body.results as Record<string, unknown>;
  assert.deepEqual(Object.keys(mid), [id]);
  assert.deepEqual(mid[id], { reached: 2, cameIn: 1, spent: 500000, compared: 2, comparedCameIn: 1, final: false });
  assert.deepEqual(await s.crm.push!.writeResults(s.counter.device, AUTOMATIC), [], 'no result while its week is still running');
  s.clock.now = T0 + 10 * DAY;
  await s.sale(back, T0 + 9 * DAY, 999999); // after the week: not the campaign
  const end = (await s.post('/campaigns/results', s.owner.id, {})).body.results as Record<string, { spent: number; final: boolean }>;
  assert.equal(end[id].spent, 500000);
  assert.equal(end[id].final, true);
  // The week is over: the shop server writes the result once, counts only, for Today and the phone.
  const written = await s.crm.push!.writeResults(s.counter.device, AUTOMATIC);
  assert.deepEqual(written.map((e) => ({ ...e, id: undefined, at: undefined, actor: undefined })), [{
    id: undefined, at: undefined, actor: undefined, shopId: SHOP, orderNumber: 0, type: 'crm.campaign_result',
    campaignId: id, reached: 2, cameIn: 1, spent: 500000, compared: 2, comparedCameIn: 1,
  }]);
  assert.equal((await s.recorded()).filter((e) => e.type === 'crm.campaign_result').length, 1, "it went through the shop server's checks");
  assert.deepEqual(await s.crm.push!.writeResults(s.counter.device, AUTOMATIC), [], 'once only');
  assert.doesNotMatch(JSON.stringify(written), /cus-|\+94/);
  // Erased: gone from the results too (the send log goes with the customer).
  await s.customers.remove(SHOP, back);
  const after = (await s.post('/campaigns/results', s.owner.id, {})).body.results as Record<string, { reached: number; cameIn: number }>;
  assert.deepEqual([after[id].reached, after[id].cameIn], [1, 0]);
  await s.stop();
});

test('the receipt\'s words above the QR code: the owner\'s, recorded by the shop server as one event; checked for the printer', async () => {
  const s = await shop();
  assert.equal((await s.post('/campaigns/receipt', s.manager.id, { headline: 'Scan for offers', line: '' })).status, 403);
  assert.match(String((await s.post('/campaigns/receipt', s.owner.id, { headline: 'වට්ටම්', line: '' })).body.message), /English/);
  const ok = await s.post('/campaigns/receipt', s.owner.id, { headline: '  Scan for 10% off  ', line: 'Your next pizza' });
  assert.equal(ok.status, 200);
  const stored = (await s.recorded()).filter((e) => e.type === 'crm.receipt_set');
  assert.equal(stored.length, 1);
  assert.deepEqual([stored[0].headline, stored[0].line, stored[0].actor.id], ['Scan for 10% off', 'Your next pizza', s.owner.id]);
  await s.stop();
});

test('"we miss you": off until the owner turns it on; then once per quiet spell, 10:00-19:59, only to those who just went quiet', async () => {
  const s = await shop();
  const mk = async (phone: string, lastVisitDaysAgo: number) => {
    const { customer } = await s.customers.ensure(SHOP, phone, 'pos', 'x', T0 - 200 * DAY);
    await s.customers.addSub(SHOP, customer.id, await phoneSub(Number(phone.slice(-2))), T0);
    await s.sale(customer.id, T0 - lastVisitDaysAgo * DAY);
    return customer.id;
  };
  await mk('+94770000021', 31); // just went quiet
  await mk('+94770000022', 90); // long gone: not this message
  await mk('+94770000023', 5); // still coming
  const { customer: never } = await s.customers.ensure(SHOP, '+94770000024', 'import', 'x', T0);
  await s.customers.addSub(SHOP, never.id, await phoneSub(24), T0); // never bought: no "we miss you"
  const device = s.counter.device;
  const auto = { id: 'auto', name: 'Automatic message', role: 'owner' as const };

  assert.equal(await s.crm.push!.winback(device, auto), null, 'off by default');
  assert.equal((await s.post('/campaigns/auto', s.manager.id, { on: true, title: 'We miss you', body: 'Come back' })).status, 403);
  await s.post('/campaigns/auto', s.owner.id, { on: true, title: 'We miss you', body: 'Come by this week.' });

  s.clock.now = T0 - 3 * 3_600_000; // 08:00 in Thalwila: too early
  assert.equal(await s.crm.push!.winback(device, auto), null);
  s.clock.now = T0;
  const first = await s.crm.push!.winback(device, auto) as Extract<CampaignEvent, { type: 'crm.campaign_sent' }>;
  assert.deepEqual({ kind: first.kind, reachable: first.reachable, delivered: first.delivered }, { kind: 'auto', reachable: 1, delivered: 1 });
  assert.deepEqual(s.pushed, ['https://fcm.googleapis.com/fcm/send/phone-21']);
  s.clock.now = T0 + 3_600_000;
  assert.equal(await s.crm.push!.winback(device, auto), null, 'once per quiet spell');
  assert.equal(s.pushed.length, 1);
  await s.stop();
});

test('sign-ups from the app arrive through the cloud: the customer is found or made, the phone kept; a stop forgets it', async () => {
  const s = await shop();
  const sub = await phoneSub(31);
  const cloud: { rows: unknown[]; acked: string[]; key: string | null } = {
    rows: [
      { id: 'r1', kind: 'subscribe', phone: '077 000 0031', subscription: sub },
      { id: 'r2', kind: 'subscribe', phone: 'not a number', subscription: sub },
    ],
    acked: [], key: null,
  };
  const cloudFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/api/v1/push/key')) { cloud.key = JSON.parse(String(init?.body)).key; return Response.json({ ok: true }); }
    if (u.endsWith('/api/v1/push/inbox')) return Response.json({ rows: cloud.rows });
    if (u.endsWith('/api/v1/push/inbox/ack')) { cloud.acked.push(...JSON.parse(String(init?.body)).ids); cloud.rows = []; return Response.json({ ok: true }); }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const jobs = startCrmJobs({
    crm: s.crm, tenantId: () => SHOP, device: async () => s.counter.device, cloud: () => ({ url: 'https://cloud.test', token: 't' }),
    publicKey: async () => 'the-public-key', fetch: cloudFetch, inboxEveryMs: 3_600_000, winbackEveryMs: 3_600_000,
  });
  await jobs.inbox();
  assert.equal(cloud.key, 'the-public-key', 'the app gets this shop\'s key through the cloud');
  assert.deepEqual(cloud.acked, ['r1', 'r2'], 'even a row it could not use is taken off the cloud');
  const [c] = await s.customers.list(SHOP);
  assert.deepEqual({ phone: c.phone, source: c.source }, { phone: '+94770000031', source: 'app' });
  assert.equal((await s.customers.subs(SHOP)).length, 1);

  cloud.rows = [{ id: 'r3', kind: 'unsubscribe', endpoint: sub.endpoint }];
  await jobs.inbox();
  assert.equal((await s.customers.subs(SHOP)).length, 0, 'the phone said stop');
  jobs.stop();
  await s.stop();
});

test('by hand: managers and the owner add a customer; only the owner removes one, and Undo puts them back as they were', async () => {
  const s = await shop();
  assert.equal((await s.post('/customers/add', s.cashier.id, { phone: '0770000056', name: 'Test' })).status, 403, 'not a cashier');
  const added = await s.post('/customers/add', s.manager.id, { phone: '077 000 0056', name: '  Test   customer ' });
  const c = added.body.customer as { id: string; phone: string; name: string; source: string };
  assert.deepEqual([c.phone, c.name, c.source], ['+94770000056', 'Test customer', 'manual']);
  assert.match(String((await s.post('/customers/add', s.owner.id, { phone: '0770000056' })).body.message), /already on the list as Test customer/);
  assert.equal((await s.post('/customers/add', s.owner.id, { phone: '011 234 5678' })).status, 400);
  const noName = await s.post('/customers/add', s.owner.id, { phone: '0770000077' });
  assert.equal((noName.body.customer as { name: string | null }).name, null);

  // A sale and a phone for them, then the owner removes them.
  await s.sale(c.id, T0 - DAY);
  await s.customers.addSub(SHOP, c.id, await phoneSub(56), T0);
  assert.equal((await s.post('/customers/remove', s.manager.id, { id: c.id })).status, 403, "removing is the owner's");
  const removed = await s.post('/customers/remove', s.owner.id, { id: c.id });
  assert.equal((removed.body.removed as { name: string }).name, 'Test customer');
  assert.equal(await s.customers.byPhone(SHOP, '+94770000056'), null);
  assert.equal((await s.customers.subs(SHOP)).length, 0, 'the phone that signed up goes with them');
  assert.equal((await s.post('/customers/remove', s.owner.id, { id: c.id })).status, 404);

  // Undo: the same id, so the sale before is theirs again.
  const back = await s.post('/customers/restore', s.owner.id, { customer: removed.body.removed });
  assert.equal((back.body.customer as { id: string }).id, c.id);
  assert.equal((await s.customers.byPhone(SHOP, '+94770000056'))?.name, 'Test customer');
  assert.equal((await s.post('/customers/restore', s.owner.id, { customer: removed.body.removed })).status, 409, 'not twice');
  assert.equal((await s.post('/customers/restore', s.owner.id, { customer: { id: 'x' } })).status, 400);
  await s.stop();
});

test('Gone quiet: regulars away twice their usual gap get their own campaign; every reach at once; a customer\'s last offer', async () => {
  const s = await shop();
  const mk = async (phone: string, days: number[]) => {
    const { customer } = await s.customers.ensure(SHOP, phone, 'pos', 'x', T0 - 100 * DAY);
    await s.customers.addSub(SHOP, customer.id, await phoneSub(Number(phone.slice(-2))), T0);
    for (const d of days) await s.sale(customer.id, T0 - d * DAY);
    return customer.id;
  };
  const quiet = await mk('+94770000031', [40, 35, 30, 25, 20]); // every 5 days, away 20
  await mk('+94770000032', [30, 20, 3]); // came 3 days ago

  const all = (await s.post('/campaigns/reach-all', s.owner.id, {})).body.reach as Record<string, { customers: number; reachable: number }>;
  assert.deepEqual(all.quiet, { customers: 1, reachable: 1 });
  assert.deepEqual(all.all, { customers: 2, reachable: 2 });
  assert.equal('test' in all, false);
  assert.equal((await s.post('/campaigns/reach-all', s.manager.id, {})).status, 403);

  assert.equal((await s.post('/customers/messages', s.manager.id, { id: quiet })).body.last, null, 'nothing sent yet');
  const sent = await s.post('/campaigns/send', s.owner.id, { audience: 'quiet', title: 'Your Friday pizza?', body: 'Garlic bread on us this week.' });
  assert.equal(((sent.body.events as CampaignEvent[])[0] as { audience: string; delivered: number }).delivered, 1);
  s.clock.now = T0 + 3 * DAY;
  await s.sale(quiet, T0 + 2 * DAY);
  assert.deepEqual((await s.post('/customers/messages', s.manager.id, { id: quiet })).body.last, { title: 'Your Friday pizza?', at: T0, cameAt: T0 + 2 * DAY });
  assert.equal((await s.post('/customers/messages', s.cashier.id, { id: quiet })).status, 403);
  await s.stop();
});
