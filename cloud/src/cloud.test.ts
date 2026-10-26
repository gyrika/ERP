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
  const handle = createCloud(d1, { now: () => 9000, enrolCode: 'CB-7K3M-Q9XZ' });
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

test("tables and cameras (SCRUM-172): the shop's copy carries them, and the owner's phone reads them back", async () => {
  const { call } = await setup();
  const owner = { id: 'o', name: 'Anton', role: 'owner' };
  const cameras = { id: 'vision', name: 'Cameras', role: 'vision' };
  const row = (seq: number, event: object): SyncedEvent =>
    ({ seq, deviceId: 'dev-server', receivedAt: 1000 + seq, event: { id: `v${seq}`, shopId: SHOP, at: 500 + seq, orderNumber: 0, ...event } as SyncEvent });
  const rows = [
    row(1, { type: 'table.layout_set', actor: owner, tables: [{ id: 't1', label: '1', seats: 4 }] }),
    row(2, { type: 'vision.cameras_set', actor: owner, cameras: [{ id: 'c1', name: 'Front', ip: '192.168.1.21', rtspPath: '/stream1', enabled: true }] }),
    row(3, { type: 'table.state_changed', actor: cameras, tableId: 't1', from: 'free', to: 'occupied', confidence: 0.9 }),
    row(4, { type: 'vision.camera_offline', actor: cameras, cameraId: 'c1' }),
    row(5, { type: 'vision.heartbeat', actor: cameras, cameras: [{ id: 'c1', online: true, fps: 5 }], cpu: 31 }),
  ];
  assert.equal((await (await call('/api/v1/replica', 'server-a', { events: rows })).json()).stored, 5);
  const pulled = await (await call('/api/v1/events?after=0', 'owner-a')).json();
  assert.deepEqual(pulled.events.map((e: SyncedEvent) => e.event), rows.map((r) => r.event));
  // The same shape checks as the shop server: a camera event carrying a password is refused whole.
  const leaky = row(6, { type: 'vision.camera_online', actor: cameras, cameraId: 'c1', password: 'x' });
  assert.equal((await call('/api/v1/replica', 'server-a', { events: [leaky] })).status, 400);
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

test('a new shop registers itself with the shop code, and only with it', async () => {
  const { call } = await setup();
  const enrol = (code: string, shopId = 'shop-new-ab12') => call('/api/v1/enrol', null, { code, shopId, name: 'CheesyBeez Thalwila' });
  assert.equal((await enrol('WRONG-CODE')).status, 403);
  assert.equal((await enrol('')).status, 403);
  assert.equal((await enrol('cb-7k3m-q9xz', 'Bad Id!')).status, 400);
  const ok = await enrol(' cb-7k3m-q9xz '); // typed in lower case, with spaces: still right
  assert.equal(ok.status, 200);
  const { token } = await ok.json();
  const state = await (await call('/api/v1/replica', token)).json();
  assert.equal(state.lastSourceSeq, 0, 'the new shop server can copy its events in');
  const pushed = await (await call('/api/v1/replica', token, { events: [synced('n1', 1, 'shop-new-ab12')] })).json();
  assert.equal(pushed.stored, 1);
});

test("the owner's app description carries this phone's key, and nothing else", async () => {
  const { ownerManifest, orderManifest } = await import('./worker.ts');
  const key = 'A'.repeat(43);
  assert.equal(ownerManifest(key).start_url, `/?owner=${key}#owner`, "an iPhone home-screen app has its own storage: the key opens it");
  assert.equal(ownerManifest(null).start_url, '/#owner');
  assert.equal(ownerManifest('"><script>').start_url, '/#owner', 'anything that is not a key is ignored');
  assert.equal(ownerManifest(key).display, 'standalone');
  assert.ok(ownerManifest(key).icons.some((i) => i.purpose === 'maskable'));
  assert.equal(orderManifest(true).start_url, '/');
  assert.equal(orderManifest(true).scope, '/');
  assert.equal(orderManifest(false).start_url, '/order');
  assert.equal(orderManifest(false).scope, '/order');
  assert.equal(orderManifest(true).display, 'standalone');
  assert.ok(orderManifest(true).icons.some((i) => i.purpose === 'maskable'));
});

test('customer and owner apps have separate home-screen scopes', async () => {
  const { default: worker } = await import('./worker.ts');
  const { d1 } = fakeD1();
  const env = { DB: d1, ASSETS: { fetch: async () => new Response('asset') } };
  const customer = await worker.fetch(new Request('https://cheesybeez.com/order.webmanifest'), env);
  assert.equal(customer.status, 200);
  assert.equal(customer.headers.get('content-type'), 'application/manifest+json');
  assert.equal((await customer.json()).start_url, '/');

  const cloud = await worker.fetch(new Request('https://cheesybeez-cloud.workers.dev/order.webmanifest'), env);
  const cloudManifest = await cloud.json();
  assert.equal(cloudManifest.start_url, '/order');
  assert.equal(cloudManifest.scope, '/order', 'the customer app must not replace the owner app at /');
});

test("the owner's questions: only with the link's key; every save kept, the newest returned", async () => {
  const { answersApi, questionsPage } = await import('./questions.ts');
  const { d1, db } = fakeD1();
  let t = 1000;
  const ask = (key: string, method = 'GET', body?: unknown) => answersApi(new Request('https://cloud.test/api/v1/answers', {
    method, headers: { 'x-answer-key': key }, body: body === undefined ? undefined : JSON.stringify(body),
  }), d1, 'right-key', () => t++);
  assert.equal((await ask('wrong')).status, 401);
  assert.deepEqual(await (await ask('right-key')).json(), { savedAt: null, answers: {} });
  assert.equal((await ask('right-key', 'POST', { answers: { tuna: '40 g / 60 g' } })).status, 200);
  assert.equal((await ask('right-key', 'POST', { answers: { tuna: '45 g / 60 g', notes: 'hello' } })).status, 200);
  assert.deepEqual(await (await ask('right-key')).json(), { savedAt: 1001, answers: { tuna: '45 g / 60 g', notes: 'hello' } });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM owner_answers').get() as { n: number }).n, 2, 'the first answer is kept as history');
  assert.equal((await ask('right-key', 'POST', { answers: { tuna: 45 } })).status, 400, 'answers are text');
  assert.equal((await ask('wrong', 'POST', { answers: {} })).status, 401);
  const page = questionsPage();
  assert.ok(page.includes('id="sauceYield"') && page.includes('name="pastaRecipe" value="Chicken Alfredo, penne"'));
  assert.ok(page.includes('no more questions'));
});

test('the download page: always the newest installer, and a plain fallback if GitHub is away', async () => {
  const { downloadPage, latestRelease } = await import('./download.ts');
  const github = (async () => Response.json({ tag_name: 'v1.0.2', assets: [
    { name: 'notes.txt', size: 1, browser_download_url: 'https://x/notes.txt' },
    { name: 'CheesyBeez-Setup-1.0.2.exe', size: 25_931_228, browser_download_url: 'https://github.com/gyrika/ERP/releases/download/v1.0.2/CheesyBeez-Setup-1.0.2.exe' },
  ] })) as unknown as typeof fetch;
  const rel = await latestRelease(github);
  assert.deepEqual(rel, { version: '1.0.2', url: 'https://github.com/gyrika/ERP/releases/download/v1.0.2/CheesyBeez-Setup-1.0.2.exe', sizeMb: 25 });
  const page = downloadPage(rel);
  assert.ok(page.includes('href="https://github.com/gyrika/ERP/releases/download/v1.0.2/CheesyBeez-Setup-1.0.2.exe"'));
  assert.ok(page.includes('25 MB · version 1.0.2'));
  assert.equal(await latestRelease((async () => new Response('', { status: 503 })) as unknown as typeof fetch), null);
  assert.ok(downloadPage(null).includes('href="https://github.com/gyrika/ERP/releases/latest"'), 'GitHub away: the releases page');
});

test("the shop code only makes new shops: an existing one takes back only its own server", async () => {
  const { call } = await setup();
  const mine = 's'.repeat(43);
  const enrol = (shopId: string, secret?: string) => call('/api/v1/enrol', null, { code: 'CB-7K3M-Q9XZ', shopId, name: 'X', secret });
  // Someone with the shop code and a shop's id: no key to that shop, with or without a secret.
  assert.equal((await enrol(SHOP)).status, 409);
  assert.equal((await enrol(SHOP, mine)).status, 409, 'a shop from before secrets: nobody gets back in');

  const first = await (await enrol('shop-new-ab12', mine)).json();
  assert.equal((await enrol('shop-new-ab12')).status, 409, 'the code alone');
  assert.equal((await enrol('shop-new-ab12', 'x'.repeat(43))).status, 409, 'someone else\'s secret');
  // The real server again (its first answer was lost): a fresh key, and the old one stops working.
  const again = await enrol('shop-new-ab12', mine);
  assert.equal(again.status, 200);
  const { token } = await again.json();
  assert.equal((await call('/api/v1/replica', token)).status, 200);
  assert.equal((await call('/api/v1/replica', first.token)).status, 401);
  assert.equal((await call('/api/v1/replica', 'server-a')).status, 200, 'other shops untouched');
});

test('the sales ledger: each payment a row with its items, an Undo marks it, each shop apart, catches up after a gap', async () => {
  const { call, db } = await setup();
  const actor = { id: 'n', name: 'Nimal', role: 'cashier' };
  const pizza = { id: 'l1', itemId: 'devilled-chicken', qty: 1, size: 'L', adds: [], outs: ['no-onion'], sent: true, unit: 250000 };
  const burger = { id: 'l2', itemId: 'chicken-burger', qty: 2, adds: [], outs: [], sent: true, unit: 45000 };
  let seq = 0;
  const row = (e: object, shopId = SHOP): SyncedEvent => {
    seq++;
    return { seq, deviceId: 'dev-counter', receivedAt: seq, event: { shopId, at: Date.UTC(2026, 9, 14, 13, 0) + seq, actor, orderNumber: 1001, ...e } as SyncEvent };
  };
  const sent = (id: string, lines: object[], shopId?: string) => row({ id, type: 'order.sent', ticketId: `t-${id}`, lines, addOn: false }, shopId);
  const paid = (id: string, total: number, shopId?: string) => row({ id, type: 'order.paid', total, tender: 'cash', tendered: 500000 }, shopId);
  const sales = () => db.prepare('SELECT id, tenant_id, order_number, sale_date, items_count, subtotal, total, change_given, status FROM sales ORDER BY event_seq').all();

  await call('/api/v1/replica', 'server-a', { events: [sent('s1', [pizza]), sent('s2', [burger]), paid('p1', 340000)] });
  assert.deepEqual(sales().map((s) => ({ ...s })), [
    { id: 'p1', tenant_id: SHOP, order_number: 1001, sale_date: '2026-10-14', items_count: 3, subtotal: 340000, total: 340000, change_given: 160000, status: 'paid' },
  ]);
  assert.deepEqual(db.prepare('SELECT item_name, size, qty, line_total, left_out FROM sale_items WHERE sale_id = ? ORDER BY line_no').all('p1').map((r) => ({ ...r })), [
    { item_name: 'Devilled Chicken', size: 'Large', qty: 1, line_total: 250000, left_out: 'No onion' },
    { item_name: 'Chicken Burger', size: null, qty: 2, line_total: 90000, left_out: null },
  ]);

  // The cashier undoes the payment and takes it again; then number 1001 comes round again with a new order.
  await call('/api/v1/replica', 'server-a', { events: [row({ id: 'u1', type: 'order.payment_undone' }), paid('p2', 340000), sent('s3', [burger]), paid('p3', 90000)] });
  assert.deepEqual(sales().map((s) => [s.id, s.status, s.items_count]), [['p1', 'undone', 3], ['p2', 'paid', 3], ['p3', 'paid', 2]]);

  // Another shop's sales stay its own; a repeat copy files nothing twice.
  await call('/api/v1/replica', 'server-b', { events: [sent('b1', [burger], 'shop-b'), paid('b2', 90000, 'shop-b')] });
  await call('/api/v1/replica', 'server-a', { events: [paid('p3', 90000)] });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sales WHERE tenant_id = 'shop-b'").get()?.n, 1);
  assert.deepEqual({ ...db.prepare("SELECT sales, total_cents, cash_cents FROM daily_sales WHERE tenant_id = ?").get(SHOP) }, { sales: 2, total_cents: 430000, cash_cents: 430000 });

  // A ledger emptied (or a cloud older than it) is rebuilt from the events on the shop's next heartbeat.
  db.exec('DELETE FROM sale_items; DELETE FROM sales; DELETE FROM sales_cursor;');
  await call('/api/v1/replica', 'server-a');
  assert.deepEqual(sales().filter((s) => s.tenant_id === SHOP).map((s) => [s.id, s.status]), [['p1', 'undone'], ['p2', 'paid'], ['p3', 'paid']]);
});
