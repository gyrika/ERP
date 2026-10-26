import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.ts';
import { CV_PACK_VERSION, cvPack } from './cvPack.ts';
import { cvSecrets } from './cvSecrets.ts';
import { tablesFromEvents, visionFromEvents } from '../src/domain/tables.ts';
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
  // The printer list is whatever this PC has (and Windows may be slow to tell): not compared.
  const { printers: _printers, ...fresh } = await s.state();
  assert.deepEqual(fresh, { done: false, shop: null, printer: null, cloud: false });

  const named = await s.post('/shop', { name: 'CheesyBeez', place: 'Thalwila' });
  assert.match(named.body.shopId, /^cheesybeez-thalwila-[0-9a-f]{4}$/, 'a short random ending keeps shops apart in the cloud');
  assert.ok((await s.store.deviceByToken(named.body.counterToken))?.kind === 'counter', 'this PC is paired as the counter');
  assert.equal((await s.post('/shop', { name: 'CheesyBeez', place: 'Thalwila' })).body.counterToken, undefined, 'only once');

  await s.post('/staff', { name: 'Nimal', role: 'cashier', pin: '1111' });
  assert.equal((await s.post('/finish')).status, 409, 'no owner yet');
  assert.equal((await s.post('/staff', { name: 'Kamal', role: 'cashier', pin: '1111' })).status, 409, 'PIN taken');
  assert.equal((await s.post('/staff', { name: 'X', role: 'boss', pin: '1234' })).status, 400);
  assert.equal((await s.post('/staff', { name: 'X', role: 'vision', pin: '1234' })).status, 400, 'vision is the camera worker, never a person');
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
  const sent: Record<string, unknown>[] = [];
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
  const secret = s.settings.get().cloudSecret!;
  assert.ok(secret.length >= 40, "the shop's own secret, kept in its settings");
  assert.deepEqual(sent.at(-1), { url: 'https://cloud.test/api/v1/enrol', code: 'CB-7K3M-Q9XZ', shopId, name: 'CheesyBeez Thalwila', secret });
  assert.equal(sent[0].secret, secret, 'the same secret every time: a lost answer can be tried again');
  assert.equal(s.settings.get().cloudToken, 'new-server-token');
  assert.equal(s.connected(), 1, 'copying started straight away');
  assert.equal((await s.state()).cloud, true);
  await s.stop();
});

test("CV pack: status and Activate need the owner's PIN; Activate switches CV on", async () => {
  const s = await start();
  const without = await s.post('/cv/status', {});
  assert.equal(without.status, 409, 'no CV wired in here');
  await s.stop();

  const dir = mkdtempSync(join(tmpdir(), 'cb-setup-cv-'));
  const settings = settingsFile(join(dir, 'settings.json'));
  const cv = cvPack({
    dir: join(dir, 'cv-pack'), appVersion: () => '1.0.40', active: () => settings.get().cvActive === true,
    setActive: (on) => { settings.set({ cvActive: on }); }, fetch: (async () => new Response('Not Found', { status: 404 })) as unknown as typeof fetch,
  });
  const store = memoryStore();
  const setup = setupApi({ store, settings, usePrinter: () => {}, printsDir: join(dir, 'prints'), port: 8080, cloud: () => null, cloudUrl: 'https://cloud.test', cv });
  await setup.nameShop({ name: 'CheesyBeez', place: 'Thalwila' });
  await setup.addStaff({ name: 'Nisal Vimukthi', role: 'owner', pin: '1234' });
  await setup.finish();
  await assert.rejects(setup.cvStatus({ ownerPin: '0000' }), /owner's PIN/);
  assert.deepEqual(await setup.cvStatus({ ownerPin: '1234' }), { active: false, phase: 'idle' });
  assert.equal((await setup.cvActivate({ ownerPin: '1234' })).phase, 'downloading');
  await cv.settled();
  assert.deepEqual(await setup.cvStatus({ ownerPin: '1234' }), { active: true, phase: 'failed', reason: 'GitHub answered 404' });
  assert.equal(settings.get().cvActive, true);
  rmSync(dir, { recursive: true, force: true });
});

test("updates: the owner's PIN after setup; development has nothing to install", async () => {
  const s = await start();
  await s.post('/shop', { name: 'CheesyBeez', place: 'Thalwila' });
  await s.post('/staff', { name: 'Nisal Vimukthi', role: 'owner', pin: '1234' });
  await s.post('/finish');
  assert.equal((await s.post('/update/check', {})).status, 401);
  assert.equal((await s.post('/update/install', { ownerPin: '1234' })).status, 409, 'no updates set up here');
  await s.stop();
});

test('#cameras: the owner sets up cameras, tables, zones and settings as events; logins stay encrypted on this PC', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-setup-cams-'));
  const settings = settingsFile(join(dir, 'settings.json'));
  settings.set({ cvActive: true });
  mkdirSync(join(dir, 'cv-pack', CV_PACK_VERSION), { recursive: true }); // the pack is there
  const cv = cvPack({ dir: join(dir, 'cv-pack'), appVersion: () => '1.0.40', active: () => true, setActive: () => {} });
  cv.start();
  const store = memoryStore();
  const tried: { ffmpeg: string; camera: { ip: string; user?: string; password?: string } }[] = [];
  let server: ReturnType<typeof createApp> | null = null;
  const setup = setupApi({
    store, settings, usePrinter: () => {}, printsDir: join(dir, 'prints'), port: 8080, cloud: () => null, cloudUrl: 'https://cloud.test', cv,
    secrets: cvSecrets(dir), ingest: (device, events) => server!.ingest(device, events),
    discover: async () => [{ ip: '192.168.1.20', name: 'TP-IPC C200' }],
    snapshot: async (o) => {
      tried.push(o);
      return o.camera.password === 'hunter2'
        ? { ok: true, jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }
        : { ok: false, cause: 'login', message: 'The camera refused the login: check the username and password.' };
    },
  });
  server = createApp({ store, setup });
  const named = await setup.nameShop({ name: 'CheesyBeez', place: 'Thalwila' });
  await setup.addStaff({ name: 'Nisal Vimukthi', role: 'owner', pin: '1234' });
  await setup.addStaff({ name: 'Mala', role: 'manager', pin: '2222' });
  const pin = { ownerPin: '1234' };
  await assert.rejects(setup.cvSetup(pin), /finish the shop setup/, 'no owner to act as yet');
  await setup.finish();
  await assert.rejects(setup.cvCameras({ ownerPin: '2222', cameras: [] }), /owner's PIN/, "a manager's PIN will not do");

  assert.deepEqual(await setup.cvScan(pin), { found: [{ ip: '192.168.1.20', name: 'TP-IPC C200' }] });
  const front = { id: 'c1', name: 'Front', ip: '192.168.1.20', rtspPath: '/stream2', enabled: true };
  const wrong = await setup.cvTest({ ...pin, ip: front.ip, rtspPath: front.rtspPath, user: 'admin', password: 'nope' });
  assert.deepEqual(wrong, { ok: false, cause: 'login', message: 'The camera refused the login: check the username and password.' });
  assert.equal((await setup.cvTest({ ...pin, ip: front.ip, rtspPath: front.rtspPath, user: 'admin', password: 'hunter2' })).ok, true);
  assert.equal(tried[0].ffmpeg, join(dir, 'cv-pack', CV_PACK_VERSION, 'ffmpeg.exe'), "the pack's ffmpeg");
  await assert.rejects(setup.cvTest({ ...pin, ip: 'admin:x@192.168.1.20', rtspPath: '/stream2' }), /IP address/);

  const saved = await setup.cvCameras({ ...pin, cameras: [{ ...front, user: 'admin', password: 'hunter2' }, { id: 'c2', name: 'Back', ip: '192.168.1.21', rtspPath: '/stream2', enabled: false, user: 'admin' }] });
  assert.deepEqual(saved.logins, { c1: { user: 'admin', passwordSet: true }, c2: { user: 'admin', passwordSet: false } });
  assert.deepEqual((saved.events[0] as { cameras: unknown }).cameras, [front, { id: 'c2', name: 'Back', ip: '192.168.1.21', rtspPath: '/stream2', enabled: false }]);
  assert.equal((await setup.cvTest({ ...pin, cameraId: 'c1', ip: front.ip, rtspPath: front.rtspPath })).ok, true, 'Test later uses the kept password');
  await assert.rejects(setup.cvCameras({ ...pin, cameras: Array.from({ length: 5 }, (_, i) => ({ ...front, id: `c${i}` })) }), /not valid/, 'never 5 in use');

  await setup.cvTables({ ...pin, tables: [{ id: 't1', label: '1', seats: 4 }, { id: 't2', label: '2', seats: 2 }] });
  await setup.cvZones({ ...pin, cameraId: 'c1', zones: [{ id: 'z1', tableId: 't1', points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.3, y: 0.6 }] }] });
  await assert.rejects(setup.cvZones({ ...pin, cameraId: 'c1', zones: [{ id: 'z1', tableId: 't1', points: [{ x: 0.1, y: 0.1 }, { x: 2, y: 0 }, { x: 0, y: 1 }] }] }), /not valid/);
  await setup.cvSettings({ ...pin, mode: 'shadow', seatS: 60, leaveS: 180, cleanAlertS: 300 });

  const stored = (await store.pull(named.shopId, 0, 100)).map((s) => s.event);
  assert.deepEqual(stored.map((e) => e.type), ['vision.cameras_set', 'table.layout_set', 'vision.zones_set', 'vision.settings_set']);
  assert.ok(stored.every((e) => e.shopId === named.shopId && 'actor' in e && e.actor.role === 'owner' && e.actor.name === 'Nisal Vimukthi'));
  const v = visionFromEvents(stored);
  assert.equal(v.settings.mode, 'shadow');
  assert.deepEqual(tablesFromEvents(stored).map((t) => [t.id, t.watched]), [['t1', true], ['t2', false]]);
  assert.doesNotMatch(JSON.stringify(stored), /hunter2/, 'no password in any event');
  assert.doesNotMatch(readFileSync(join(dir, 'cv-secrets.json'), 'utf8'), /hunter2/);
  assert.equal(cvSecrets(dir).get('c1')?.password, 'hunter2', 'kept for the worker, after a restart too');

  await setup.cvCameras({ ...pin, cameras: [front] });
  assert.deepEqual((await setup.cvSetup(pin)).logins, { c1: { user: 'admin', passwordSet: true } }, 'a removed camera takes its login with it');
  assert.equal((await setup.cvSetup(pin)).packReady, true);
  rmSync(dir, { recursive: true, force: true });
});
