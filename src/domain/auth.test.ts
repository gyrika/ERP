import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canManage, mayRecord, seesTakings } from './auth.ts';
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

test('who may record what: the same rule the server enforces', () => {
  for (const t of ['order.sent', 'order.send_undone', 'order.paid', 'order.payment_undone']) {
    assert.equal(mayRecord('cashier', t), true, t);
    assert.equal(mayRecord('kitchen', t), false, t);
  }
  for (const t of ['order.item_cancelled', 'order.discount_set', 'order.comped', 'order.line_adjusted', 'order.change_undone']) {
    assert.equal(mayRecord('cashier', t), false, t);
    assert.equal(mayRecord('manager', t), true, t);
    assert.equal(mayRecord('owner', t), true, t);
  }
  assert.equal(mayRecord('kitchen', 'kitchen.bumped'), true);
  assert.equal(mayRecord('owner', 'order.refunded'), false, 'unknown types are never allowed');
});

test('only managers and owners see the takings', () => {
  assert.deepEqual((['cashier', 'kitchen', 'manager', 'owner'] as const).map(seesTakings), [false, false, true, true]);
});
