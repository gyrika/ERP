import test from 'node:test';
import assert from 'node:assert/strict';
import type { Actor } from './auth.ts';
import { mayRecord } from './auth.ts';
import type { SyncEvent } from './sync.ts';
import { checkStockSetting, STOCK_DEFAULTS, stockSettingsFromEvents } from './stockSettings.ts';

const owner: Actor = { id: 'o', name: 'Owner', role: 'owner' };
const set = (id: string, key: string, value: unknown): SyncEvent =>
  ({ id, shopId: 's', at: 1, orderNumber: 0, actor: owner, type: 'stock.settings_set', key, value } as SyncEvent);

test('the defaults are the agreed numbers', () => {
  assert.deepEqual(STOCK_DEFAULTS, {
    countGapShare: 0.1, countGapCents: 200_000, usageDays: 14, defaultLeadDays: 3,
    leadSamples: 5, spareDays: 2, orderDays: 7, grnUndoHours: 24,
  });
});

test("the owner's change wins over the default, the last one counts, a bad value is ignored", () => {
  const s = stockSettingsFromEvents([set('a', 'usageDays', 21), set('b', 'usageDays', 10), set('c', 'orderDays', 2.5), set('d', 'nope', 3)]);
  assert.equal(s.usageDays, 10);
  assert.equal(s.orderDays, 7);
});

test('each setting is checked, with a plain reason', () => {
  assert.equal(checkStockSetting('countGapShare', 0.25), null);
  assert.equal(checkStockSetting('countGapShare', 2), 'Type a number from 0 to 1.');
  assert.equal(checkStockSetting('usageDays', 3.5), 'Type a whole number.');
  assert.equal(checkStockSetting('usageDays', '14'), 'Type a number.');
  assert.equal(checkStockSetting('other', 1), 'There is no such setting.');
});

test('only the owner changes them', () => {
  assert.equal(mayRecord('owner', 'stock.settings_set'), true);
  assert.equal(mayRecord('manager', 'stock.settings_set'), false);
});
