import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mayRecord } from '../src/domain/auth.ts';
import { withoutTestData } from '../src/domain/freshStart.ts';
import { modulesFromEvents, type ModuleEvent } from '../src/domain/modules.ts';
import { createApp } from './app.ts';
import { CODE_PREFIX, grantFor, newModuleKeys, readModuleCode, signModuleCode } from './modules.ts';
import { settingsFile } from './settings.ts';
import { setupApi } from './setup.ts';
import { memoryStore } from './store.ts';
import { validatePush } from './validate.ts';

const NOW = Date.UTC(2026, 10, 11, 6, 0);
const keys = newModuleKeys();
const other = newModuleKeys();
const SHOP = 'cheesybeez-thalwila-a1b2';

test('a code says what it grants, and only for the shop and week it was made for, once', () => {
  const grant = grantFor(SHOP, 'crm', true, NOW);
  const code = signModuleCode(grant, keys.privateKeyPem);
  assert.ok(code.startsWith(CODE_PREFIX));
  assert.deepEqual(readModuleCode(code, keys.publicKeyPem, SHOP, new Set(), NOW), { grant });
  // Pasted with line breaks and spaces (AnyDesk, chat apps): still the same code.
  const pasted = `  ${code.slice(0, 40)}\n${code.slice(40, 90)} ${code.slice(90)}\r\n`;
  assert.deepEqual(readModuleCode(pasted, keys.publicKeyPem, SHOP, new Set(), NOW), { grant });

  const why = (c: unknown, opts: { key?: string | null; shop?: string; used?: string[]; at?: number } = {}) => {
    const r = readModuleCode(c, opts.key === undefined ? keys.publicKeyPem : opts.key, opts.shop ?? SHOP, new Set(opts.used ?? []), opts.at ?? NOW);
    return 'reason' in r ? r.reason : 'accepted';
  };
  assert.match(why(code, { shop: 'another-shop' }), /another shop/);
  assert.match(why(code, { used: [grant.id] }), /already used/);
  assert.match(why(code, { at: grant.until + 1 }), /run out/);
  assert.equal(why(code, { at: grant.until }), 'accepted', 'the last moment still counts');
  assert.match(why(code, { key: other.publicKeyPem }), /not signed by the developers/);
  assert.match(why(code, { key: null }), /no developer key/);
  assert.match(why(signModuleCode(grant, other.privateKeyPem)), /not signed by the developers/, 'someone else\'s key');
  for (const junk of ['', '   ', 'hello', 'CB1.abc', 'CB1.a.b.c', 42, null]) assert.notEqual(why(junk), 'accepted', String(junk));
});

test('a changed code is refused: turning off into on, or this shop into another, breaks the signature', () => {
  const code = signModuleCode(grantFor(SHOP, 'crm', false, NOW), keys.privateKeyPem);
  const [, payload, sig] = code.split('.');
  const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const forged = `${CODE_PREFIX}${Buffer.from(JSON.stringify({ ...json, on: true }), 'utf8').toString('base64url')}.${sig}`;
  const r = readModuleCode(forged, keys.publicKeyPem, SHOP, new Set(), NOW);
  assert.ok('reason' in r && /not signed/.test(r.reason));
});

test('a signed code that grants nothing this version knows is refused with the reason', () => {
  const sign = (g: object) => readModuleCode(signModuleCode(g as never, keys.privateKeyPem), keys.publicKeyPem, SHOP, new Set(), NOW);
  const good = grantFor(SHOP, 'crm', true, NOW);
  assert.match(String((sign({ ...good, module: 'payroll' }) as { reason: string }).reason), /module this version does not have/);
  assert.match(String((sign({ ...good, v: 2 }) as { reason: string }).reason), /newer version/);
  assert.match(String((sign({ ...good, on: 'yes' }) as { reason: string }).reason), /neither on nor off/);
});

test('no device or person may record a module change; only the shop server, from a code', () => {
  for (const role of ['cashier', 'manager', 'owner', 'kitchen', 'vision'] as const) assert.equal(mayRecord(role, 'shop.module_set'), false, role);
  const e = (over: object = {}) => ({
    id: 'm1', shopId: SHOP, at: NOW, orderNumber: 0, actor: { id: 'developers', name: 'CheesyBeez developers', role: 'owner' },
    type: 'shop.module_set', module: 'crm', on: true, codeId: '0123456789abcdef', ...over,
  });
  assert.ok('events' in validatePush({ events: [e()] }, SHOP));
  assert.ok('reason' in validatePush({ events: [e({ module: 'payroll' })] }, SHOP));
  assert.ok('reason' in validatePush({ events: [e({ on: 1 })] }, SHOP));
  assert.ok('reason' in validatePush({ events: [e({ codeId: 'x' })] }, SHOP));
  assert.ok('reason' in validatePush({ events: [e({ orderNumber: 5 })] }, SHOP));
});

test('modules: all off at first, the latest change wins, and clearing test data keeps them', () => {
  const change = (on: boolean, at: number): ModuleEvent => ({
    id: `m${at}`, shopId: SHOP, at, orderNumber: 0, actor: { id: 'developers', name: 'Developers', role: 'owner' },
    type: 'shop.module_set', module: 'crm', on, codeId: '0123456789abcdef',
  });
  assert.deepEqual(modulesFromEvents([]), { crm: false });
  assert.deepEqual(modulesFromEvents([change(true, 1)]), { crm: true });
  assert.deepEqual(modulesFromEvents([change(true, 1), change(false, 2)]), { crm: false });
  const fresh = { id: 'f', shopId: SHOP, at: 10, orderNumber: 0 as const, actor: { id: 'o', name: 'Owner', role: 'owner' as const }, type: 'shop.started_fresh' as const, before: 5 };
  assert.deepEqual(modulesFromEvents(withoutTestData([change(true, 1), fresh])), { crm: true }, 'a module is setup, not test activity');
});

test('#unlock on the shop PC: the shop id, then a developer code turns the CRM on once; a device cannot push it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-modules-'));
  const store = memoryStore();
  let clock = NOW;
  let server: ReturnType<typeof createApp> | null = null;
  const setup = setupApi({
    store, settings: settingsFile(join(dir, 'settings.json')), usePrinter: () => {}, printsDir: join(dir, 'prints'), port: 8080,
    cloud: () => null, cloudUrl: 'https://cloud.test', ingest: (device, events) => server!.ingest(device, events), now: () => clock,
    modulePublicKey: keys.publicKeyPem,
  });
  server = createApp({ store, setup, now: () => clock });
  const { shopId } = await setup.nameShop({ name: 'CheesyBeez', place: 'Thalwila' });
  await setup.addStaff({ name: 'Owner', role: 'owner', pin: '1234' });
  await setup.finish();

  assert.deepEqual(await setup.modules(), { shopId, keyed: true, modules: [{ id: 'crm', on: false, since: null }] });

  const on = signModuleCode(grantFor(shopId, 'crm', true, clock), keys.privateKeyPem);
  await assert.rejects(setup.unlockModule({ code: signModuleCode(grantFor('another-shop', 'crm', true, clock), keys.privateKeyPem) }), /another shop/);
  const done = await setup.unlockModule({ code: on });
  assert.deepEqual({ module: done.module, on: done.on }, { module: 'crm', on: true });
  assert.equal((done.events[0] as ModuleEvent).actor.id, 'developers', 'filed under the developers, never a person at the shop');
  assert.deepEqual((await setup.modules()).modules, [{ id: 'crm', on: true, since: clock }]);
  await assert.rejects(setup.unlockModule({ code: on }), /already used/, 'one time only');

  clock += 60_000;
  await setup.unlockModule({ code: signModuleCode(grantFor(shopId, 'crm', false, clock), keys.privateKeyPem) });
  assert.deepEqual((await setup.modules()).modules, [{ id: 'crm', on: false, since: clock }]);

  // The counter cannot push one, whoever is signed in.
  const pushed = {
    id: 'sneaky', shopId, at: clock, orderNumber: 0, actor: { id: 'o', name: 'Owner', role: 'owner' },
    type: 'shop.module_set', module: 'crm', on: true, codeId: 'fedcba9876543210',
  };
  const { token } = await store.addDevice(shopId, 'CheesyBeez', 'counter');
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/events`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ events: [pushed] }),
  });
  const body = await res.json() as { rejected?: { id: string; reason: string }[]; error?: string; message?: string };
  assert.match(JSON.stringify(body), /developer code on the shop PC/);
  assert.deepEqual((await setup.modules()).modules[0].on, false);

  // A shop on a version with no key cannot change modules at all.
  const unkeyed = setupApi({
    store, settings: settingsFile(join(dir, 'settings.json')), usePrinter: () => {}, printsDir: join(dir, 'prints'), port: 8080,
    cloud: () => null, cloudUrl: 'https://cloud.test', ingest: (d, e) => server!.ingest(d, e), now: () => clock, modulePublicKey: null,
  });
  assert.equal((await unkeyed.modules()).keyed, false);
  await assert.rejects(unkeyed.unlockModule({ code: on }), /no developer key/);

  await new Promise((r) => server!.close(r));
  rmSync(dir, { recursive: true, force: true });
});
