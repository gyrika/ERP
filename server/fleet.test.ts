import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createFleet } from './fleet.ts';
import { memoryStore } from './store.ts';

/** The cloud, as far as the Shops screen asks it: answers only to the right key. */
const cloud = (async (url: string | URL | Request, init?: RequestInit) => {
  const auth = new Headers(init?.headers).get('authorization');
  if (auth !== 'Bearer the-admin-password') return new Response('{}', { status: 403 });
  const path = new URL(String(url)).pathname + new URL(String(url)).search;
  if (path === '/admin/api/shops') return Response.json({ shops: [{ id: 'shop-a', name: 'CheesyBeez Thalwila' }], latest: '1.0.5' });
  if (path === '/admin/api/shops/shop-a/events?after=0&limit=500') return Response.json({ events: [], lastSeq: 0, more: false, serverTime: 1 });
  return new Response('{}', { status: 404 });
}) as typeof fetch;

async function start(key: string | null) {
  const fleet = key ? createFleet({ url: 'https://cloud.test', key, fetch: cloud }) : null;
  const server = createApp({ store: memoryStore(), fleet, now: () => 5000 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { get: (path: string) => fetch(`${base}${path}`), stop: () => new Promise<void>((r) => server.close(() => r())) };
}

test('with the admin password, this computer sees every shop and a shop\'s events', async () => {
  const s = await start('the-admin-password');
  assert.deepEqual(await (await s.get('/api/v1/fleet')).json(), { available: true });
  assert.equal((await (await s.get('/api/v1/fleet/shops')).json()).shops[0].name, 'CheesyBeez Thalwila');
  assert.equal((await s.get('/api/v1/fleet/shops/shop-a/events?after=0')).status, 200);
  await s.stop();
});

test('a shop PC (no password) has no Shops screen; a wrong password says what to do', async () => {
  const none = await start(null);
  assert.equal((await none.get('/api/v1/fleet')).status, 404);
  assert.equal((await none.get('/api/v1/fleet/shops')).status, 404);
  await none.stop();

  const wrong = await start('an-old-password');
  const r = await wrong.get('/api/v1/fleet/shops');
  assert.equal(r.status, 502);
  assert.match((await r.json()).message, /npm run admin-key/);
  await wrong.stop();
});
