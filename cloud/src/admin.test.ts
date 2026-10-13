import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SyncEvent } from '../../src/domain/sync.ts';
import { accessEmail, adminRoutes, ago, startOfDayColombo, type AccessConfig } from './admin.ts';
import { createCloud, sha256Hex, updateStatus } from './cloud.ts';
import { fakeD1 } from './fakeD1.ts';

const ACCESS: AccessConfig = { team: 'shop-team.cloudflareaccess.com', aud: 'aud-123' };
const NOW = Date.UTC(2026, 9, 14, 12, 0); // 17:30 in Sri Lanka

// A real RS256 signer, like Cloudflare Access, and its public key as Access serves it.
const pair = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' };
const certsFetch = (async (url: string) => {
  assert.equal(url, `https://${ACCESS.team}/cdn-cgi/access/certs`);
  return new Response(JSON.stringify({ keys: [jwk] }));
}) as typeof fetch;
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = async (claims: Record<string, unknown>, kid = 'k1') => {
  const head = `${enc({ alg: 'RS256', kid })}.${enc({ aud: [ACCESS.aud], iss: `https://${ACCESS.team}`, exp: NOW / 1000 + 600, email: 'dev@example.com', ...claims })}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(head));
  return `${head}.${Buffer.from(sig).toString('base64url')}`;
};
const req = (path: string, jwt?: string) =>
  new Request(`https://cloud.test${path}`, { headers: jwt ? { 'cf-access-jwt-assertion': jwt } : {} });

test('only a token Access signed for this app, still valid, lets anyone in', async () => {
  const check = async (jwt: string | undefined) => accessEmail(req('/admin', jwt), ACCESS, certsFetch, NOW);
  assert.equal(await check(await sign({})), 'dev@example.com');
  assert.equal(await check(undefined), null, 'no token');
  assert.equal(await check(await sign({ aud: ['another-app'] })), null, 'another Access app');
  assert.equal(await check(await sign({ iss: 'https://evil.cloudflareaccess.com' })), null, 'another team');
  assert.equal(await check(await sign({ exp: NOW / 1000 - 1 })), null, 'expired');
  assert.equal(await check(await sign({}, 'unknown-key')), null, 'a key Access does not have');
  const [h, p] = (await sign({})).split('.');
  const forged = `${h}.${enc({ aud: [ACCESS.aud], iss: `https://${ACCESS.team}`, exp: NOW / 1000 + 600, email: 'x@y.z' })}.${(await sign({})).split('.')[2]}`;
  assert.equal(await check(forged), null, 'a changed payload breaks the signature');
  assert.ok(h && p);
});

async function setup() {
  const { d1, db } = fakeD1();
  for (const [shop, token] of [['shop-a', 'server-a'], ['shop-b', 'server-b']]) {
    db.prepare('INSERT INTO shops (id, name, created_at) VALUES (?, ?, 0)').run(shop, shop === 'shop-a' ? 'CheesyBeez Thalwila' : 'Test shop');
    db.prepare("INSERT INTO devices (id, tenant_id, kind, token_hash, created_at) VALUES (?, ?, 'shop_server', ?, 0)")
      .run(`dev-${token}`, shop, await sha256Hex(token));
  }
  const cloud = createCloud(d1, { now: () => NOW });
  const admin = (path: string, jwt?: string) => adminRoutes(req(path, jwt), new URL(`https://cloud.test${path}`), {
    db: d1, access: ACCESS, latest: async () => '1.0.5', fetch: certsFetch, now: () => NOW,
    app: async () => new Response('<!doctype html><div id="root"></div>', { headers: { 'content-type': 'text/html' } }),
  });
  return { cloud, admin, db };
}

const paid = (id: string, at: number): SyncEvent =>
  ({ type: 'order.paid', id, shopId: 'shop-a', at, actor: { id: 'c', name: 'Kasun', role: 'cashier' }, orderNumber: 1, total: 150000, tender: 'cash', tendered: 150000 });

test('each copy pass tells the cloud the version and the last update; the admin list shows every shop', async () => {
  const { cloud, admin } = await setup();
  const update = JSON.stringify({ phase: 'done', percent: 100, version: '1.0.4', at: NOW - 5 * 60_000, extra: 'dropped' });
  const r = await cloud(new Request('https://cloud.test/api/v1/replica', {
    method: 'POST',
    headers: { authorization: 'Bearer server-a', 'content-type': 'application/json', 'x-station-version': '1.0.4', 'x-station-update': update },
    body: JSON.stringify({ events: [{ seq: 1, deviceId: 'pc', receivedAt: NOW - 60_000, event: paid('p1', NOW - 60_000) }] }),
  }));
  assert.equal(r.status, 200);

  const page = await (await admin('/admin', await sign({})))!.text();
  assert.match(page, /1 of 2 online · latest release 1\.0\.5 · 1 still to update/);
  assert.match(page, /CheesyBeez Thalwila/);
  assert.match(page, /Version 1\.0\.4 · 1\.0\.5 waiting/);
  assert.match(page, /Updated 1\.0\.4 · 5 min ago/);
  assert.match(page, /Last sale 1 min ago · 1 events today/);
  assert.match(page, /Offline · never/, 'the test shop never checked in');
  assert.ok(page.indexOf('CheesyBeez Thalwila') < page.indexOf('Test shop'), 'online shops first');
});

test('a shop server cannot store anything odd in its status', () => {
  assert.equal(updateStatus('{"phase":"done","percent":100,"version":"1.0.4","at":5}'), '{"phase":"done","percent":100,"version":"1.0.4","at":5}');
  assert.equal(updateStatus('{"phase":"<script>"}'), null);
  assert.equal(updateStatus('not json'), null);
  assert.equal(updateStatus('x'.repeat(600)), null);
  assert.equal(updateStatus('{"phase":"done","version":"<b>"}'), '{"phase":"done","percent":0,"version":"","at":0}');
});

test('the admin reads any shop, and only after Access let it in', async () => {
  const { cloud, admin } = await setup();
  await cloud(new Request('https://cloud.test/api/v1/replica', {
    method: 'POST', headers: { authorization: 'Bearer server-a', 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ seq: 1, deviceId: 'pc', receivedAt: 1, event: paid('p1', 1) }] }),
  }));
  const jwt = await sign({});

  const events = await (await admin('/admin/api/shops/shop-a/events?after=0', jwt))!.json();
  assert.deepEqual(events.events.map((e: { event: SyncEvent }) => e.event.id), ['p1']);
  assert.equal((await admin('/admin/shop/shop-a', jwt))!.status, 200);
  assert.equal((await admin('/admin/shop/no-such-shop', jwt))!.status, 404);

  for (const path of ['/admin', '/admin/api/shops/shop-a/events', '/admin/shop/shop-a']) {
    assert.equal((await admin(path))!.status, 403, `${path} without Access`);
  }
  const closed = await adminRoutes(req('/admin', jwt), new URL('https://cloud.test/admin'), {
    db: fakeD1().d1, access: null, latest: async () => null, app: async () => new Response(''),
  });
  assert.equal(closed!.status, 404, 'not set up: /admin does not exist');
});

test('times read the way the shop lives them', () => {
  assert.equal(new Date(startOfDayColombo(NOW)).toISOString(), '2026-10-13T18:30:00.000Z', 'midnight in Sri Lanka');
  assert.equal(ago(null, NOW), 'never');
  assert.equal(ago(NOW - 20_000, NOW), 'just now');
  assert.equal(ago(NOW - 3 * 3_600_000, NOW), '3 h ago');
  assert.equal(ago(NOW - 3 * 86_400_000, NOW), '3 days ago');
});
