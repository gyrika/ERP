import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mayRecord } from '../src/domain/auth.ts';
import { withoutTestData } from '../src/domain/freshStart.ts';
import { modulesFromEvents, type ModuleEvent } from '../src/domain/modules.ts';
import { createApp } from './app.ts';
import { MODULE_PASSWORD, modulePasswordMatches } from './modules.ts';
import { hashPin } from './pins.ts';
import { settingsFile } from './settings.ts';
import { setupApi } from './setup.ts';
import { memoryStore } from './store.ts';
import { validatePush } from './validate.ts';

const NOW = Date.UTC(2026, 10, 11, 6, 0);
const SHOP = 'cheesybeez-thalwila-a1b2';
const TEST_PASSWORD = 'test-only-password';

test('the real password is only a salted hash in the code', () => {
  assert.match(MODULE_PASSWORD.salt, /^[0-9a-f]{32}$/);
  assert.match(MODULE_PASSWORD.hash, /^[0-9a-f]{64}$/);
  // The line holds the salt and the hash, nothing else.
  const source = readFileSync(new URL('./modules.ts', import.meta.url), 'utf8');
  assert.match(source, /^export const MODULE_PASSWORD = \{ salt: '[0-9a-f]{32}', hash: '[0-9a-f]{64}' \} as const;$/m);
});

test('a password matches its hash, and nothing else does', async () => {
  const hash = await hashPin(TEST_PASSWORD);
  assert.equal(await modulePasswordMatches(TEST_PASSWORD, hash), true);
  for (const wrong of ['', 'test-only-Password', `${TEST_PASSWORD} `, 'x'.repeat(201), null, 42]) {
    assert.equal(await modulePasswordMatches(wrong, hash), false, String(wrong));
  }
});

test('no device or person may record a module change; only the shop server', () => {
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

test('#unlock on the shop PC: the password turns the CRM on and off; wrong ones are slowed; a device cannot push it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-modules-'));
  const store = memoryStore();
  let clock = NOW;
  let server: ReturnType<typeof createApp> | null = null;
  const setup = setupApi({
    store, settings: settingsFile(join(dir, 'settings.json')), usePrinter: () => {}, printsDir: join(dir, 'prints'), port: 8080,
    cloud: () => null, cloudUrl: 'https://cloud.test', ingest: (device, events) => server!.ingest(device, events), now: () => clock,
    modulePassword: await hashPin(TEST_PASSWORD),
  });
  server = createApp({ store, setup, now: () => clock });
  const { shopId } = await setup.nameShop({ name: 'CheesyBeez', place: 'Thalwila' });
  await setup.addStaff({ name: 'Owner', role: 'owner', pin: '1234' });
  await setup.finish();

  assert.deepEqual(await setup.modules(), { shopId, modules: [{ id: 'crm', on: false, since: null }] });
  await assert.rejects(setup.unlockModule({ password: TEST_PASSWORD, module: 'payroll', on: true }), /which module/);
  await assert.rejects(setup.unlockModule({ password: TEST_PASSWORD, module: 'crm' }), /which module/);
  await assert.rejects(setup.unlockModule({ password: '1234', module: 'crm', on: true }), /not the developers' password/, "the owner's PIN will not do");

  const done = await setup.unlockModule({ password: TEST_PASSWORD, module: 'crm', on: true });
  assert.deepEqual({ module: done.module, on: done.on }, { module: 'crm', on: true });
  assert.equal((done.events[0] as ModuleEvent).actor.id, 'developers', 'filed under the developers, never a person at the shop');
  assert.deepEqual((await setup.modules()).modules, [{ id: 'crm', on: true, since: clock }]);

  clock += 60_000;
  await setup.unlockModule({ password: TEST_PASSWORD, module: 'crm', on: false });
  assert.deepEqual((await setup.modules()).modules, [{ id: 'crm', on: false, since: clock }]);

  // Guessing: 5 wrong, then even the right one waits 30 s.
  for (let i = 0; i < 5; i++) await assert.rejects(setup.unlockModule({ password: `guess${i}`, module: 'crm', on: true }), /not the developers' password/);
  await assert.rejects(setup.unlockModule({ password: TEST_PASSWORD, module: 'crm', on: true }), /too many wrong passwords/);
  clock += 31_000;
  assert.equal((await setup.unlockModule({ password: TEST_PASSWORD, module: 'crm', on: true })).on, true);

  // The counter cannot push one, whoever is signed in.
  const { token } = await store.addDevice(shopId, 'CheesyBeez', 'counter');
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/events`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ events: [{
      id: 'sneaky', shopId, at: clock, orderNumber: 0, actor: { id: 'o', name: 'Owner', role: 'owner' },
      type: 'shop.module_set', module: 'crm', on: false, codeId: 'fedcba9876543210',
    }] }),
  });
  assert.match(JSON.stringify(await res.json()), /developer/);
  assert.equal((await setup.modules()).modules[0].on, true);

  await new Promise((r) => server!.close(r));
  rmSync(dir, { recursive: true, force: true });
});
