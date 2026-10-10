import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEV_PINS, canChangeSentItems, requireManager } from './auth.ts';

const pinFor = (role: string) => Object.entries(DEV_PINS).find(([, a]) => a.role === role)![0];

test('requireManager: a manager PIN unlocks, a cashier PIN or unknown PIN does not', async () => {
  assert.equal((await requireManager(pinFor('manager')))?.role, 'manager');
  assert.equal(await requireManager(pinFor('cashier')), null);
  assert.equal(await requireManager('0000'), null);
  assert.equal(await requireManager(''), null);
});

test('only managers and owners may change sent items', () => {
  assert.equal(canChangeSentItems({ id: 'a', name: 'A', role: 'cashier' }), false);
  assert.equal(canChangeSentItems({ id: 'b', name: 'B', role: 'manager' }), true);
  assert.equal(canChangeSentItems({ id: 'c', name: 'C', role: 'owner' }), true);
});
