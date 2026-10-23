import test from 'node:test';
import assert from 'node:assert/strict';
import { mayRecord } from './auth.ts';
import { inventoryFromEvents, stockStatus } from './inventory.ts';
import { SEED_INVENTORY } from './inventoryData.ts';
import type { SyncEvent } from './sync.ts';
import { validatePush } from '../../server/validate.ts';

// "Order when below", the owner's number per item (SCRUM-135); the rule itself is in ordering.test.ts.

const FLOUR = SEED_INVENTORY.find((i) => i.id === 'inv-0001')!; // 25 kg pack, sold by nothing in these events
const owner = { id: 'o', name: 'Owner', role: 'owner' as const };
const base = { shopId: 'shop-1', at: 1, orderNumber: 0 as const, actor: owner, itemId: FLOUR.id };
const limit = (packs: number | null, id = 'l'): SyncEvent => ({ ...base, id, type: 'stock.limit_set', packs });
const shelf = (packs: number): SyncEvent => ({ ...base, id: 'in', type: 'stock.adjusted', deltaPacks: packs, reason: 'receive' });
const row = (events: SyncEvent[]) => inventoryFromEvents(SEED_INVENTORY, events, { now: 10 }).find((r) => r.id === FLOUR.id)!;

test('automatic unless the owner set a number; null hands it back', () => {
  assert.equal(row([]).orderBelowPacks, null);
  assert.equal(row([limit(2)]).orderBelowPacks, 2);
  assert.equal(row([limit(2), limit(null, 'm')]).orderBelowPacks, null);
});

test('an item that does not sell is Low once it is under the owner\'s number, and the order brings it back', () => {
  assert.equal(stockStatus(row([shelf(1)])), 'ok', 'no use: the days rule never calls it low');
  const low = row([shelf(1), limit(2)]);
  assert.equal(stockStatus(low), 'low');
  assert.equal(low.suggestedPacks, 1);
  assert.equal(stockStatus(row([shelf(2), limit(2)])), 'ok', 'at the number is not below it');
});

test('only the owner sets it; the server takes null or packs above 0', () => {
  assert.equal(mayRecord('owner', 'stock.limit_set'), true);
  assert.equal(mayRecord('manager', 'stock.limit_set'), false);
  assert.equal(mayRecord('cashier', 'stock.limit_set'), false);
  for (const packs of [2, 0.5, null]) assert.deepEqual(validatePush({ events: [limit(packs)] }, 'shop-1'), { events: [limit(packs)] });
  for (const packs of [0, -1, Number.NaN, '2']) assert.ok('reason' in validatePush({ events: [limit(packs as number)] }, 'shop-1'), String(packs));
});
