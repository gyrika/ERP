import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCloud, sha256Hex } from './cloud.ts';
import { fakeD1 } from './fakeD1.ts';
import { managerManifest } from './worker.ts';

// The manager's phone app (SCRUM-94): made for one person by the shop server; records stock
// into an inbox the shop takes from; keeps shelf photos with the shop.

const SHOP = 'shop-a';
const ravi = { id: 'staff-ravi', name: 'Ravi', role: 'manager' };

async function setup() {
  const { d1, db } = fakeD1();
  for (const [tenant, kind, token] of [[SHOP, 'shop_server', 'server-a'], [SHOP, 'owner', 'owner-a'], ['shop-b', 'shop_server', 'server-b']]) {
    db.prepare('INSERT OR IGNORE INTO shops (id, name, created_at) VALUES (?, ?, 0)').run(tenant, tenant);
    db.prepare('INSERT INTO devices (id, tenant_id, kind, token_hash, created_at) VALUES (?, ?, ?, ?, 0)').run(`dev-${token}`, tenant, kind, await sha256Hex(token));
  }
  const handle = createCloud(d1, { now: () => 9000 });
  const call = (path: string, token: string | null, body?: unknown) => handle(new Request(`https://cloud.test${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { call, db };
}

const count = (id: string, actor = ravi, type = 'stock.counted') => ({
  id, shopId: SHOP, at: 5000, orderNumber: 0, actor, type, itemId: 'inv-0006',
  ...(type === 'stock.counted'
    ? { counted: 1000, expected: 2000, entries: [], reason: 'unknown', valueCents: -260000, tier: 'daily', photo: 'ph-abcdefgh12' }
    : { tier: 'daily' }),
});

test('the shop server makes a manager phone for one manager; a cashier or nobody is refused', async () => {
  const { call } = await setup();
  assert.equal((await call('/api/v1/devices', 'server-a', { kind: 'manager', actor: { ...ravi, role: 'cashier' } })).status, 400);
  assert.equal((await call('/api/v1/devices', 'server-a', { kind: 'manager' })).status, 400);
  assert.equal((await call('/api/v1/devices', 'owner-a', { kind: 'manager', actor: ravi })).status, 403, 'only the shop server makes phones');
  const { token } = await (await call('/api/v1/devices', 'server-a', { kind: 'manager', actor: ravi })).json();
  assert.deepEqual(await (await call('/api/v1/me', token)).json(), { actor: ravi, shopId: SHOP });
  const list = await (await call('/api/v1/devices', 'server-a')).json();
  assert.deepEqual(list.devices.map((d: { kind: string; person?: string }) => [d.kind, d.person ?? null]), [['owner', null], ['manager', 'Ravi']]);
  assert.equal((await call('/api/v1/events?after=0', token)).status, 200, 'it reads the shop like the owner phone');
});

test("the phone's stock events wait in the inbox for the shop server, in order; nothing else gets in", async () => {
  const { call } = await setup();
  const { token } = await (await call('/api/v1/devices', 'server-a', { kind: 'manager', actor: ravi })).json();
  const r = await (await call('/api/v1/inbox', token, { events: [
    count('c1'),
    count('forged', { ...ravi, id: 'staff-other' }),
    count('lists', ravi, 'stock.tier_set'),
    { id: 'sale', shopId: SHOP, at: 1, orderNumber: 1001, ticketId: 't', type: 'kitchen.seen' },
  ] })).json();
  assert.deepEqual(r.accepted.map((a: { id: string }) => a.id), ['c1']);
  assert.deepEqual(r.rejected.map((x: { id: string }) => x.id), ['forged', 'lists', 'sale']);
  const again = await (await call('/api/v1/inbox', token, { events: [count('c1'), count('c2')] })).json();
  assert.deepEqual(again.accepted.map((a: { id: string }) => a.id), ['c1', 'c2'], 'sending twice is safe');

  assert.equal((await call('/api/v1/inbox', token)).status, 403, 'the phone does not read the inbox');
  const taken = await (await call('/api/v1/inbox?after=0', 'server-a')).json();
  assert.deepEqual(taken.events.map((x: { event: { id: string } }) => x.event.id), ['c1', 'c2']);
  const rest = await (await call(`/api/v1/inbox?after=${taken.lastSeq}`, 'server-a')).json();
  assert.deepEqual(rest.events, []);
  assert.deepEqual((await (await call('/api/v1/inbox?after=0', 'server-b')).json()).events, [], "another shop's server sees nothing");
  assert.equal((await call('/api/v1/inbox', 'server-a', { events: [count('x')] })).status, 403, 'only phones post to it');
});

test('shelf photos: JPEG only, kept with the shop, shown to its server, owner and phones', async () => {
  const { call } = await setup();
  const { token } = await (await call('/api/v1/devices', 'server-a', { kind: 'manager', actor: ravi })).json();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  assert.equal((await call('/api/v1/photos', token, { id: 'ph-abcdefgh12', data: jpeg.toString('base64') })).status, 200);
  assert.equal((await call('/api/v1/photos', token, { id: 'ph-abcdefgh13', data: Buffer.from('<svg/>').toString('base64') })).status, 400);
  assert.equal((await call('/api/v1/photos', 'owner-a', { id: 'ph-abcdefgh14', data: jpeg.toString('base64') })).status, 403);
  for (const who of [token, 'server-a', 'owner-a']) {
    const r = await call('/api/v1/photos/ph-abcdefgh12', who);
    assert.equal(r.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), jpeg);
  }
  assert.equal((await call('/api/v1/photos/ph-abcdefgh12', 'server-b')).status, 404);
});

test('the manager app installs with its key in the address it opens', () => {
  const key = 'k'.repeat(43);
  assert.equal(managerManifest(key).start_url, `/?manager=${key}#manager`);
  assert.equal(managerManifest('../evil').start_url, '/#manager');
  assert.equal(managerManifest(null).name, 'CheesyBeez Manager');
});
