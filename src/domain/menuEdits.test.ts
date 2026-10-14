import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayRecord } from './auth.ts';
import { MENU, itemById, menuItems, setMenuState } from './menu.ts';
import { checkNewItem, checkOverride, EMPTY_MENU_STATE, effectiveMenu, menuStateFromEvents, nextMorning, type NewItem } from './menuEdits.ts';
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

const added = (itemId: string, item: object | null, at = 1) => ({ id: `a${at}`, shopId: 's', at, orderNumber: 0, actor: owner, type: 'menu.item_added', itemId, item });
const alfredo = { category: 'pasta', name: { en: 'Chicken Alfredo' }, description: 'Creamy', prices: { S: 110000, M: 210000, L: 290000 } };

test("the owner's own item takes its section's shape, sells like any item, and is changed like one", () => {
  try {
    const state = menuStateFromEvents([
      added('new-chicken-alfredo', alfredo, 1),
      set('new-chicken-alfredo', { prices: { L: 300000 } }, 2),
      soldOut('new-chicken-alfredo', 5_000, 3),
    ]);
    const menu = effectiveMenu(MENU, state, 0);
    assert.equal(menu.length, MENU.length + 1);
    const m = menu.at(-1)!;
    assert.equal(m.category, 'pasta');
    assert.deepEqual(m.variants!.map((v) => [v.id, v.label, v.price]), [['S', 'Single', 110000], ['M', 'Medium', 210000], ['L', 'Large', 300000]]);
    assert.equal(m.added, true);
    assert.equal(m.edited, true);
    assert.equal(m.soldOut, true);

    const burger = effectiveMenu(MENU, menuStateFromEvents([added('new-cheese-burger', { category: 'burger', name: { en: 'Cheese Burger' }, description: '', prices: { one: 55000 } })]), 0).at(-1)!;
    assert.equal(burger.price, 55000);
    assert.deepEqual(burger.adds, MENU.find((x) => x.id === 'chicken-burger')!.adds, 'the burger extras');

    setMenuState(state, 10_000);
    assert.equal(orderTotal(addLine(emptyOrder(1001), bareLine('new-chicken-alfredo', 'M'))), 210000);
  } finally {
    setMenuState(EMPTY_MENU_STATE);
  }
});

test('Undo takes an added item off the menu, but an order that already has it still prices', () => {
  try {
    setMenuState(menuStateFromEvents([added('new-chicken-alfredo', alfredo, 1)]), 0);
    const order = markSent(addLine(emptyOrder(1001), bareLine('new-chicken-alfredo', 'S')), 1);
    setMenuState(menuStateFromEvents([added('new-chicken-alfredo', alfredo, 1), added('new-chicken-alfredo', null, 2)]), 0);
    const m = itemById('new-chicken-alfredo');
    assert.equal(m.removed, true);
    assert.equal(m.hidden, true);
    assert.equal(orderTotal(order), 110000);
  } finally {
    setMenuState(EMPTY_MENU_STATE);
  }
});

test('a new item needs an English name and a whole-rupee price for every size of its section', () => {
  assert.equal(checkNewItem(alfredo as NewItem, MENU), null);
  assert.match(checkNewItem({ ...alfredo, prices: { S: 110000, M: 210000 } } as NewItem, MENU)!, /prices/);
  assert.match(checkNewItem({ ...alfredo, prices: { ...alfredo.prices, S: 110050 } } as NewItem, MENU)!, /whole rupees/);
  assert.match(checkNewItem({ ...alfredo, prices: { one: 50000 } } as NewItem, MENU)!, /size/);
  assert.match(checkNewItem({ ...alfredo, name: { en: '  ' } } as NewItem, MENU)!, /English name/);
  assert.match(checkNewItem({ ...alfredo, category: 'drinks' } as unknown as NewItem, MENU)!, /section/);
  assert.equal(mayRecord('owner', 'menu.item_added'), true);
  assert.equal(mayRecord('manager', 'menu.item_added'), false);
});
