import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import ExcelJS from 'exceljs';
import { FAKE_CUSTOMER_SHEET } from '../../src/fake/data.ts';
import type { ModuleEvent } from '../../src/domain/modules.ts';
import { createApp } from '../app.ts';
import { memoryStore } from '../store.ts';
import { crmApi } from './routes.ts';
import { memoryCustomers } from './store.ts';

const T0 = Date.UTC(2026, 10, 11, 6, 0);

const xlsx = async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Customers');
  FAKE_CUSTOMER_SHEET.forEach((r, i) => { sheet.getRow(i + 1).values = r.map((v) => v ?? null); });
  return Buffer.from(await book.xlsx.writeBuffer());
};

async function shop() {
  const clock = { now: T0 };
  const store = memoryStore();
  const customers = memoryCustomers();
  const server = createApp({ store, crm: crmApi({ events: store, customers, now: () => clock.now }), now: () => clock.now });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/crm`;
  const SHOP = 'cheesybeez-thalwila-a1b2';
  const counter = await store.addDevice(SHOP, 'CheesyBeez', 'counter');
  const kitchen = await store.addDevice(SHOP, 'CheesyBeez', 'kitchen');
  const owner = await store.addStaff(SHOP, 'Owner', 'owner', '1234');
  const manager = await store.addStaff(SHOP, 'Mala', 'manager', '2222');
  const cashier = await store.addStaff(SHOP, 'Nimal', 'cashier', '1111');
  for (const p of [owner, manager, cashier]) await store.startSession(counter.device, p, T0 - 60_000, T0 + 8 * 3_600_000);

  const setModule = async (on: boolean) => {
    const e: ModuleEvent = {
      id: `mod-${clock.now}-${on}`, shopId: SHOP, at: clock.now, orderNumber: 0, actor: { id: 'developers', name: 'Developers', role: 'owner' },
      type: 'shop.module_set', module: 'crm', on, codeId: (on ? 'a' : 'b').repeat(16),
    };
    await server.ingest(counter.device, [e]);
  };
  const call = async (path: string, opts: { staff?: string; token?: string; body?: Buffer; name?: string; rename?: boolean } = {}) => {
    const q = new URLSearchParams({ name: opts.name ?? 'customers.xlsx', ...(opts.rename ? { rename: '1' } : {}) });
    const r = await fetch(`${base}${path}${opts.body ? `?${q}` : ''}`, {
      method: opts.body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${opts.token ?? counter.token}`, ...(opts.staff ? { 'x-staff-id': opts.staff } : {}) },
      body: opts.body ? new Uint8Array(opts.body) : undefined,
    });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };
  const stop = () => new Promise<void>((r) => server.close(() => r()));
  return { call, setModule, stop, clock, owner, manager, cashier, kitchen, customers, SHOP };
}

test('off by default: every CRM route is "no such page", whoever asks', async () => {
  const s = await shop();
  for (const r of [await s.call('/count', { staff: s.owner.id }), await s.call('/import/preview', { staff: s.owner.id, body: await xlsx() })]) {
    assert.equal(r.status, 404);
  }
  await s.stop();
});

test('on: a manager or the owner signed in on the counter imports; everyone else is told why not', async () => {
  const s = await shop();
  await s.setModule(true);
  const file = await xlsx();
  assert.equal((await s.call('/count')).status, 401, 'nobody signed in');
  assert.equal((await s.call('/count', { staff: 'staff-nobody' })).status, 401);
  assert.equal((await s.call('/count', { staff: s.cashier.id })).status, 403, 'a cashier');
  assert.equal((await s.call('/count', { staff: s.owner.id, token: s.kitchen.token })).status, 403, 'the kitchen tablet');
  assert.equal((await s.call('/count', { staff: s.owner.id, token: 'not-a-device' })).status, 401);
  assert.deepEqual((await s.call('/count', { staff: s.manager.id })).body, { customers: 0 });

  // Preview: the whole plan, nothing saved.
  const preview = await s.call('/import/preview', { staff: s.manager.id, body: file });
  assert.equal(preview.status, 200);
  const plan = preview.body.plan as { report: Record<string, number>; rows: unknown[] };
  assert.equal(plan.report.added, 36);
  assert.equal(plan.rows.length, 44);
  assert.deepEqual((await s.call('/count', { staff: s.manager.id })).body, { customers: 0 });

  // Save: what the preview said.
  const saved = await s.call('/import/save', { staff: s.manager.id, body: file });
  assert.deepEqual(saved.body.saved, { added: 36, updated: 0 });
  assert.equal(saved.body.customers, 36);
  // Saved twice (a double tap, or the same file next week): nobody twice.
  const twice = await s.call('/import/save', { staff: s.owner.id, body: file });
  assert.deepEqual(twice.body.saved, { added: 0, updated: 0 });
  assert.equal((twice.body.plan as { report: { unchanged: number } }).report.unchanged, 36);

  // A file that is not a list: the reason, nothing saved.
  const bad = await s.call('/import/save', { staff: s.owner.id, body: Buffer.from('Name\nKasun\n'), name: 'names.csv' });
  assert.equal(bad.status, 400);
  assert.match(String(bad.body.message), /no column of phone numbers/);
  const old = await s.call('/import/preview', { staff: s.owner.id, body: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0]), name: 'old.xls' });
  assert.match(String(old.body.message), /Save As \.xlsx/);

  // The session ran out: signed out, whoever they were.
  s.clock.now = T0 + 9 * 3_600_000;
  assert.equal((await s.call('/count', { staff: s.owner.id })).status, 401);

  // The developers turn it off: the routes go, the customers stay for when it is back on.
  s.clock.now = T0 + 60_000;
  await s.setModule(false);
  assert.equal((await s.call('/count', { staff: s.owner.id })).status, 404);
  assert.equal((await s.customers.list(s.SHOP)).length, 36);
  s.clock.now = T0 + 120_000;
  await s.setModule(true);
  assert.deepEqual((await s.call('/count', { staff: s.owner.id })).body, { customers: 36 });
  await s.stop();
});
