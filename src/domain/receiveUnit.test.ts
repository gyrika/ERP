import test from 'node:test';
import assert from 'node:assert/strict';
import { isUnitId, packPrice, receiveUnitOf, toPacks, unitName, unitPrice } from './counting.ts';
import { mayRecord } from './auth.ts';
import { inventoryFromEvents } from './inventory.ts';
import { SEED_INVENTORY } from './inventoryData.ts';
import type { SyncEvent } from './sync.ts';
import { validatePush } from '../../server/validate.ts';

// What receiving is counted in, the owner's choice (SCRUM-96).

const FLOUR = SEED_INVENTORY.find((i) => i.id === 'inv-0001')!; // 25 kg pack, Rs 6,400
const owner = { id: 'o', name: 'Owner', role: 'owner' as const };
const set = (unit: string, id = 'u'): SyncEvent => ({ id, shopId: 'shop-1', at: 1, orderNumber: 0, actor: owner, type: 'stock.receive_unit_set', itemId: FLOUR.id, unit });

test('the pack unless the owner chose otherwise; a learned unit that is gone falls back to the pack', () => {
  const row = (events: SyncEvent[]) => inventoryFromEvents(SEED_INVENTORY, events).find((r) => r.id === FLOUR.id)!;
  assert.equal(receiveUnitOf(row([])).id, 'pack');
  assert.equal(receiveUnitOf(row([set('kg')])).id, 'kg');
  assert.equal(row([set('kg'), set('pack', 'v')]).receiveUnit, null);
  assert.equal(receiveUnitOf({ ...row([]), receiveUnit: 'unit:Sack' }).id, 'pack');
  assert.equal(receiveUnitOf({ ...row([]), units: [{ name: 'Sack', base: 50000 }], receiveUnit: 'unit:Sack' }).id, 'unit:Sack');
});

test('amounts and prices convert to packs and back, in whole cents', () => {
  const kg = receiveUnitOf({ ...FLOUR, receiveUnit: 'kg' });
  assert.equal(toPacks(12.5, kg, FLOUR.packQty), 0.5);
  assert.equal(unitPrice(640000, kg, FLOUR.packQty), 25600); // Rs 256 a kg
  assert.equal(packPrice(26000, kg, FLOUR.packQty), 650000); // Rs 260 a kg = Rs 6,500 a pack
  assert.equal(unitName(kg), 'kg');
  assert.equal(unitName(receiveUnitOf(FLOUR)), 'pack');
});

test("only the owner chooses it; the unit must be one the app knows", () => {
  assert.equal(mayRecord('owner', 'stock.receive_unit_set'), true);
  assert.equal(mayRecord('manager', 'stock.receive_unit_set'), false);
  assert.ok(isUnitId('unit:Tray') && isUnitId('kg') && !isUnitId('ton') && !isUnitId('unit:3'));
  assert.deepEqual(validatePush({ events: [set('kg')] }, 'shop-1'), { events: [set('kg')] });
  assert.ok('reason' in validatePush({ events: [set('bucket')] }, 'shop-1'));
});
