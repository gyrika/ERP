import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayRecord } from './auth.ts';
import { MENU, itemById, menuItems, setMenuState } from './menu.ts';
import { checkOverride, EMPTY_MENU_STATE, effectiveMenu, menuStateFromEvents, nextMorning } from './menuEdits.ts';
import { addLine, bareLine, emptyOrder, markSent } from './order.ts';
import { orderTotal } from './order.ts';

const owner = { id: 'o', name: 'Nisal', role: 'owner' as const };
const set = (itemId: string, after: object, at = 1) => ({ id: `e${at}`, shopId: 's', at, orderNumber: 0, actor: owner, type: 'menu.item_set', itemId, before: {}, after });
const soldOut = (itemId: string, until: number | null, at = 1) => ({ id: `s${at}`, shopId: 's', at, orderNumber: 0, actor: owner, type: 'menu.sold_out', itemId, until });

test('the printed menu, then the owner\'s changes on top; the newest change wins; {} goes back to print', () => {
  const state = menuStateFromEvents([
    set('margherita', { prices: { M: 150000 } }, 1),
    set('margherita', { prices: { M: 160000, L: 220000 }, name: { en: 'Margherita Classic', si: 'මාගරීටා' } }, 2),
    set('chicken-burger', { prices: { one: 50000 }, adds: { 'cheese-slice': 20000 } }, 3),
    set('seafood', { hidden: true }, 4),
    set('seafood', {}, 5),
    { type: 'order.paid' },
  ]);
  const menu = effectiveMenu(MENU, state, 0);
  const m = menu.find((x) => x.id === 'margherita')!;
  assert.deepEqual(m.variants!.map((v) => v.price), [160000, 220000]);
  assert.equal(m.name.en, 'Margherita Classic');
  assert.equal(m.name.si, 'මාගරීටා');
  assert.equal(m.edited, true);
  const b = menu.find((x) => x.id === 'chicken-burger')!;
  assert.equal(b.price, 50000);
  assert.equal(b.adds.find((a) => a.id === 'cheese-slice')!.price, 20000);
  assert.equal(menu.find((x) => x.id === 'seafood')!.hidden, undefined, 'back to the printed menu');
  assert.equal(menu.find((x) => x.id === 'seafood')!.edited, undefined);
  assert.deepEqual(MENU.find((x) => x.id === 'margherita')!.variants!.map((v) => v.price), [145000, 199000], 'the printed menu itself never changes');
});

test('sold out until the next morning, then back by itself', () => {
  const at = new Date(2026, 9, 13, 19, 30).getTime();
  const until = nextMorning(at);
  assert.equal(new Date(until).getHours(), 6);
  assert.equal(new Date(until).getDate(), 14);
  assert.equal(new Date(nextMorning(new Date(2026, 9, 14, 3, 0).getTime())).getDate(), 14, 'after midnight: this morning');
  const state = menuStateFromEvents([soldOut('bbq-chicken', until)]);
  assert.equal(effectiveMenu(MENU, state, at).find((x) => x.id === 'bbq-chicken')!.soldOut, true);
  assert.equal(effectiveMenu(MENU, state, until + 1).find((x) => x.id === 'bbq-chicken')!.soldOut, undefined);
  assert.deepEqual(menuStateFromEvents([soldOut('bbq-chicken', until, 1), soldOut('bbq-chicken', null, 2)]).soldOut, {});
});

test('a price change never alters an order already sent; a new order gets the new price', () => {
  try {
    const sent = markSent(addLine(emptyOrder(1001), bareLine('margherita', 'M')), 1);
    assert.equal(orderTotal(sent), 145000);
    setMenuState(menuStateFromEvents([set('margherita', { prices: { M: 160000 } })]), 0);
    assert.equal(orderTotal(sent), 145000, 'sent at the old price');
    assert.equal(orderTotal(addLine(emptyOrder(1002), bareLine('margherita', 'M'))), 160000);
    assert.equal(itemById('margherita').variants![0].price, 160000);
    assert.equal(menuItems().length, MENU.length);
  } finally {
    setMenuState(EMPTY_MENU_STATE);
  }
});

test('only the owner changes the menu; managers may mark things sold out; changes are checked', () => {
  assert.equal(mayRecord('owner', 'menu.item_set'), true);
  assert.equal(mayRecord('manager', 'menu.item_set'), false);
  assert.equal(mayRecord('manager', 'menu.sold_out'), true);
  assert.equal(mayRecord('cashier', 'menu.sold_out'), false);
  const m = MENU.find((x) => x.id === 'margherita')!;
  assert.equal(checkOverride(m, { prices: { M: 160000 } }), null);
  assert.match(checkOverride(m, { prices: { M: 160050 } })!, /whole rupees/);
  assert.match(checkOverride(m, { prices: { M: 0 } })!, /more than 0/);
  assert.match(checkOverride(m, { prices: { one: 100000 } })!, /no one size/);
  assert.match(checkOverride(m, { name: { en: ' ' } })!, /English name/);
  assert.match(checkOverride(m, { adds: { 'gold-leaf': 100 } })!, /not on this item/);
});
