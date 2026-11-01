import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCloud, sha256Hex } from './cloud.ts';
import { fakeD1 } from './fakeD1.ts';
import { GPT_CLIENT_ID, isChatGptCallback, ownerKeyFrom, rupees } from './gpt.ts';

// The owner's ChatGPT (SCRUM-197): he approves with his owner link, ChatGPT gets its own tokens,
// they read today's totals for his shop and open nothing else.

const SHOP = 'shop-a';
const OWNER_KEY = 'owner-key-aaaaaaaaaaaaaaaaaaaaaaaa';
const MANAGER_KEY = 'manager-key-aaaaaaaaaaaaaaaaaaaaaa';
const OTHER_KEY = 'owner-key-bbbbbbbbbbbbbbbbbbbbbbbb';
const SECRET = 'client-secret';
const CALLBACK = 'https://chatgpt.com/aip/g-abc123/oauth/callback';
const NOON = Date.UTC(2026, 10, 2, 6, 30); // 12:00 on 2 November in Sri Lanka

async function setup(clientSecret: string | undefined = SECRET) {
  const { d1, db } = fakeD1();
  for (const [tenant, kind, key] of [[SHOP, 'owner', OWNER_KEY], [SHOP, 'manager', MANAGER_KEY], ['shop-b', 'owner', OTHER_KEY]]) {
    db.prepare('INSERT OR IGNORE INTO shops (id, name, created_at) VALUES (?, ?, 0)').run(tenant, tenant);
    db.prepare('INSERT INTO devices (id, tenant_id, kind, token_hash, created_at) VALUES (?, ?, ?, ?, 0)').run(`dev-${key}`, tenant, kind, await sha256Hex(key));
  }
  const clock = { t: NOON };
  const handle = createCloud(d1, { now: () => clock.t, gptClientSecret: clientSecret });
  const form = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) => handle(new Request(`https://cloud.test${path}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields),
  }));
  const get = (path: string, bearer?: string) => handle(new Request(`https://cloud.test${path}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }));
  const approve = (link = `https://cloud.test/?owner=${OWNER_KEY}#owner`, redirect_uri = CALLBACK) =>
    form('/api/v1/gpt/authorize', { client_id: GPT_CLIENT_ID, redirect_uri, state: 'xyz', link });
  const codeFrom = (r: Response) => new URL(r.headers.get('location')!).searchParams.get('code')!;
  const exchange = (code: string, extra: Record<string, string> = {}) => form('/api/v1/gpt/token', {
    grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: GPT_CLIENT_ID, client_secret: SECRET, ...extra,
  });
  const signIn = async (link?: string) => (await (await exchange(codeFrom(await approve(link)))).json()) as { access_token: string; refresh_token: string; expires_in: number };
  const sale = (id: string, tenant: string, total: number, tender: string, status = 'paid', date = '2026-11-02') => {
    db.prepare(`INSERT INTO sales (id, tenant_id, order_number, sale_date, sale_time, paid_at, items_count, subtotal, discount, total,
      tender, tendered, change_given, cashier, online, status, event_seq) VALUES (?, ?, 1, ?, '11:00', 0, 1, ?, 0, ?, ?, ?, 0, 'Secret Cashier', 0, ?, 1)`)
      .run(id, tenant, date, total, total, tender, total, status);
  };
  const item = (saleId: string, tenant: string, name: string, qty: number) => {
    db.prepare(`INSERT INTO sale_items (sale_id, tenant_id, line_no, item_id, item_name, qty, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?, 100, 100)`)
      .run(saleId, tenant, qty, name, name, qty);
  };
  return { db, clock, form, get, approve, codeFrom, exchange, signIn, sale, item };
}

test('off until the secret is set', async () => {
  const { get } = await setup('');
  assert.equal((await get('/api/v1/gpt/openapi.json')).status, 404);
  assert.equal((await get(`/api/v1/gpt/authorize?response_type=code&client_id=${GPT_CLIENT_ID}&redirect_uri=${encodeURIComponent(CALLBACK)}`)).status, 404);
});

test('a code goes only to ChatGPT, and only after the owner link', async () => {
  const { get, approve, codeFrom } = await setup();
  const asked = await get(`/api/v1/gpt/authorize?response_type=code&client_id=${GPT_CLIENT_ID}&state=${encodeURIComponent('"><script>')}&redirect_uri=${encodeURIComponent(CALLBACK)}`);
  assert.equal(asked.status, 200);
  const html = await asked.text();
  assert.ok(!html.includes('<script>'), 'the state is escaped');
  assert.match(asked.headers.get('content-security-policy')!, /frame-ancestors 'none'/);

  for (const bad of ['https://evil.test/aip/g-1/oauth/callback', 'https://chatgpt.com.evil.test/aip/g-1/oauth/callback', 'http://chatgpt.com/aip/g-1/oauth/callback', 'https://chatgpt.com/other']) {
    const r = await approve(undefined, bad);
    assert.equal(r.status, 400, bad);
    assert.equal(r.headers.get('location'), null, 'never redirected');
  }
  for (const link of ['not a link', 'https://cloud.test/?owner=wrong-key-aaaaaaaaaaaaaaaaaaaaaaaa', `https://cloud.test/?manager=${MANAGER_KEY}`, MANAGER_KEY]) {
    const r = await approve(link);
    assert.equal(r.status, 401, link);
    assert.equal(r.headers.get('location'), null);
  }
  const ok = await approve();
  assert.equal(ok.status, 303);
  const back = new URL(ok.headers.get('location')!);
  assert.equal(back.origin + back.pathname, CALLBACK);
  assert.equal(back.searchParams.get('state'), 'xyz');
  assert.ok(codeFrom(ok));
});

test('a code works once, in time, for the right client and address', async () => {
  const { approve, codeFrom, exchange, clock } = await setup();
  assert.equal((await exchange(codeFrom(await approve()), { client_secret: 'wrong' })).status, 401);
  assert.equal((await exchange(codeFrom(await approve()), { redirect_uri: 'https://chatgpt.com/aip/g-other/oauth/callback' })).status, 400);

  const code = codeFrom(await approve());
  const r = await exchange(code);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).token_type, 'bearer');
  assert.equal((await exchange(code)).status, 400, 'not twice');

  const late = codeFrom(await approve());
  clock.t += 5 * 60_000;
  assert.equal((await exchange(late)).status, 400, 'too late');
});

test('credentials also work in a Basic header', async () => {
  const { approve, codeFrom, form } = await setup();
  const r = await form('/api/v1/gpt/token', { grant_type: 'authorization_code', code: codeFrom(await approve()), redirect_uri: CALLBACK },
    { authorization: `Basic ${btoa(`${GPT_CLIENT_ID}:${SECRET}`)}` });
  assert.equal(r.status, 200);
});

test("today: his shop's standing payments, totals and item names only", async () => {
  const { get, signIn, sale, item, db } = await setup();
  sale('s1', SHOP, 480050, 'cash');
  sale('s2', SHOP, 100000, 'transfer');
  sale('s3', SHOP, 5000, 'cash', 'undone');
  sale('s4', SHOP, 7000, 'cash', 'paid', '2026-11-01');
  sale('s5', 'shop-b', 9000, 'cash');
  item('s1', SHOP, 'Devilled Chicken', 3);
  item('s2', SHOP, 'Margherita', 1);
  item('s3', SHOP, 'Undone Pizza', 9);
  item('s5', 'shop-b', 'Other Shop Pizza', 9);
  db.prepare(`INSERT INTO events (tenant_id, id, source_seq, source_device, type, order_number, at, received_at, copied_at, body)
    VALUES (?, 'e1', 1, 'd', 'order.paid', 1, 0, 0, ?, '{}')`).run(SHOP, NOON - 10 * 60_000);

  const { access_token } = await signIn();
  const r = await get('/api/v1/gpt/today', access_token);
  assert.equal(r.status, 200);
  const raw = await r.text();
  assert.deepEqual(JSON.parse(raw), {
    date: '2026-11-02', time_now: '12:00', orders: 2, total: 'Rs 5,800.50', cash: 'Rs 4,800.50', bank_transfer: 'Rs 1,000.00',
    other_payments: 'Rs 0.00', discounts_given: 'Rs 0.00', online_orders: 0,
    top_items: [{ name: 'Devilled Chicken', qty: 3 }, { name: 'Margherita', qty: 1 }],
    last_copied_from_shop: { date: '2026-11-02', time: '11:50', minutes_ago: 10 },
  });
  assert.ok(!raw.includes('Secret Cashier'), 'staff names stay home');
});

test('a day with no sales says so plainly', async () => {
  const { get, signIn } = await setup();
  const body = await (await get('/api/v1/gpt/today', (await signIn()).access_token)).json();
  assert.equal(body.orders, 0);
  assert.equal(body.total, 'Rs 0.00');
  assert.equal(body.last_copied_from_shop, null);
});

test('the token opens these endpoints only', async () => {
  const { get, signIn } = await setup();
  const { access_token } = await signIn();
  assert.equal((await get('/api/v1/gpt/today')).status, 401);
  assert.equal((await get('/api/v1/gpt/today', 'made-up')).status, 401);
  assert.equal((await get('/api/v1/gpt/today', OWNER_KEY)).status, 401, 'the owner key is not a GPT token');
  for (const path of ['/api/v1/events?after=0', '/api/v1/me', '/api/v1/inbox?after=0', '/api/v1/devices']) {
    assert.equal((await get(path, access_token)).status, 401, path);
  }
});

test('the token runs out, refreshes, and dies with the owner device', async () => {
  const { get, form, signIn, clock, db } = await setup();
  const { access_token, refresh_token, expires_in } = await signIn();
  const refresh = (secret = SECRET) => form('/api/v1/gpt/token', { grant_type: 'refresh_token', refresh_token, client_id: GPT_CLIENT_ID, client_secret: secret });

  clock.t += expires_in * 1000;
  assert.equal((await get('/api/v1/gpt/today', access_token)).status, 401, 'expired');
  assert.equal((await refresh('wrong')).status, 401);
  const fresh = await (await refresh()).json();
  assert.equal((await get('/api/v1/gpt/today', fresh.access_token)).status, 200);
  assert.equal((await get('/api/v1/gpt/today', access_token)).status, 401, 'the old one is gone');

  db.prepare('DELETE FROM devices WHERE id = ?').run(`dev-${OWNER_KEY}`);
  assert.equal((await get('/api/v1/gpt/today', fresh.access_token)).status, 401, 'cut off at once');
  assert.equal((await refresh()).status, 400);
});

test('the schema names the one action and carries no secret', async () => {
  const { get } = await setup();
  const raw = await (await get('/api/v1/gpt/openapi.json')).text();
  assert.ok(!raw.includes(SECRET));
  const schema = JSON.parse(raw);
  assert.equal(schema.servers[0].url, 'https://cloud.test');
  assert.equal(schema.paths['/api/v1/gpt/today'].get.operationId, 'getTodaySales');
});

test('helpers', () => {
  assert.equal(rupees(0), 'Rs 0.00');
  assert.equal(rupees(5), 'Rs 0.05');
  assert.equal(rupees(123456789), 'Rs 1,234,567.89');
  assert.equal(ownerKeyFrom(`  ${OWNER_KEY} `), OWNER_KEY);
  assert.equal(ownerKeyFrom(`https://x.test/?owner=${OWNER_KEY}#owner`), OWNER_KEY);
  assert.equal(ownerKeyFrom(`https://x.test/owner.webmanifest?k=${OWNER_KEY}`), OWNER_KEY);
  assert.equal(ownerKeyFrom('hello there'), null);
  assert.ok(isChatGptCallback('https://chat.openai.com/aip/g-1/oauth/callback'));
  assert.ok(!isChatGptCallback('https://chatgpt.com/aip/g-1/oauth/callback?x=1'));
});
