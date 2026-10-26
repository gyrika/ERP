import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canManage, isRemake, isStaffRole, mayRecord, seesTakings, STAFF_ROLES, VISION_RECORDS } from './auth.ts';
import { RECIPE_EVENT_TYPES } from './costing.ts';
import { MENU_EVENT_TYPES } from './menuEdits.ts';
import { SHORTHAND_EVENT_TYPES } from './shorthandMisses.ts';
import { KITCHEN_EVENT_TYPES, ORDER_EVENT_TYPES, PREP_EVENT_TYPES, STOCK_EVENT_TYPES } from './sync.ts';
import { TABLE_EVENT_TYPES, VISION_EVENT_TYPES } from './tables.ts';
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

// ----- tables and cameras (SCRUM-167) -----

const ALL_TYPES = [
  ...ORDER_EVENT_TYPES, ...KITCHEN_EVENT_TYPES, ...STOCK_EVENT_TYPES, ...PREP_EVENT_TYPES, ...MENU_EVENT_TYPES,
  ...RECIPE_EVENT_TYPES, ...SHORTHAND_EVENT_TYPES, ...TABLE_EVENT_TYPES, ...VISION_EVENT_TYPES,
];
const CAMERA_SEES = ['table.state_changed', 'table.alert_raised', 'table.alert_cleared', 'vision.camera_offline', 'vision.camera_online', 'vision.heartbeat'];

test('vision (the camera worker) records only what the camera sees, nothing on orders, stock, recipes or the menu', () => {
  assert.deepEqual(ALL_TYPES.filter((t) => mayRecord('vision', t)).sort(), [...CAMERA_SEES].sort());
  assert.deepEqual([...VISION_RECORDS].sort(), [...CAMERA_SEES].sort());
  for (const t of [...ORDER_EVENT_TYPES, ...STOCK_EVENT_TYPES, ...RECIPE_EVENT_TYPES, ...MENU_EVENT_TYPES, ...KITCHEN_EVENT_TYPES, ...PREP_EVENT_TYPES]) {
    assert.equal(mayRecord('vision', t), false, t);
  }
  assert.equal(mayRecord('vision', 'table.state_set'), false, 'a camera never sets a table the way staff do');
});

test('what the camera sees comes from the camera alone: no person records it', () => {
  for (const role of STAFF_ROLES) for (const t of CAMERA_SEES) assert.equal(mayRecord(role, t), false, `${role} ${t}`);
});

test('staff change a table on the floor, and undo it, from any role but the kitchen', () => {
  for (const t of ['table.state_set', 'table.state_set_undone']) {
    assert.deepEqual(STAFF_ROLES.map((r) => mayRecord(r, t)), [true, true, true, false], t);
  }
});

test("the floor plan, cameras, zones and CV settings are the owner's", () => {
  for (const t of ['table.layout_set', 'vision.cameras_set', 'vision.zones_set', 'vision.settings_set']) {
    assert.deepEqual(STAFF_ROLES.map((r) => mayRecord(r, t)), [false, false, true, false], t);
    assert.equal(mayRecord('vision', t), false, t);
  }
});

test("nobody signs in as vision: it is the server's own stamp for the camera worker", () => {
  assert.deepEqual([...STAFF_ROLES], ['cashier', 'manager', 'owner', 'kitchen']);
  assert.equal(isStaffRole('vision'), false);
  assert.equal(isStaffRole('owner'), true);
  assert.equal(seesTakings('vision'), false);
  assert.equal(canManage({ id: 'v', name: 'Cameras', role: 'vision' }), false);
});

test('waste is a manager\'s, except a kitchen Remake and its Undo, which whoever is signed in records (SCRUM-177)', () => {
  assert.equal(mayRecord('cashier', 'stock.wasted'), false);
  assert.equal(isRemake({ type: 'stock.wasted', ticketId: 't1' }), true);
  assert.equal(isRemake({ type: 'stock.waste_undone', ticketId: 't1' }), true);
  assert.equal(isRemake({ type: 'stock.wasted' }), false);
  assert.equal(isRemake({ type: 'stock.counted', ticketId: 't1' }), false);
  for (const role of ['cashier', 'kitchen', 'manager', 'owner'] as const) assert.equal(mayRecord(role, 'stock.wasted', true), true, role);
});
