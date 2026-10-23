import test from 'node:test';
import assert from 'node:assert/strict';
import { daysAgo, formatStock, itemHistory, itemStory, usedIn } from './itemStory.ts';
import { MENU } from './menu.ts';
import type { SyncEvent } from './sync.ts';

// One item's story on its sheet (SCRUM-93).

const actor = { id: 'm', name: 'Manager', role: 'manager' as const };
const base = { shopId: 's', orderNumber: 0 as const, actor, itemId: 'inv-0006' };
const NOW = new Date(2026, 9, 15, 20, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

test('the shelf in packs first, to the quarter pack', () => {
  const block = { packQty: 2000, baseUnit: 'g' as const };
  assert.equal(formatStock(3000, block), '1½ packs · 3 kg');
  assert.equal(formatStock(2000, block), '1 pack · 2 kg');
  assert.equal(formatStock(500, block), '¼ pack · 500 g');
  assert.equal(formatStock(100, block), 'under ¼ pack · 100 g');
  assert.equal(formatStock(0, block), 'Empty');
  assert.equal(formatStock(-300, block), 'Empty');
  assert.equal(formatStock(8000, block), '4 packs · 8 kg');
});

test('days ago reads like people say it', () => {
  assert.equal(daysAgo(NOW - 60_000, NOW), 'today');
  assert.equal(daysAgo(NOW - DAY, NOW), 'yesterday');
  assert.equal(daysAgo(NOW - 3 * DAY, NOW), '3 days ago');
  assert.equal(daysAgo(new Date(2026, 8, 2).getTime(), NOW), 'on 2 Sept');
});

test('last count, last delivery and last price change; undone ones do not count', () => {
  const events: SyncEvent[] = [
    { ...base, id: 'c1', at: 1, type: 'stock.counted', counted: 4000, expected: 4500, entries: [], reason: 'spoiled', valueCents: -130000, tier: 'daily' },
    { ...base, id: 'c2', at: 2, type: 'stock.counted', counted: 9000, expected: 4000, entries: [], reason: null, valueCents: 0, tier: 'daily' },
    { shopId: 's', orderNumber: 0, actor, id: 'u', at: 3, type: 'stock.count_undone', countId: 'c2' },
    { ...base, id: 'd1', at: 4, type: 'stock.adjusted', deltaPacks: 2, reason: 'receive' },
    { ...base, id: 'd2', at: 5, type: 'stock.adjusted', deltaPacks: 3, reason: 'receive' },
    { ...base, id: 'd3', at: 6, type: 'stock.adjusted', deltaPacks: -3, reason: 'receive' },
    { ...base, id: 'p1', at: 7, type: 'stock.price_set', before: 500000, after: 520000 },
    { ...base, id: 'p2', at: 8, type: 'stock.price_set', before: 520000, after: 540000 },
    { ...base, id: 'p3', at: 9, type: 'stock.price_set', before: 540000, after: 520000 },
    { ...base, itemId: 'inv-0001', id: 'x', at: 10, type: 'stock.adjusted', deltaPacks: 9, reason: 'receive' },
  ];
  const story = itemStory(events, 'inv-0006');
  assert.deepEqual(story.lastCount, { at: 1, by: 'Manager', delta: -500, reason: 'spoiled', first: false, photo: null });
  assert.deepEqual(story.lastDelivery, { at: 4, packs: 2, by: 'Manager' });
  assert.deepEqual(story.lastPrice, { at: 7, before: 500000, after: 520000 });
  assert.deepEqual(itemStory([], 'inv-0006'), { lastCount: null, lastDelivery: null, lastPrice: null });
});

test('used in: the menu items whose recipe takes from it', () => {
  const pizzaFlour = usedIn(MENU, new Map(), 'inv-0001');
  assert.ok(pizzaFlour.length > 0, 'the dough uses pizza flour');
  assert.deepEqual(usedIn(MENU, new Map(), 'no-such-item'), []);
});

test('a GRN shows as a delivery in packs, and its GRN_UNDO cancels it', () => {
  const mv = (id: string, at: number, kind: 'GRN' | 'GRN_UNDO', qtyBase: number): SyncEvent => ({ ...base, id, at, type: 'stock.movement', kind, qtyBase, docId: 'g' });
  const events = [mv('m1', 1, 'GRN', 50000), mv('m2', 2, 'GRN', 25000), mv('m3', 3, 'GRN_UNDO', -25000)];
  assert.deepEqual(itemHistory(events, 'inv-0006', 25000).map((h) => h.kind === 'delivery' && h.packs), [2]);
  assert.deepEqual(itemHistory(events, 'inv-0006'), [], 'without the pack size it cannot say packs');
});

test('a GRN shows as a delivery of what it accepted; its undo takes it off the list; other items are not touched', () => {
  const grn: SyncEvent = { ...base, id: 'g1', at: 1, type: 'stock.grn', grnNo: 'GRN-0001', orderId: 'po', supplierId: 's', lines: [
    { itemId: 'inv-0006', ordered: 3, received: 3, accepted: 2, returned: 1 }, { itemId: 'inv-0001', ordered: 1, received: 1, accepted: 1 }], approvedBy: null };
  const undo: SyncEvent = { ...base, id: 'u', at: 2, type: 'stock.grn_undone', grnId: 'g1', reason: 'Wrong amounts', approvedBy: actor };
  assert.deepEqual(itemHistory([grn], 'inv-0006').map((h) => h.kind === 'delivery' && h.packs), [2]);
  assert.deepEqual(itemHistory([grn], 'inv-0001').map((h) => h.kind === 'delivery' && h.packs), [1]);
  assert.deepEqual(itemHistory([grn, undo], 'inv-0006'), []);
  assert.equal(itemStory([grn], 'inv-0006').lastDelivery?.packs, 2);
});
