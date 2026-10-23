import test from 'node:test';
import assert from 'node:assert/strict';
import type { SyncEvent } from '../src/domain/sync.ts';
import { createNumberer } from './numbering.ts';
import { memoryStore, type Device, type EventStore } from './store.ts';

const actor = { id: 'm', name: 'Ravi', role: 'manager' as const };
const po = (id: string, shop = 'shop-a', extra: object = {}): SyncEvent =>
  ({ id, shopId: shop, at: 1, orderNumber: 0, actor, type: 'stock.ordered', supplierId: 's', lines: [{ itemId: 'i', packs: 1 }], ...extra });
const grn = (id: string, shop = 'shop-a'): SyncEvent =>
  ({ id, shopId: shop, at: 2, orderNumber: 0, actor, type: 'stock.grn', orderId: 'p', supplierId: 's', lines: [{ itemId: 'i', ordered: 1, received: 1, accepted: 1 }], approvedBy: null });

async function setup() {
  const store = memoryStore();
  const a = (await store.addDevice('shop-a', 'A', 'counter')).device;
  const b = (await store.addDevice('shop-b', 'B', 'counter')).device;
  const numbering = (s: EventStore = store) => createNumberer(s, () => 9000);
  /** What the shop's log says each document is numbered. */
  const numbers = async (tenant: string) => Object.fromEntries((await store.pull(tenant, 0, 1000))
    .flatMap((r) => (r.event.type === 'stock.numbered' ? [[r.event.docId, r.event.number]] : [])));
  const push = async (device: Device, n: ReturnType<typeof numbering>, ...events: SyncEvent[]) => {
    await store.push(device, events, 1);
    return n(device, events);
  };
  return { store, a, b, numbering, numbers, push };
}

test('each new PO and GRN gets the next number of its kind, in order, within one shop', async () => {
  const s = await setup();
  const n = s.numbering();
  await s.push(s.a, n, po('p1'), grn('g1'), po('p2'));
  await s.push(s.a, n, po('p3'));
  assert.deepEqual(await s.numbers('shop-a'), { p1: 'PO-0001', g1: 'GRN-0001', p2: 'PO-0002', p3: 'PO-0003' });
});

test('numbering twice does nothing more: a retried push never makes a duplicate or a gap', async () => {
  const s = await setup();
  const n = s.numbering();
  const first = await s.push(s.a, n, po('p1'));
  assert.equal(first.length, 1);
  assert.equal((await s.push(s.a, n, po('p1'))).length, 0);
  assert.equal((await s.push(s.a, n, po('p1'), po('p2'))).length, 1, 'only the new one');
  assert.deepEqual(await s.numbers('shop-a'), { p1: 'PO-0001', p2: 'PO-0002' });
});

test('a push that failed before it was numbered is numbered when it is retried', async () => {
  const s = await setup();
  let fail = true;
  const flaky: EventStore = { ...s.store, push: async (d, e, t) => { if (fail && e.some((x) => x.type === 'stock.numbered')) throw new Error('disk'); return s.store.push(d, e, t); } };
  const n = s.numbering(flaky);
  await s.store.push(s.a, [po('p1')], 1);
  await assert.rejects(() => n(s.a, [po('p1')]), /disk/);
  assert.deepEqual(await s.numbers('shop-a'), {});
  fail = false;
  await n(s.a, [po('p1')]); // the device pushes it again
  assert.deepEqual(await s.numbers('shop-a'), { p1: 'PO-0001' });
});

test('shops number apart', async () => {
  const s = await setup();
  const n = s.numbering();
  await s.push(s.a, n, po('p1'));
  await s.push(s.b, n, po('q1', 'shop-b'));
  assert.deepEqual(await s.numbers('shop-a'), { p1: 'PO-0001' });
  assert.deepEqual(await s.numbers('shop-b'), { q1: 'PO-0001' });
});

test('after a restart the numbers carry on from what the log says; older documents with their own number count', async () => {
  const s = await setup();
  await s.push(s.a, s.numbering(), po('p1'), po('p2'));
  const restarted = s.numbering(); // a new server process: nothing in memory
  await s.push(s.a, restarted, po('p3'));
  assert.equal((await s.numbers('shop-a')).p3, 'PO-0003');

  const old = await setup();
  await old.store.push(old.a, [po('legacy', 'shop-a', { poNo: 'PO-0007' })], 1);
  await old.push(old.a, old.numbering(), po('new'));
  assert.deepEqual(await old.numbers('shop-a'), { new: 'PO-0008' }, 'the legacy document keeps its own number and is not numbered again');
});

test('two pushes at once are numbered one after the other, never the same number', async () => {
  const s = await setup();
  const n = s.numbering();
  await s.store.push(s.a, [po('p1'), po('p2'), po('p3'), po('p4')], 1);
  await Promise.all([n(s.a, [po('p1'), po('p2')]), n(s.a, [po('p3'), po('p4')]), n(s.a, [po('p1')])]);
  const got = Object.values(await s.numbers('shop-a')).sort();
  assert.deepEqual(got, ['PO-0001', 'PO-0002', 'PO-0003', 'PO-0004']);
});

test('events that are not documents are left alone', async () => {
  const s = await setup();
  const n = s.numbering();
  const adjust: SyncEvent = { id: 'a1', shopId: 'shop-a', at: 1, orderNumber: 0, actor, type: 'stock.adjusted', itemId: 'i', deltaPacks: 1 };
  assert.deepEqual(await s.push(s.a, n, adjust), []);
});
