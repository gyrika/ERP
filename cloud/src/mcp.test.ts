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
  assert.equal(refused.headers.get('www-authenticate'), `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource", scope="sales.read"`);
  const resource = await (await get('/.well-known/oauth-protected-resource')).json();
  assert.deepEqual(resource, { resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN], scopes_supported: ['sales.read'] });
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

test('MCP: starts, pings, lists its one read-only tool', async () => {
  const { rpc, signIn } = await setup();
  const { access_token } = await signIn();
  const init = await (await rpc(access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).json();
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  const newer = await (await rpc(access_token, 'initialize', { protocolVersion: '2099-01-01' })).json();
  assert.equal(newer.result.protocolVersion, '2025-11-25', 'our own version when it asks for an unknown one');
  assert.equal((await (await rpc(access_token, 'ping')).json()).result.resultType, 'complete');
  const { tools } = (await (await rpc(access_token, 'tools/list')).json()).result;
  assert.deepEqual(tools.map((t: { name: string }) => t.name), ['get_today_sales']);
  assert.equal(tools[0].annotations.readOnlyHint, true);
  assert.deepEqual(tools[0].securitySchemes, [{ type: 'oauth2', scopes: ['sales.read'] }]);
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
  assert.deepEqual(listed.tools.map((x: { name: string }) => x.name), ['get_today_sales']);

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
