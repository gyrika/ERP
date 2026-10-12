import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.ts';
import { dryRunPrinter } from './printer.ts';
import { settingsFile } from './settings.ts';
import { isLocal, setupApi, shopIdFor } from './setup.ts';
import { memoryStore } from './store.ts';

async function start(cloudFetch?: typeof fetch, preConnected = Boolean(cloudFetch)) {
  let connected = 0;
  const dir = mkdtempSync(join(tmpdir(), 'cb-setup-'));
  const store = memoryStore();
  const settings = settingsFile(join(dir, 'settings.json'));
  const setup = setupApi({
    store, settings, usePrinter: () => {}, printsDir: join(dir, 'prints'), port: 8080,
    cloud: () => (preConnected ? { url: 'https://cloud.test', token: 'server-token' } : (settings.get().cloudToken
      ? { url: settings.get().cloudUrl!, token: settings.get().cloudToken! } : null)),
    cloudUrl: 'https://cloud.test', fetch: cloudFetch, onCloudConnected: () => { connected += 1; },
  });
  const server = createApp({ store, printer: dryRunPrinter(join(dir, 'prints')), setup });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/setup`;
  const post = async (step: string, body: unknown = {}) => {
    const r = await fetch(base + step, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const state = async () => (await fetch(base)).json();
  const stop = async () => { await new Promise<void>((r) => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); };
  return { post, state, stop, store, settings, connected: () => connected };
}

test('a new shop: name it (this PC becomes the counter), add staff, finish only with an owner', async () => {
  const s = await start();
  assert.deepEqual(await s.state(), { done: false, shop: null, printer: null, printers: (await s.state()).printers, cloud: false });

  const named = await s.post('/shop', { name: 'CheesyBeez', place: 'Thalwila' });
  assert.match(named.body.shopId, /^cheesybeez-thalwila-[0-9a-f]{4}$/, 'a short random ending keeps shops apart in the cloud');
  assert.ok((await s.store.deviceByToken(named.body.counterToken))?.kind === 'counter', 'this PC is paired as the counter');
  assert.equal((await s.post('/shop', { name: 'CheesyBeez', place: 'Thalwila' })).body.counterToken, undefined, 'only once');

  await s.post('/staff', { name: 'Nimal', role: 'cashier', pin: '1111' });
  assert.equal((await s.post('/finish')).status, 409, 'no owner yet');
  assert.equal((await s.post('/staff', { name: 'Kamal', role: 'cashier', pin: '1111' })).status, 409, 'PIN taken');
  assert.equal((await s.post('/staff', { name: 'X', role: 'boss', pin: '1234' })).status, 400);
  const added = await s.post('/staff', { name: 'Nisal Vimukthi', role: 'owner', pin: '1234' });
  assert.deepEqual(added.body.staff.map((m: { name: string }) => m.name).sort(), ['Nimal', 'Nisal Vimukthi']);
  assert.equal((await s.post('/finish')).status, 200);
  assert.equal((await s.state()).done, true);
  assert.equal((await s.state()).staff, undefined, 'after setup the staff list needs the PIN');
  await s.stop();
});

test("after setup every change needs the owner's PIN; a manager's will not do", async () => {
  const s = await start();
  await s.post('/shop', { name: 'CheesyBeez', place: 'Thalwila' });
  await s.post('/staff', { name: 'Nisal Vimukthi', role: 'owner', pin: '1234' });
  await s.post('/staff', { name: 'Ravi', role: 'manager', pin: '2580' });
  await s.post('/finish');

  assert.equal((await s.post('/staff', { name: 'Kamal', role: 'cashier', pin: '3333' })).status, 401);
  assert.equal((await s.post('/staff', { name: 'Kamal', role: 'cashier', pin: '3333', ownerPin: '2580' })).status, 401);
  const ok = await s.post('/staff', { name: 'Kamal', role: 'cashier', pin: '3333', ownerPin: '1234' });
  assert.equal(ok.status, 200);
  const owner = ok.body.staff.find((m: { name: string }) => m.name === 'Nisal Vimukthi');
  assert.equal((await s.post('/staff/remove', { id: owner.id, ownerPin: '1234' })).status, 409, 'the last owner stays');
  assert.equal((await s.post('/shop', { name: 'Other' })).status, 409, 'the shop is not renamed by the wizard again');
  await s.stop();
});

test('QR links: a kitchen tablet on the Wi-Fi, an owner phone via the cloud', async () => {
  const cloudCalls: string[] = [];
  const cloud = (async (url: string | URL | Request, init?: RequestInit) => {
    cloudCalls.push(`${init?.method} ${String(url)} ${(init?.headers as Record<string, string>).authorization}`);
    return Response.json({ id: 'cloud-x', token: 'phone-token' });
  }) as typeof fetch;
  const s = await start(cloud);
  await s.post('/shop', { name: 'CheesyBeez', place: 'Thalwila' });

  const kitchen = await s.post('/pair', { kind: 'kitchen' });
  if (kitchen.status === 200) {
    assert.match(kitchen.body.link, /^http:\/\/[\d.]+:8080\/\?pair=[\w-]+&shop=cheesybeez-thalwila-[0-9a-f]{4}&as=kitchen#kitchen$/);
  } else {
    assert.equal(kitchen.body.error, 'not_ready'); // a machine with no network at all
  }
  const phone = await s.post('/pair', { kind: 'owner' });
  assert.equal(phone.body.link, 'https://cloud.test/?owner=phone-token#owner');
  assert.deepEqual(cloudCalls, ['POST https://cloud.test/api/v1/devices Bearer server-token']);
  await s.stop();

  const noCloud = await start();
  await noCloud.post('/shop', { name: 'CheesyBeez' });
  assert.equal((await noCloud.post('/pair', { kind: 'owner' })).status, 409);
  await noCloud.stop();
});

test('only the shop PC itself may set up', () => {
  const req = (remoteAddress: string) => ({ socket: { remoteAddress } }) as unknown as IncomingMessage;
  assert.equal(isLocal(req('127.0.0.1')), true);
  assert.equal(isLocal(req('::1')), true);
  assert.equal(isLocal(req('192.168.1.20')), false, 'a tablet on the Wi-Fi');
  assert.equal(shopIdFor('CheesyBeez', 'Thalwila'), 'cheesybeez-thalwila');
  assert.equal(shopIdFor('Café  Ño!', ''), 'cafe-no');
});

test('the cloud step: the shop code connects this shop, and copying starts without a restart', async () => {
  const sent: unknown[] = [];
  const cloud = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    sent.push({ url: String(url), ...body });
    return body.code === 'CB-7K3M-Q9XZ' ? Response.json({ token: 'new-server-token' }) : Response.json({}, { status: 403 });
  }) as typeof fetch;
  const s = await start(cloud, false);
  const { body: { shopId } } = await s.post('/shop', { name: 'CheesyBeez', place: 'Thalwila' });
  assert.equal((await s.state()).cloud, false);

  const wrong = await s.post('/cloud', { code: 'NOPE' });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.message, 'that shop code is not right');
  assert.equal((await s.post('/cloud', { code: 'CB-7K3M-Q9XZ' })).status, 200);
  assert.deepEqual(sent.at(-1), { url: 'https://cloud.test/api/v1/enrol', code: 'CB-7K3M-Q9XZ', shopId, name: 'CheesyBeez Thalwila' });
  assert.equal(s.settings.get().cloudToken, 'new-server-token');
  assert.equal(s.connected(), 1, 'copying started straight away');
  assert.equal((await s.state()).cloud, true);
  await s.stop();
});
