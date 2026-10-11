import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canManage } from './auth.ts';
import { fakeAuth } from '../fake/fakeAuth.ts';
import { FAKE_STAFF } from '../fake/data.ts';

const pinFor = (role: string) => FAKE_STAFF.find((s) => s.actor.role === role)!.pin;

test('AuthService (fake): a manager PIN unlocks, a cashier PIN or unknown PIN does not', async () => {
  assert.equal((await fakeAuth.verifyManagerPin(pinFor('manager')))?.role, 'manager');
  assert.equal(await fakeAuth.verifyManagerPin(pinFor('cashier')), null);
  assert.equal(await fakeAuth.verifyManagerPin('0000'), null);
  assert.equal(await fakeAuth.verifyManagerPin(''), null);
  assert.ok(fakeAuth.shopId());
});

test('only managers and owners may manage', () => {
  assert.equal(canManage({ id: 'a', name: 'A', role: 'cashier' }), false);
  assert.equal(canManage({ id: 'b', name: 'B', role: 'manager' }), true);
  assert.equal(canManage({ id: 'c', name: 'C', role: 'owner' }), true);
});
