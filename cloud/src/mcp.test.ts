import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCloud, sha256Hex } from './cloud.ts';
import { fakeD1 } from './fakeD1.ts';
import { isChatGptCallback, MCP_CLIENT_ID, ownerKeyFrom, rupees, s256 } from './mcp.ts';

// The owner's ChatGPT plugin (SCRUM-197): he approves with his owner link, ChatGPT gets its own
// tokens, and they read today's totals for his shop through /mcp and open nothing else.

const SHOP = 'shop-a';
const OWNER_KEY = 'owner-key-aaaaaaaaaaaaaaaaaaaaaaaa';
const MANAGER_KEY = 'manager-key-aaaaaaaaaaaaaaaaaaaaaa';
const OTHER_KEY = 'owner-key-bbbbbbbbbbbbbbbbbbbbbbbb';
const ORIGIN = 'https://cloud.test';
const CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect';
const VERIFIER = 'a-long-random-verifier-string-that-chatgpt-keeps-to-itself';
const NOON = Date.UTC(2026, 10, 2, 6, 30); // 12:00 on 2 November in Sri Lanka

async function setup(enabled = true) {
  const { d1, db } = fakeD1();
  for (const [tenant, kind, key] of [[SHOP, 'owner', OWNER_KEY], [SHOP, 'manager', MANAGER_KEY], ['shop-b', 'owner', OTHER_KEY]]) {
    db.prepare('INSERT OR IGNORE INTO shops (id, name, created_at) VALUES (?, ?, 0)').run(tenant, tenant);
    db.prepare('INSERT INTO devices (id, tenant_id, kind, token_hash, created_at) VALUES (?, ?, ?, ?, 0)').run(`dev-${key}`, tenant, kind, await sha256Hex(key));
  }
  const clock = { t: NOON };
  const handle = createCloud(d1, { now: () => clock.t, mcpEnabled: enabled });
  const challenge = await s256(VERIFIER);
  const form = (path: string, fields: Record<string, string>) => handle(new Request(`${ORIGIN}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields),
  }));
  const get = (path: string, bearer?: string) => handle(new Request(`${ORIGIN}${path}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }));
  const asking = (over: Record<string, string> = {}) => ({
    client_id: MCP_CLIENT_ID, redirect_uri: CALLBACK, state: 'xyz', code_challenge: challenge, code_challenge_method: 'S256', resource: `${ORIGIN}/mcp`, ...over,
  });
  const approve = (over: Record<string, string> = {}) => form('/api/v1/mcp/authorize', asking({ link: `${ORIGIN}/?owner=${OWNER_KEY}#owner`, ...over }));
  const codeFrom = (r: Response) => new URL(r.headers.get('location')!).searchParams.get('code')!;
  const exchange = (code: string, over: Record<string, string> = {}) => form('/api/v1/mcp/token', {
    grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: MCP_CLIENT_ID, code_verifier: VERIFIER, resource: `${ORIGIN}/mcp`, ...over,
  });
  const signIn = async (over: Record<string, string> = {}) =>
    (await (await exchange(codeFrom(await approve(over)))).json()) as { access_token: string; refresh_token: string; expires_in: number };
  const rpc = (bearer: string | null, method: string, params?: unknown) => handle(new Request(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }),
  }));
  const sale = (id: string, tenant: string, total: number, tender: string, status = 'paid', date = '2026-11-02') => {
    db.prepare(`INSERT INTO sales (id, tenant_id, order_number, sale_date, sale_time, paid_at, items_count, subtotal, discount, total,
      tender, tendered, change_given, cashier, online, status, event_seq) VALUES (?, ?, 1, ?, '11:00', 0, 1, ?, 0, ?, ?, ?, 0, 'Secret Cashier', 0, ?, 1)`)
      .run(id, tenant, date, total, total, tender, total, status);
  };
  const item = (saleId: string, tenant: string, name: string, qty: number) => {
    db.prepare(`INSERT INTO sale_items (sale_id, tenant_id, line_no, item_id, item_name, qty, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?, 100, 100)`)
      .run(saleId, tenant, qty, name, name, qty);
  };
  return { db, clock, handle, form, get, asking, approve, codeFrom, exchange, signIn, rpc, sale, item };
}

test('off unless switched on', async () => {
  const { get, rpc } = await setup(false);
  assert.equal((await get('/.well-known/oauth-protected-resource')).status, 404);
  assert.equal((await get('/.well-known/oauth-authorization-server')).status, 404);
  assert.equal((await rpc(null, 'initialize')).status, 404);
});

test('ChatGPT can find everything from the first refusal', async () => {
  const { get, handle } = await setup();
  const refused = await handle(new Request(`${ORIGIN}/mcp`, { method: 'POST' })); // ChatGPT's first probe: an empty POST
  assert.equal(refused.status, 401);
  assert.equal(refused.headers.get('www-authenticate'), `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource", scope="shop.owner"`);
  const resource = await (await get('/.well-known/oauth-protected-resource')).json();
  assert.deepEqual(resource, { resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN], scopes_supported: ['shop.owner'] });
  assert.equal((await get('/.well-known/oauth-protected-resource/mcp')).status, 200);
  const server = await (await get('/.well-known/oauth-authorization-server')).json();
  assert.equal(server.issuer, ORIGIN);
  assert.deepEqual(server.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(server.token_endpoint_auth_methods_supported, ['none']);
  assert.equal(server.registration_endpoint, `${ORIGIN}/api/v1/mcp/register`);
  for (const other of ['/.well-known/openid-configuration', '/mcp/.well-known/openid-configuration']) {
    assert.equal((await get(other)).status, 404, `${other} is not a web page`);
  }
});

test('registration takes only ChatGPT callbacks', async () => {
  const { handle } = await setup();
  const register = (redirect_uris: unknown) => handle(new Request(`${ORIGIN}/api/v1/mcp/register`, { method: 'POST', body: JSON.stringify({ redirect_uris }) }));
  const ok = await register([CALLBACK, 'https://chatgpt.com/connector/oauth/abc123']);
  assert.equal(ok.status, 201);
  const client = await ok.json();
  assert.equal(client.client_id, MCP_CLIENT_ID);
  assert.equal(client.token_endpoint_auth_method, 'none');
  assert.equal((await register(['https://evil.test/cb'])).status, 400);
  assert.equal((await register([CALLBACK, 'https://evil.test/cb'])).status, 400);
  assert.equal((await register([])).status, 400);
  assert.equal((await register('nope')).status, 400);
});

test('a code goes only to ChatGPT, and only after the owner link', async () => {
  const { get, asking, approve, codeFrom } = await setup();
  const query = (over: Record<string, string> = {}) => `/api/v1/mcp/authorize?${new URLSearchParams({ response_type: 'code', ...asking(over) })}`;
  const asked = await get(query({ state: '"><script>' }));
  assert.equal(asked.status, 200);
  assert.ok(!(await asked.text()).includes('<script>'), 'the state is escaped');
  assert.match(asked.headers.get('content-security-policy')!, /frame-ancestors 'none'/);

  const wrongAsks: Record<string, string>[] = [
    { redirect_uri: 'https://evil.test/connector_platform_oauth_redirect' },
    { redirect_uri: 'https://chatgpt.com.evil.test/connector_platform_oauth_redirect' },
    { redirect_uri: 'http://chatgpt.com/connector_platform_oauth_redirect' },
    { client_id: 'someone-else' },
    { code_challenge: '' },
    { code_challenge_method: 'plain' },
    { resource: 'https://evil.test/mcp' },
  ];
  for (const over of wrongAsks) {
    assert.equal((await get(query(over))).status, 400, JSON.stringify(over));
    const r = await approve(over);
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.equal(r.headers.get('location'), null, 'never redirected');
  }
  for (const link of ['not a link', `${ORIGIN}/?owner=wrong-key-aaaaaaaaaaaaaaaaaaaaaaaa`, `${ORIGIN}/?manager=${MANAGER_KEY}`, MANAGER_KEY]) {
    const r = await approve({ link });
    assert.equal(r.status, 401, link);
    assert.equal(r.headers.get('location'), null);
  }
  const ok = await approve();
  assert.equal(ok.status, 303);
  const back = new URL(ok.headers.get('location')!);
  assert.equal(back.origin + back.pathname, CALLBACK);
  assert.equal(back.searchParams.get('state'), 'xyz');
  assert.equal(back.searchParams.get('iss'), ORIGIN);
  assert.ok(codeFrom(ok));
});

test('a code needs its verifier, works once, in time, for the same address', async () => {
  const { approve, codeFrom, exchange, clock } = await setup();
  assert.equal((await exchange(codeFrom(await approve()), { code_verifier: 'not-the-verifier' })).status, 400);
  assert.equal((await exchange(codeFrom(await approve()), { code_verifier: '' })).status, 400);
  assert.equal((await exchange(codeFrom(await approve()), { client_id: 'someone-else' })).status, 401);
  assert.equal((await exchange(codeFrom(await approve()), { resource: 'https://evil.test/mcp' })).status, 400);
  assert.equal((await exchange(codeFrom(await approve()), { redirect_uri: 'https://chatgpt.com/connector/oauth/other' })).status, 400);

  const code = codeFrom(await approve());
  const r = await exchange(code);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).token_type, 'bearer');
  assert.equal((await exchange(code)).status, 400, 'not twice');

  const late = codeFrom(await approve());
  clock.t += 5 * 60_000;
  assert.equal((await exchange(late)).status, 400, 'too late');
});

test('MCP: starts, pings, lists its tools; only the draft tool writes', async () => {
  const { rpc, signIn } = await setup();
  const { access_token } = await signIn();
  const init = await (await rpc(access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).json();
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  const newer = await (await rpc(access_token, 'initialize', { protocolVersion: '2099-01-01' })).json();
  assert.equal(newer.result.protocolVersion, '2025-11-25', 'our own version when it asks for an unknown one');
  assert.equal((await (await rpc(access_token, 'ping')).json()).result.resultType, 'complete');
  const { tools } = (await (await rpc(access_token, 'tools/list')).json()).result;
  assert.deepEqual(tools.map((t: { name: string }) => t.name), ['get_today_sales', 'get_sales', 'get_attention', 'get_stock', 'get_menu_profit', 'get_supplier_orders', 'draft_supplier_order']);
  for (const tool of tools) {
    assert.equal(tool.annotations.readOnlyHint, tool.name !== 'draft_supplier_order', tool.name);
    assert.equal(tool.annotations.destructiveHint, false, tool.name);
    assert.deepEqual(tool.securitySchemes, [{ type: 'oauth2', scopes: ['shop.owner'] }], tool.name);
  }
  assert.equal((await (await rpc(access_token, 'tools/call', { name: 'delete_everything' })).json()).error.code, -32602);
  assert.equal((await (await rpc(access_token, 'no/such')).json()).error.code, -32601);
});

const MODERN = '2026-07-28';
const modern = (id: unknown, method: string, params: Record<string, unknown> = {}, meta: Record<string, unknown> = {
  'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {},
}) => JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } });
const modernHeaders = (method: string, name?: string): Record<string, string> => ({
  'content-type': 'application/json', 'mcp-protocol-version': MODERN, 'mcp-method': method, ...(name ? { 'mcp-name': name } : {}),
});

test('before sign-in ChatGPT can look and list, as it does: no shop data, and the tool call asks for sign-in', async () => {
  const { handle, sale } = await setup();
  sale('s1', SHOP, 480050, 'cash');
  const post = (body: string, headers: Record<string, string>) => handle(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers, body }));

  const discovered = await post(modern('d', 'server/discover'), modernHeaders('server/discover'));
  assert.equal(discovered.status, 200);
  const { result: found } = await discovered.json();
  assert.equal(found.resultType, 'complete');
  assert.ok(found.supportedVersions.includes(MODERN));
  assert.deepEqual(found.capabilities, { tools: {} });
  assert.equal(found._meta['io.modelcontextprotocol/serverInfo'].name, 'cheesybeez');

  const { result: listed } = await (await post(modern(1, 'tools/list'), modernHeaders('tools/list'))).json();
  assert.equal(listed.resultType, 'complete');
  assert.equal(listed.cacheScope, 'public');
  assert.ok(listed.ttlMs > 0);
  assert.deepEqual(listed.tools.map((x: { name: string }) => x.name), ['get_today_sales', 'get_sales', 'get_attention', 'get_stock', 'get_menu_profit', 'get_supplier_orders', 'draft_supplier_order']);

  const raw = await (await post(modern(2, 'tools/call', { name: 'get_today_sales', arguments: {} }), modernHeaders('tools/call', 'get_today_sales'))).text();
  const { result: asked } = JSON.parse(raw);
  assert.equal(asked.isError, true);
  assert.equal(asked.structuredContent, undefined);
  assert.ok(!raw.includes('4,800'), 'no shop data without a token');
  const [challenge] = asked._meta['mcp/www_authenticate'];
  assert.match(challenge, /resource_metadata="https:\/\/cloud\.test\/\.well-known\/oauth-protected-resource"/);
  assert.match(challenge, /error="[a-z_]+"/);
  assert.match(challenge, /error_description="[^"]+"/);
});

test('2026-07-28: a signed-in call reads the shop; requests that break the rules are refused', async () => {
  const { handle, signIn, sale } = await setup();
  sale('s1', SHOP, 480050, 'cash');
  const { access_token } = await signIn();
  const post = (body: string, headers: Record<string, string>) =>
    handle(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${access_token}`, ...headers }, body }));
  const call = modern(1, 'tools/call', { name: 'get_today_sales', arguments: {} });

  const { result } = await (await post(call, modernHeaders('tools/call', 'get_today_sales'))).json();
  assert.equal(result.resultType, 'complete');
  assert.equal(result.structuredContent.total, 'Rs 4,800.50');

  const code = async (r: Response) => [r.status, (await r.json()).error.code];
  assert.deepEqual(await code(await post(call, modernHeaders('tools/list', 'get_today_sales'))), [400, -32020], 'Mcp-Method differs');
  assert.deepEqual(await code(await post(call, modernHeaders('tools/call', 'other'))), [400, -32020], 'Mcp-Name differs');
  assert.deepEqual(await code(await post(call, { 'content-type': 'application/json' })), [400, -32020], 'headers missing');
  const old = await post(modern(1, 'tools/list', {}, { 'io.modelcontextprotocol/protocolVersion': '1900-01-01', 'io.modelcontextprotocol/clientCapabilities': {} }), modernHeaders('tools/list'));
  assert.equal(old.status, 400);
  const { error } = await old.json();
  assert.equal(error.code, -32022);
  assert.ok(error.data.supported.includes(MODERN));
  assert.deepEqual(await code(await post(modern(1, 'tools/list', {}, { 'io.modelcontextprotocol/protocolVersion': MODERN }), modernHeaders('tools/list'))), [400, -32602], 'capabilities missing');
  assert.deepEqual(await code(await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), modernHeaders('tools/list'))), [400, -32602], '_meta missing');
  assert.deepEqual(await code(await post(modern(1, 'no/such'), modernHeaders('no/such'))), [404, -32601]);
});

test('MCP: a notification gets no answer; only POST; bad JSON is refused', async () => {
  const { handle, get, signIn } = await setup();
  const { access_token } = await signIn();
  const post = (body: string) => handle(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${access_token}` }, body }));
  assert.equal((await post(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).status, 202);
  assert.equal((await post('{not json')).status, 400);
  assert.equal((await post('[]')).status, 400);
  assert.equal((await get('/mcp', access_token)).status, 405);
  assert.equal((await get('/mcp')).status, 401, 'no token is told how to sign in first');
});

test("today: his shop's standing payments, totals and item names only", async () => {
  const { rpc, signIn, sale, item, db } = await setup();
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
  const raw = await (await rpc(access_token, 'tools/call', { name: 'get_today_sales', arguments: {} })).text();
  const { result } = JSON.parse(raw);
  const want = {
    date: '2026-11-02', time_now: '12:00', orders: 2, total: 'Rs 5,800.50', cash: 'Rs 4,800.50', bank_transfer: 'Rs 1,000.00',
    other_payments: 'Rs 0.00', discounts_given: 'Rs 0.00', online_orders: 0,
    top_items: [{ name: 'Devilled Chicken', qty: 3 }, { name: 'Margherita', qty: 1 }],
    compared_with: null,
    last_copied_from_shop: { date: '2026-11-02', time: '11:50', minutes_ago: 10 },
  };
  assert.deepEqual(result.structuredContent, want);
  assert.deepEqual(JSON.parse(result.content[0].text), want, 'the same for clients that read only text');
  assert.ok(!raw.includes('Secret Cashier'), 'staff names stay home');
});

test('each owner reads only his own shop', async () => {
  const { rpc, signIn, sale } = await setup();
  sale('a', SHOP, 1000, 'cash');
  sale('b', 'shop-b', 2000, 'cash');
  const read = async (link: string) => (await (await rpc((await signIn({ link })).access_token, 'tools/call', { name: 'get_today_sales' })).json()).result.structuredContent.total;
  assert.equal(await read(OWNER_KEY), 'Rs 10.00');
  assert.equal(await read(OTHER_KEY), 'Rs 20.00');
});

const LAST_MONDAYS = ['2026-10-26', '2026-10-19', '2026-10-12', '2026-10-05']; // the four Mondays before Monday 2 November

const timedSale = (db: ReturnType<typeof fakeD1>['db'], id: string, tenant: string, date: string, time: string, total: number) => {
  db.prepare(`INSERT INTO sales (id, tenant_id, order_number, sale_date, sale_time, paid_at, items_count, subtotal, discount, total,
    tender, tendered, change_given, cashier, online, status, event_seq) VALUES (?, ?, 1, ?, ?, 0, 1, ?, 0, ?, 'cash', ?, 0, 'Secret Cashier', 0, 'paid', 1)`)
    .run(id, tenant, date, time, total, total, total);
};

test('get_sales: one past day, against the usual for that weekday', async () => {
  const { db, rpc, signIn, item, sale } = await setup();
  const ask = async (args: unknown) => (await (await rpc((await signIn()).access_token, 'tools/call', { name: 'get_sales', arguments: args })).json()).result;
  timedSale(db, 'd', SHOP, '2026-10-26', '12:00', 120000);
  item('d', SHOP, 'Margherita', 2);
  sale('undone', SHOP, 99900, 'cash', 'undone', '2026-10-26');
  timedSale(db, 'other', 'shop-b', '2026-10-26', '12:00', 777700);
  // Mondays before it: two open, one with no sales at all (closed: not counted as zero).
  timedSale(db, 'u1', SHOP, '2026-10-19', '12:00', 100000);
  timedSale(db, 'u2', SHOP, '2026-10-12', '12:00', 50000);
  timedSale(db, 'u3', SHOP, '2026-10-12', '13:00', 50000);

  const { structuredContent: day } = await ask({ date_from: '2026-10-26', date_to: '2026-10-26' });
  assert.equal(day.total, 'Rs 1,200.00');
  assert.equal(day.orders, 1);
  assert.equal(day.includes_today_so_far, false);
  assert.deepEqual(day.top_items, [{ name: 'Margherita', qty: 2 }]);
  assert.deepEqual(day.by_day, [{ date: '2026-10-26', weekday: 'Monday', orders: 1, total: 'Rs 1,200.00' }]);
  assert.equal(day.compared_with.total, 'Rs 1,000.00');
  assert.equal(day.compared_with.change_percent, 20);
  assert.match(day.compared_with.description, /usual Monday.*last 2 Mondays/);
});

test('get_sales: with fewer than 2 open days to go on, it says there is no usual', async () => {
  const { db, rpc, signIn } = await setup();
  timedSale(db, 'd', SHOP, '2026-10-26', '12:00', 120000);
  timedSale(db, 'u', SHOP, '2026-10-19', '12:00', 100000);
  const { result } = await (await rpc((await signIn()).access_token, 'tools/call', { name: 'get_sales', arguments: { date_from: '2026-10-26', date_to: '2026-10-26' } })).json();
  assert.equal(result.structuredContent.compared_with, null);
});

test('today is compared with the usual by this time, not with whole past days', async () => {
  const { db, rpc, signIn } = await setup(); // it is 12:00 on a Monday
  timedSale(db, 'now', SHOP, '2026-11-02', '11:00', 100000);
  for (const [i, date] of LAST_MONDAYS.entries()) {
    timedSale(db, `m${i}`, SHOP, date, '11:30', 50000); // by noon
    timedSale(db, `e${i}`, SHOP, date, '20:00', 900000); // the evening has not happened yet today
  }
  const token = (await signIn()).access_token;
  const call = async (name: string, args = {}) => (await (await rpc(token, 'tools/call', { name, arguments: args })).json()).result.structuredContent;
  const today = await call('get_today_sales');
  assert.equal(today.compared_with.total, 'Rs 500.00');
  assert.equal(today.compared_with.orders, 1);
  assert.equal(today.compared_with.change_percent, 100);
  assert.match(today.compared_with.description, /by 12:00/);
  assert.deepEqual((await call('get_sales', { date_from: '2026-11-02', date_to: '2026-11-02' })).compared_with, today.compared_with);
  const past = await call('get_sales', { date_from: '2026-10-26', date_to: '2026-10-26' });
  assert.equal(past.total, 'Rs 9,500.00', 'a finished day counts all of it');
});

test('get_sales: a period, each day in it, and the same number of days before', async () => {
  const { db, rpc, signIn } = await setup();
  timedSale(db, 'a', SHOP, '2026-10-20', '12:00', 100000);
  timedSale(db, 'b', SHOP, '2026-10-22', '12:00', 200000);
  timedSale(db, 'outside', SHOP, '2026-10-23', '12:00', 400000);
  timedSale(db, 'p', SHOP, '2026-10-18', '12:00', 150000); // the 3 days before: 17 to 19
  timedSale(db, 'too-old', SHOP, '2026-10-16', '12:00', 800000);
  const { result } = await (await rpc((await signIn()).access_token, 'tools/call', { name: 'get_sales', arguments: { date_from: '2026-10-20', date_to: '2026-10-22' } })).json();
  const r = result.structuredContent;
  assert.equal(r.days, 3);
  assert.equal(r.total, 'Rs 3,000.00');
  assert.deepEqual(r.by_day.map((d: { date: string }) => d.date), ['2026-10-20', '2026-10-22'], 'only days with sales');
  assert.equal(r.compared_with.total, 'Rs 1,500.00');
  assert.equal(r.compared_with.change_percent, 100);
  assert.match(r.compared_with.description, /3 days before: 2026-10-17 to 2026-10-19/);
});

test('get_sales: a period reaching today says it is still growing; nothing before it means no comparison', async () => {
  const { db, rpc, signIn } = await setup();
  timedSale(db, 'a', SHOP, '2026-11-02', '11:00', 100000);
  const { result } = await (await rpc((await signIn()).access_token, 'tools/call', { name: 'get_sales', arguments: { date_from: '2026-11-01', date_to: '2026-11-02' } })).json();
  assert.equal(result.structuredContent.includes_today_so_far, true);
  assert.equal(result.structuredContent.compared_with, null);
});

test('get_sales: dates it cannot answer are explained to the model, and read nothing', async () => {
  const { db, rpc, signIn } = await setup();
  timedSale(db, 'a', SHOP, '2026-10-26', '12:00', 123400);
  const token = (await signIn()).access_token;
  for (const [args, why] of [
    [{}, /real dates/],
    [{ date_from: '2026-10-26' }, /real dates/],
    [{ date_from: 'yesterday', date_to: '2026-10-26' }, /real dates/],
    [{ date_from: '2026-02-31', date_to: '2026-03-01' }, /real dates/],
    [{ date_from: "2026-10-26' OR 1=1", date_to: '2026-10-26' }, /real dates/],
    [{ date_from: '2026-10-27', date_to: '2026-10-26' }, /not be after/],
    [{ date_from: '2026-11-02', date_to: '2026-11-03' }, /future.*2026-11-02/],
    [{ date_from: '2026-01-01', date_to: '2026-10-26' }, /at most 92 days/],
  ] as const) {
    const raw = await (await rpc(token, 'tools/call', { name: 'get_sales', arguments: args })).text();
    const { result } = JSON.parse(raw);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(result.content[0].text, why, JSON.stringify(args));
    assert.equal(result.structuredContent, undefined);
    assert.ok(!raw.includes('1,234'), 'no sales in a refusal');
  }
  const { result: most } = await (await rpc(token, 'tools/call', { name: 'get_sales', arguments: { date_from: '2026-08-03', date_to: '2026-11-02' } })).json();
  assert.equal(most.structuredContent.days, 92, 'the limit itself is allowed');
});

test('get_sales needs sign-in like the other tool, and answers only for his own shop', async () => {
  const { db, rpc, signIn } = await setup();
  timedSale(db, 'mine', SHOP, '2026-10-26', '12:00', 100000);
  timedSale(db, 'theirs', 'shop-b', '2026-10-26', '12:00', 200000);
  const args = { date_from: '2026-10-26', date_to: '2026-10-26' };
  const raw = await (await rpc(null, 'tools/call', { name: 'get_sales', arguments: args })).text();
  const { result: anon } = JSON.parse(raw);
  assert.equal(anon.isError, true);
  assert.ok(anon._meta['mcp/www_authenticate']);
  assert.ok(!raw.includes('1,000') && !raw.includes('2,000'));
  const read = async (link: string) => (await (await rpc((await signIn({ link })).access_token, 'tools/call', { name: 'get_sales', arguments: args })).json()).result.structuredContent.total;
  assert.equal(await read(OWNER_KEY), 'Rs 1,000.00');
  assert.equal(await read(OTHER_KEY), 'Rs 2,000.00');
});

test('a day with no sales says so plainly', async () => {
  const { rpc, signIn } = await setup();
  const { result } = await (await rpc((await signIn()).access_token, 'tools/call', { name: 'get_today_sales' })).json();
  assert.equal(result.structuredContent.orders, 0);
  assert.equal(result.structuredContent.total, 'Rs 0.00');
  assert.equal(result.structuredContent.last_copied_from_shop, null);
});

test('the token opens /mcp only, and no other key opens /mcp', async () => {
  const { get, rpc, signIn } = await setup();
  const { access_token } = await signIn();
  assert.equal((await rpc('made-up', 'tools/list')).status, 401);
  assert.equal((await rpc(OWNER_KEY, 'tools/list')).status, 401, 'the owner key is not an MCP token');
  for (const path of ['/api/v1/events?after=0', '/api/v1/me', '/api/v1/inbox?after=0', '/api/v1/devices']) {
    assert.equal((await get(path, access_token)).status, 401, path);
  }
});

test('the token runs out; a refresh works once; all of it dies with the owner device', async () => {
  const { rpc, form, signIn, clock, db } = await setup();
  const first = await signIn();
  const refresh = (refresh_token: string) => form('/api/v1/mcp/token', { grant_type: 'refresh_token', refresh_token, client_id: MCP_CLIENT_ID });

  clock.t += first.expires_in * 1000;
  assert.equal((await rpc(first.access_token, 'ping')).status, 401, 'expired');
  const second = await (await refresh(first.refresh_token)).json();
  assert.equal((await rpc(second.access_token, 'ping')).status, 200);
  assert.equal((await rpc(first.access_token, 'ping')).status, 401, 'the old one is gone');
  assert.equal((await refresh(first.refresh_token)).status, 400, 'a refresh token works once');

  const third = await (await refresh(second.refresh_token)).json();
  db.prepare('DELETE FROM devices WHERE id = ?').run(`dev-${OWNER_KEY}`);
  assert.equal((await rpc(third.access_token, 'ping')).status, 401, 'cut off at once');
  assert.equal((await refresh(third.refresh_token)).status, 400);
});

test("Disconnect: the owner's phone cuts ChatGPT off at once; Undo works for a minute; a new sign-in comes back", async () => {
  const { handle, rpc, form, signIn, clock } = await setup();
  const phone = (path: string, key: string | null = OWNER_KEY, body?: unknown) => handle(new Request(`${ORIGIN}/api/v1/mcp/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: key ? { authorization: `Bearer ${key}` } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const connected = async () => (await (await phone('connection')).json()).connected;
  assert.equal(await connected(), false, 'nothing yet');

  const link = await signIn();
  const again = await signIn();
  assert.equal(await connected(), true);

  // Only an owner's phone: not a manager's, not ChatGPT's own token, not nobody.
  for (const key of [MANAGER_KEY, link.access_token, null]) {
    assert.notEqual((await phone('disconnect', key, {})).status, 200, String(key));
    assert.notEqual((await phone('connection', key)).status, 200, String(key));
  }
  assert.equal((await rpc(link.access_token, 'ping')).status, 200, 'none of those did anything');

  const { at } = await (await phone('disconnect', OWNER_KEY, {})).json();
  assert.equal(await connected(), false);
  assert.equal((await rpc(link.access_token, 'ping')).status, 401, 'every link is cut at once');
  assert.equal((await rpc(again.access_token, 'ping')).status, 401);
  const refresh = (refresh_token: string) => form('/api/v1/mcp/token', { grant_type: 'refresh_token', refresh_token, client_id: MCP_CLIENT_ID });
  assert.equal((await refresh(link.refresh_token)).status, 400, 'and cannot refresh its way back');

  assert.equal((await phone('reconnect', OTHER_KEY, { at })).status, 200);
  assert.equal(await connected(), false, "another shop's owner changes nothing here");
  assert.equal((await phone('reconnect', OWNER_KEY, { at: 'nonsense' })).status, 410);
  assert.equal((await phone('reconnect', OWNER_KEY, { at })).status, 200);
  assert.equal(await connected(), true, 'Undo');
  assert.equal((await rpc(link.access_token, 'ping')).status, 200);

  const second = await (await phone('disconnect', OWNER_KEY, {})).json();
  clock.t += 60_000;
  assert.equal((await phone('reconnect', OWNER_KEY, { at: second.at })).status, 410, 'too late');
  assert.equal(await connected(), false);

  await phone('disconnect', OWNER_KEY, {});
  const fresh = await signIn();
  assert.equal(await connected(), true, 'signing in again from ChatGPT connects it');
  assert.equal((await rpc(fresh.access_token, 'ping')).status, 200);
});

test("Disconnect leaves another shop's ChatGPT alone, and is off with the server", async () => {
  const { handle, rpc, signIn } = await setup();
  const theirs = await signIn({ link: OTHER_KEY });
  await signIn();
  await handle(new Request(`${ORIGIN}/api/v1/mcp/disconnect`, { method: 'POST', headers: { authorization: `Bearer ${OWNER_KEY}` }, body: '{}' }));
  assert.equal((await rpc(theirs.access_token, 'ping')).status, 200);
  const off = await setup(false);
  assert.equal((await off.handle(new Request(`${ORIGIN}/api/v1/mcp/connection`, { headers: { authorization: `Bearer ${OWNER_KEY}` } }))).status, 404);
});

test('a refresh token left unused for 90 days runs out', async () => {
  const { form, signIn, clock } = await setup();
  const { refresh_token } = await signIn();
  clock.t += 90 * 24 * 3_600_000;
  assert.equal((await form('/api/v1/mcp/token', { grant_type: 'refresh_token', refresh_token, client_id: MCP_CLIENT_ID })).status, 400);
});

test('helpers', async () => {
  assert.equal(rupees(0), 'Rs 0.00');
  assert.equal(rupees(5), 'Rs 0.05');
  assert.equal(rupees(123456789), 'Rs 1,234,567.89');
  assert.equal(ownerKeyFrom(`  ${OWNER_KEY} `), OWNER_KEY);
  assert.equal(ownerKeyFrom(`https://x.test/?owner=${OWNER_KEY}#owner`), OWNER_KEY);
  assert.equal(ownerKeyFrom(`https://x.test/owner.webmanifest?k=${OWNER_KEY}`), OWNER_KEY);
  assert.equal(ownerKeyFrom('hello there'), null);
  assert.ok(isChatGptCallback('https://chatgpt.com/connector/oauth/abc_123'));
  assert.ok(!isChatGptCallback(`${CALLBACK}?x=1`));
  assert.ok(!isChatGptCallback('https://chatgpt.com/connector/oauth/../evil'));
  // RFC 7636's own example.
  assert.equal(await s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

// ----- SCRUM-198: the digest from the shop PC, and the draft -----

const SHOP_KEY = 'shop-server-key-aaaaaaaaaaaaaaaaaaaaa';
const OTHER_SHOP_KEY = 'shop-server-key-bbbbbbbbbbbbbbbbbbbbb';
const DIGEST = {
  version: 1, computedAt: NOON - 5 * 60_000,
  attention: [{ tone: 'attention', title: 'Flour is low', detail: 'Lasts 2 days.', items: [{ what: 'Flour', note: 'order soon', amountCents: 150050 }] }],
  stock: [
    { id: 'flour', name: 'Flour', category: 'Dry', status: 'low', onHand: '5 kg', usedPerDay: '2 kg', lastsDays: 2.5, pack: '25 kg', packPriceCents: 640000, onHandPacks: 0.2, suggestedPacks: 2, onOrderPacks: 0, supplierIds: ['sup-a'], countedAt: 1 },
    { id: 'salt', name: 'Salt', category: 'Dry', status: 'ok', onHand: '9 kg', usedPerDay: null, lastsDays: null, pack: '1 kg', packPriceCents: 10000, onHandPacks: 9, suggestedPacks: 0, onOrderPacks: 0, supplierIds: ['sup-a'], countedAt: 1 },
    { id: 'cheese', name: 'Cheese', category: 'Dairy', status: 'unknown', onHand: null, usedPerDay: null, lastsDays: null, pack: '2 kg', packPriceCents: 500000, onHandPacks: null, suggestedPacks: 0, onOrderPacks: 1, supplierIds: ['sup-b'], countedAt: null },
  ],
  semiProcessed: [{ name: 'Dough', onHand: '4 pcs', status: 'low' }],
  dishes: [
    { name: 'Margherita', size: 'L', priceCents: 200000, foodCostCents: 80000, marginPercent: 60, soldLast28Days: 12, canMake: 3 },
    { name: 'Loss Leader', size: '', priceCents: 10000, foodCostCents: 15000, marginPercent: -50, soldLast28Days: 1, canMake: null },
    { name: 'New Pizza', size: 'M', priceCents: 150000, foodCostCents: null, marginPercent: null, soldLast28Days: 0, canMake: null },
  ],
  unansweredCosts: 4,
  suppliers: [
    { id: 'sup-a', name: 'Supplier A', leadDays: 2, draft: [{ itemId: 'salt', name: 'Salt', packs: 1, unitPriceCents: 9000 }], suggested: [{ itemId: 'flour', name: 'Flour', packs: 2 }], openOrders: [] },
    { id: 'sup-b', name: 'Supplier B', leadDays: null, draft: [], suggested: [], openOrders: [{ number: 'PO-7', status: 'Open', placedAt: NOON - 86_400_000, lines: [{ itemId: 'cheese', name: 'Cheese', packs: 1 }] }] },
  ],
};

async function withDigest() {
  const s = await setup();
  for (const [tenant, key] of [[SHOP, SHOP_KEY], ['shop-b', OTHER_SHOP_KEY]]) {
    s.db.prepare('INSERT INTO devices (id, tenant_id, kind, token_hash, created_at) VALUES (?, ?, ?, ?, 0)').run(`srv-${key}`, tenant, 'shop_server', await sha256Hex(key));
  }
  const upload = (key: string, body: unknown) => s.handle(new Request(`${ORIGIN}/api/v1/mcp/digest`, {
    method: 'PUT', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
  const call = async (bearer: string, name: string, args: unknown = {}) => {
    const { result } = await (await s.rpc(bearer, 'tools/call', { name, arguments: args })).json();
    return result as { isError: boolean; structuredContent: Record<string, any>; content: { text: string }[] };
  };
  const inbox = () => s.db.prepare('SELECT tenant_id, device_id, body FROM inbox ORDER BY seq').all() as { tenant_id: string; device_id: string; body: string }[];
  return { ...s, upload, call, inbox };
}

test('the shop PC is asked for a digest only while ChatGPT is connected, and only by its own shop', async () => {
  const s = await withDigest();
  const wanted = (key: string) => s.get('/api/v1/mcp/wanted', key);
  assert.deepEqual(await (await wanted(SHOP_KEY)).json(), { wanted: false });
  await s.signIn();
  assert.deepEqual(await (await wanted(SHOP_KEY)).json(), { wanted: true });
  assert.deepEqual(await (await wanted(OTHER_SHOP_KEY)).json(), { wanted: false }, 'the other shop has no ChatGPT');
  assert.equal((await wanted(OWNER_KEY)).status, 403, "an owner's phone is not a shop server");
  assert.equal((await s.upload(OWNER_KEY, { digest: DIGEST })).status, 403);
});

test('off with the server: the shop PC hears 404 and stays quiet', async () => {
  const { get } = await setup(false);
  assert.equal((await get('/api/v1/mcp/wanted', SHOP_KEY)).status, 404);
});

test('an upload that is not a digest, or far too big, is refused', async () => {
  const s = await withDigest();
  assert.equal((await s.upload(SHOP_KEY, 'not json')).status, 400);
  assert.equal((await s.upload(SHOP_KEY, { digest: {} })).status, 400);
  assert.equal((await s.upload(SHOP_KEY, { digest: { computedAt: 1, x: 'y'.repeat(1_000_001) } })).status, 413);
});

test('before the first digest each tool says so; sales still work', async () => {
  const s = await withDigest();
  const { access_token } = await s.signIn();
  for (const name of ['get_attention', 'get_stock', 'get_menu_profit', 'get_supplier_orders', 'draft_supplier_order']) {
    const r = await s.call(access_token, name, { supplier_id: 'sup-a', lines: [{ item_id: 'flour', packs: 1 }] });
    assert.equal(r.isError, true, name);
    assert.match(r.content[0].text, /has not sent this yet/, name);
  }
  assert.equal((await s.call(access_token, 'get_today_sales')).isError, false);
  assert.equal(s.inbox().length, 0);
});

test('attention, stock, profit and orders read the digest, with its age, in rupees', async () => {
  const s = await withDigest();
  const { access_token } = await s.signIn();
  assert.equal((await s.upload(SHOP_KEY, { digest: DIGEST })).status, 200);

  const attention = (await s.call(access_token, 'get_attention')).structuredContent;
  assert.equal(attention.as_of.minutes_ago, 5);
  assert.deepEqual(attention.cards[0].items[0], { what: 'Flour', note: 'order soon', amount: 'Rs 1,500.50' });

  const stock = (await s.call(access_token, 'get_stock')).structuredContent;
  assert.equal(stock.items.length, 3);
  assert.equal(stock.items[2].on_hand, null, 'never counted stays unknown');
  assert.deepEqual(stock.can_make, [{ name: 'Margherita', size: 'L', can_make: 3 }]);
  const low = (await s.call(access_token, 'get_stock', { only_needing_attention: true })).structuredContent;
  assert.deepEqual(low.items.map((i: { item_id: string }) => i.item_id), ['flour']);

  const profit = (await s.call(access_token, 'get_menu_profit')).structuredContent;
  assert.deepEqual(profit.dishes[0], { name: 'Margherita', size: 'L', price: 'Rs 2,000.00', food_cost: 'Rs 800.00', earned_each: 'Rs 1,200.00', margin_percent: 60, sold_last_28_days: 12 });
  assert.equal(profit.dishes[1].earned_each, '-Rs 50.00', 'a dish that loses money says so');
  assert.equal(profit.dishes[2].food_cost, null, 'an unpriced recipe is not guessed');
  assert.equal(profit.unanswered_cost_questions, 4);

  const orders = (await s.call(access_token, 'get_supplier_orders')).structuredContent;
  assert.equal(orders.suppliers[0].draft[0].pack_price, 'Rs 90.00');
  assert.equal(orders.suppliers[1].open_orders[0].number, 'PO-7');
});

test('the digest answers only its own shop', async () => {
  const s = await withDigest();
  await s.upload(SHOP_KEY, { digest: DIGEST });
  const other = await s.signIn({ link: `${ORIGIN}/?owner=${OTHER_KEY}#owner` });
  assert.equal((await s.call(other.access_token, 'get_stock')).isError, true);
});

test('a draft goes to the shop inbox as a valid owner event, keeps other lines and their prices, and can be undone', async () => {
  const s = await withDigest();
  const { access_token } = await s.signIn();
  await s.upload(SHOP_KEY, { digest: DIGEST });

  const first = (await s.call(access_token, 'draft_supplier_order', { supplier_id: 'sup-a', lines: [{ item_id: 'flour', packs: 2 }] })).structuredContent;
  assert.equal(first.changed, true);
  assert.deepEqual(first.to_undo, { supplier_id: 'sup-a', lines: [{ item_id: 'flour', packs: 0 }] });
  assert.match(first.nothing_is_ordered, /only a draft/);
  const [row] = s.inbox();
  assert.equal(row.tenant_id, SHOP);
  const event = JSON.parse(row.body);
  assert.equal(event.type, 'stock.draft_set');
  assert.equal(event.shopId, SHOP);
  assert.equal(event.actor.role, 'owner');
  assert.equal(event.actor.name, 'ChatGPT, for the owner');
  assert.deepEqual(event.lines, [{ itemId: 'salt', packs: 1, unitPriceCents: 9000 }, { itemId: 'flour', packs: 2 }]);

  // Before the shop's next digest, a second request builds on the first.
  const second = (await s.call(access_token, 'draft_supplier_order', { supplier_id: 'sup-a', lines: [{ item_id: 'salt', packs: 0 }] })).structuredContent;
  assert.deepEqual(second.draft, [{ item_id: 'flour', name: 'Flour', packs: 2 }]);
  assert.deepEqual(second.to_undo.lines, [{ item_id: 'salt', packs: 1 }]);
  assert.equal(s.inbox().length, 2);

  // The same again changes nothing and writes nothing.
  assert.equal((await s.call(access_token, 'draft_supplier_order', { supplier_id: 'sup-a', lines: [{ item_id: 'flour', packs: 2 }] })).structuredContent.changed, false);
  assert.equal(s.inbox().length, 2);

  // Undo with what the answer gave.
  await s.call(access_token, 'draft_supplier_order', first.to_undo);
  assert.deepEqual(JSON.parse(s.inbox().at(-1)!.body).lines, []);
});

test('a draft is refused without writing when it makes no sense; only this tool ever writes', async () => {
  const s = await withDigest();
  const { access_token } = await s.signIn();
  await s.upload(SHOP_KEY, { digest: DIGEST });
  const refused: [unknown, RegExp][] = [
    [{ supplier_id: 'nope', lines: [{ item_id: 'flour', packs: 1 }] }, /Unknown supplier/],
    [{ supplier_id: 'sup-a', lines: [] }, /1 to 50/],
    [{ supplier_id: 'sup-a', lines: [{ item_id: 'nope', packs: 1 }] }, /Unknown item_id/],
    [{ supplier_id: 'sup-a', lines: [{ item_id: 'cheese', packs: 1 }] }, /does not sell Cheese/],
    [{ supplier_id: 'sup-a', lines: [{ item_id: 'flour', packs: -1 }] }, /from 0 to 1000/],
    [{ supplier_id: 'sup-a', lines: [{ item_id: 'flour', packs: 5000 }] }, /from 0 to 1000/],
    [{ supplier_id: 'sup-a', lines: [{ item_id: 'flour', packs: '2' }] }, /from 0 to 1000/],
  ];
  for (const [args, why] of refused) {
    const r = await s.call(access_token, 'draft_supplier_order', args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.content[0].text, why);
  }
  for (const name of ['get_attention', 'get_stock', 'get_menu_profit', 'get_supplier_orders']) await s.call(access_token, name);
  assert.equal(s.inbox().length, 0);
});

test('a draft warns when an item is already on an open order', async () => {
  const s = await withDigest();
  const { access_token } = await s.signIn();
  await s.upload(SHOP_KEY, { digest: DIGEST });
  const r = (await s.call(access_token, 'draft_supplier_order', { supplier_id: 'sup-b', lines: [{ item_id: 'cheese', packs: 1 }] })).structuredContent;
  assert.deepEqual(r.already_on_an_open_order, ['Cheese']);
});
