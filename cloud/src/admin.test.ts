import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SyncEvent } from '../../src/domain/sync.ts';
import { adminRoutes, ago, signedIn, startOfDayColombo } from './admin.ts';
import { createCloud, sha256Hex, updateStatus } from './cloud.ts';
import { fakeD1 } from './fakeD1.ts';

const KEY = 'k'.repeat(10) + 'Zq3_-x9PpLm2Vb8RtYw4Nc7Hs1Df6Gj0Ae5'; // 45 characters, like the generated one
const NOW = Date.UTC(2026, 9, 14, 12, 0); // 17:30 in Sri Lanka

const req = (path: string, init: RequestInit & { session?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.session) headers.set('cookie', init.session);
  return new Request(`https://cloud.test${path}`, { ...init, headers });
};
const login = (key: string) => req('/admin/login', {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ key }),
});
/** The session from a Set-Cookie header, as a browser sends it back. */
const sessionOf = (r: Response) => r.headers.get('set-cookie')!.split(';')[0];

async function setup() {
  const { d1, db } = fakeD1();
  for (const [shop, token] of [['shop-a', 'server-a'], ['shop-b', 'server-b']]) {
    db.prepare('INSERT INTO shops (id, name, created_at) VALUES (?, ?, 0)').run(shop, shop === 'shop-a' ? 'CheesyBeez Thalwila' : 'Test shop');
    db.prepare("INSERT INTO devices (id, tenant_id, kind, token_hash, created_at) VALUES (?, ?, 'shop_server', ?, 0)")
      .run(`dev-${token}`, shop, await sha256Hex(token));
  }
  const cloud = createCloud(d1, { now: () => NOW });
  const admin = (r: Request) => adminRoutes(r, new URL(r.url), {
    db: d1, key: KEY, latest: async () => '1.0.5', now: () => NOW,
    // Like Cloudflare's static files: '/index.html' answers with a redirect to '/'.
    app: async (r: Request) => new URL(r.url).pathname === '/'
      ? new Response('<!doctype html><div id="root"></div>', { headers: { 'content-type': 'text/html' } })
      : new Response(null, { status: 307, headers: { location: '/' } }),
  });
  const session = sessionOf((await admin(login(KEY)))!);
  return { cloud, admin, db, session };
}

const paid = (id: string, at: number): SyncEvent =>
  ({ type: 'order.paid', id, shopId: 'shop-a', at, actor: { id: 'c', name: 'Kasun', role: 'cashier' }, orderNumber: 1, total: 150000, tender: 'cash', tendered: 150000 });

test('each copy pass tells the cloud the version and the last update; the admin list shows every shop', async () => {
  const { cloud, admin, session } = await setup();
  const update = JSON.stringify({ phase: 'done', percent: 100, version: '1.0.4', at: NOW - 5 * 60_000, extra: 'dropped' });
  const r = await cloud(new Request('https://cloud.test/api/v1/replica', {
    method: 'POST',
    headers: { authorization: 'Bearer server-a', 'content-type': 'application/json', 'x-station-version': '1.0.4', 'x-station-update': update },
    body: JSON.stringify({ events: [{ seq: 1, deviceId: 'pc', receivedAt: NOW - 60_000, event: paid('p1', NOW - 60_000) }] }),
  }));
  assert.equal(r.status, 200);

  const page = await (await admin(req('/admin', { session })))!.text();
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

test('the admin reads any shop, and only once signed in', async () => {
  const { cloud, admin, session } = await setup();
  await cloud(new Request('https://cloud.test/api/v1/replica', {
    method: 'POST', headers: { authorization: 'Bearer server-a', 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ seq: 1, deviceId: 'pc', receivedAt: 1, event: paid('p1', 1) }] }),
  }));

  const events = await (await admin(req('/admin/api/shops/shop-a/events?after=0', { session })))!.json();
  assert.deepEqual(events.events.map((e: { event: SyncEvent }) => e.event.id), ['p1']);
  const shopPage = (await admin(req('/admin/shop/shop-a', { session })))!;
  assert.equal(shopPage.status, 200, 'the app itself, never a redirect off the shop\'s address');
  assert.match(await shopPage.text(), /id="root"/);
  assert.equal((await admin(req('/admin/shop/no-such-shop', { session })))!.status, 404);

  for (const path of ['/admin/api/shops/shop-a/events', '/admin/shop/shop-a']) {
    assert.equal((await admin(req(path)))!.status, 403, `${path} without signing in`);
  }
  const box = await (await admin(req('/admin')))!.text();
  assert.match(box, /Admin password/, 'not signed in: the sign-in box');
  assert.doesNotMatch(box, /CheesyBeez Thalwila/, '...and nothing about any shop');
});

test('signing in: the right password gives a 30-day session cookie no script can read; nothing else does', async () => {
  const { admin } = await setup();
  const ok = (await admin(login(`  ${KEY}\n`)))!; // pasted with spaces around
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/admin');
  const set = ok.headers.get('set-cookie')!;
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/admin', `Max-Age=${30 * 86_400}`]) assert.ok(set.includes(flag), flag);
  assert.ok(!set.includes(KEY), 'the password itself is never in the cookie');

  const wrong = (await admin(login(KEY.slice(0, -1) + 'x')))!;
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get('set-cookie'), null);
  assert.match(await wrong.text(), /That password is not right/);

  const session = sessionOf(ok);
  assert.equal(await signedIn(req('/admin', { session }), KEY, NOW), true);
  const [until, sig] = session.split('=')[1].split('.');
  assert.equal(await signedIn(req('/admin', { session: `cb_admin=${Number(until) + 1}.${sig}` }), KEY, NOW), false, 'a longer session, forged');
  assert.equal(await signedIn(req('/admin', { session }), KEY, Number(until) + 1), false, 'after 30 days');
  assert.equal(await signedIn(req('/admin', { session }), 'another-key-'.repeat(4), NOW), false, 'a new password signs everyone out');

  const out = (await admin(req('/admin/logout', { method: 'POST', session })))!;
  assert.match(out.headers.get('set-cookie')!, /^cb_admin=; .*Max-Age=0/);
});

test('without a password, or with a short one, /admin does not exist', async () => {
  for (const key of [null, 'short-password']) {
    const r = await adminRoutes(req('/admin'), new URL('https://cloud.test/admin'), {
      db: fakeD1().d1, key, latest: async () => null, app: async () => new Response(''),
    });
    assert.equal(r!.status, 404);
  }
});

test('times read the way the shop lives them', () => {
  assert.equal(new Date(startOfDayColombo(NOW)).toISOString(), '2026-10-13T18:30:00.000Z', 'midnight in Sri Lanka');
  assert.equal(ago(null, NOW), 'never');
  assert.equal(ago(NOW - 20_000, NOW), 'just now');
  assert.equal(ago(NOW - 3 * 3_600_000, NOW), '3 h ago');
  assert.equal(ago(NOW - 3 * 86_400_000, NOW), '3 days ago');
});
