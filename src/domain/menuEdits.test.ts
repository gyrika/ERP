import test from 'node:test';
import assert from 'node:assert/strict';
import { mayRecord } from './auth.ts';
import { MENU, itemById, menuItems, setMenuState } from './menu.ts';
import { EMPTY_MENU_STATE, effectiveMenu, menuStateFromEvents, nextMorning } from './menuEdits.ts';
import { addLine, bareLine, emptyOrder, markSent, orderTotal } from './order.ts';

const owner = { id: 'owner', name: 'Owner', role: 'owner' as const };
const event = (type: string, at: number, data: Record<string, unknown>) => ({
  id: `event-${at}`,
  shopId: 'shop',
  at,
  orderNumber: 0,
  actor: owner,
  type,
  ...data,
});

test('printed menu changes apply in event order and can be reset', () => {
  const state = menuStateFromEvents([
    event('menu.item_set', 1, {
      itemId: 'margherita',
      before: {},
      after: { prices: { M: 160000 }, name: { en: 'Margherita Special', si: 'Owner supplied' } },
    }),
    event('menu.item_set', 2, { itemId: 'seafood', before: {}, after: { hidden: true } }),
    event('menu.item_set', 3, { itemId: 'seafood', before: { hidden: true }, after: {} }),
  ]);
  const changed = effectiveMenu(MENU, state, 0);
  assert.equal(changed.find((item) => item.id === 'margherita')?.variants?.[0].price, 160000);
  assert.equal(changed.find((item) => item.id === 'margherita')?.name.en, 'Margherita Special');
  assert.equal(changed.find((item) => item.id === 'seafood')?.hidden, undefined);
  assert.equal(effectiveMenu(MENU, {
    overrides: { margherita: { name: { si: '' } } },
    soldOut: {},
  }, 0).find((item) => item.id === 'margherita')?.name.si, undefined);
  assert.equal(MENU.find((item) => item.id === 'margherita')?.variants?.[0].price, 145000);
});

test('sold-out items expire next morning and can be restored before then', () => {
  const at = new Date(2026, 9, 13, 19, 30).getTime();
  const until = nextMorning(at);
  assert.equal(new Date(until).getHours(), 6);
  assert.equal(new Date(until).getDate(), 14);
  const events = [
    event('menu.sold_out', 1, { itemId: 'seafood', until }),
  ];
  assert.equal(effectiveMenu(MENU, menuStateFromEvents(events), at).find((item) => item.id === 'seafood')?.soldOut, true);
  assert.equal(effectiveMenu(MENU, menuStateFromEvents(events), until).find((item) => item.id === 'seafood')?.soldOut, undefined);
  assert.deepEqual(menuStateFromEvents([
    ...events,
    event('menu.sold_out', 2, { itemId: 'seafood', until: null }),
  ]).soldOut, {});
});

test('menu edit permissions distinguish owner changes from service sold-out changes', () => {
  assert.equal(mayRecord('owner', 'menu.item_set'), true);
  assert.equal(mayRecord('manager', 'menu.item_set'), false);
  assert.equal(mayRecord('manager', 'menu.sold_out'), true);
  assert.equal(mayRecord('cashier', 'menu.sold_out'), false);
});

test('sent orders keep the price they were sent at after a menu update', () => {
  try {
    const order = markSent(addLine(emptyOrder(1001), bareLine('margherita', 'M')), 1);
    assert.equal(orderTotal(order), 145000);
    setMenuState({
      ...EMPTY_MENU_STATE,
      overrides: { margherita: { prices: { M: 160000 } } },
    }, 0);
    assert.equal(itemById('margherita').variants?.[0].price, 160000);
    assert.equal(orderTotal(order), 145000);
    const nextOrder = addLine(emptyOrder(1002), bareLine('margherita', 'M'));
    assert.equal(orderTotal(nextOrder), 160000);
    assert.equal(menuItems().length, MENU.length);
  } finally {
    setMenuState(EMPTY_MENU_STATE, 0);
  }
});
