import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayRecord } from './auth.ts';
import { allocate, boxesIn, boxLines, checkCombo, comboBlocked, comboIdFor, opensBox, separatePrice, swapPick, usualPick } from './combos.ts';
import { MENU, itemById } from './menu.ts';
import { effectiveMenu, EMPTY_MENU_STATE, menuStateFromEvents } from './menuEdits.ts';
import { addLines, emptyOrder, markSent, orderTotal } from './order.ts';
import { bookUsage } from './stockUsage.ts';
import type { Combo, OrderLine } from './types.ts';

const rs = (n: number) => n * 100;

/** Family Box: any Classic/Chicken large pizza (premium +500), 2 burgers (crispy +200), pasta single. */
const FAMILY: Combo = {
  name: { en: 'Family Box' },
  price: rs(3600),
  slots: [
    {
      qty: 1, size: 'L', usual: 'devilled-chicken',
      options: { 'devilled-chicken': 0, margherita: 0, 'bbq-chicken': 0, seafood: rs(500) },
    },
    { qty: 2, usual: 'chicken-burger', options: { 'chicken-burger': 0, 'fish-burger': 0, 'crispy-chicken-burger': rs(200) } },
    { qty: 1, size: 'S', usual: 'italian-pasta', options: { 'italian-pasta': 0 } },
  ],
};

const withIds = (specs: ReturnType<typeof boxLines>): OrderLine[] => specs!.map((s, i) => ({ ...s, id: `l${i}` }));

test('a box splits its price over its dishes in whole cents that add up exactly', () => {
  assert.deepEqual(allocate(1000, [1, 1, 1]), [334, 333, 333]);
  assert.deepEqual(allocate(360000, [0, 0]), [180000, 180000]);
  const shares = allocate(359999, [250000, 45000, 45000, 99900]);
  assert.equal(shares.reduce((a, b) => a + b, 0), 359999);
  assert.ok(shares.every(Number.isInteger));
});

test('one tap: the whole box with the usual picks, each dish its own qty-1 line, priced at the combo price', () => {
  const lines = boxLines('combo-family-box', FAMILY, MENU, { boxId: 'b1' })!;
  assert.deepEqual(lines.map((l) => `${l.itemId}:${l.size ?? ''}:${l.qty}`), [
    'devilled-chicken:L:1', 'chicken-burger::1', 'chicken-burger::1', 'italian-pasta:S:1',
  ]);
  assert.ok(lines.every((l) => l.box!.id === 'b1' && l.box!.name === 'Family Box'));
  // Two identical burgers stay two lines: each carries its own share.
  const order = addLines(emptyOrder(1), lines);
  assert.equal(order.lines.length, 4);
  assert.equal(orderTotal(order), rs(3600));
  // Sending fixes each dish's price at its share; the total stays the combo price.
  assert.equal(orderTotal(markSent(order, 1)), rs(3600));
  assert.equal(separatePrice(FAMILY, MENU), rs(2500 + 450 + 450 + 999));
  const box = boxesIn(order.lines).get('b1')!;
  assert.equal(box.price, rs(3600));
  assert.equal(box.saved, rs(4399 - 3600));
  assert.equal(opensBox(order.lines, 0), true);
  assert.equal(opensBox(order.lines, 1), false);
});

test('changing a pick: the extra it costs is added, the shares stay, extras the new dish lacks drop off', () => {
  const [pizza] = withIds(boxLines('combo-family-box', FAMILY, MENU, { boxId: 'b1' }));
  const dressed = { ...pizza, adds: ['chicken'], outs: ['no-onion', 'less-spicy'] };
  const swapped = swapPick(dressed, itemById('seafood'), FAMILY);
  assert.equal(swapped.itemId, 'seafood');
  assert.equal(swapped.box!.share, pizza.box!.share);
  assert.equal(swapped.box!.extra, rs(500));
  assert.deepEqual(swapped.adds, ['chicken'], 'pizza extras fit every pizza');
  assert.deepEqual(swapped.outs, ['no-onion'], 'Seafood has onion but is not spicy');
  const order = { ...emptyOrder(1), lines: [swapped] };
  // Its share + Rs 500 for the pick + Rs 400 chicken.
  assert.equal(orderTotal(order), pizza.box!.share + rs(500) + rs(400));
  assert.equal(boxesIn(order.lines).get('b1')!.saved, Math.max(0, rs(3200) - rs(500) - pizza.box!.share));
});

test('a pick typed or tapped wins when the slot offers it; a sold-out usual falls back to a pick in the price', () => {
  const picked = boxLines('c', FAMILY, MENU, { picks: { 0: 'margherita', 1: 'margherita' } })!;
  assert.equal(picked[0].itemId, 'margherita');
  assert.equal(picked[1].itemId, 'chicken-burger', 'a margherita is not a burger choice');
  const out = effectiveMenu(MENU, { ...EMPTY_MENU_STATE, soldOut: { 'devilled-chicken': Date.now() + 60_000 } }, Date.now());
  assert.equal(usualPick(FAMILY.slots[0], out)!.id, 'margherita');
  const allPizzaOut = effectiveMenu(MENU, {
    ...EMPTY_MENU_STATE,
    soldOut: Object.fromEntries(['devilled-chicken', 'margherita', 'bbq-chicken', 'seafood'].map((id) => [id, Date.now() + 60_000])),
  }, Date.now());
  assert.equal(comboBlocked(FAMILY, allPizzaOut), 'Devilled Chicken sold out');
  assert.equal(boxLines('c', FAMILY, allPizzaOut), null);
  assert.equal(comboBlocked({ ...FAMILY, hidden: true }, MENU), 'hidden');
});

test('stock: each dish in a box takes its own recipe, as if sold alone', () => {
  const [pizza] = boxLines('c', FAMILY, MENU)!;
  const answers = new Map();
  const alone = bookUsage({ itemId: 'devilled-chicken', qty: 1, size: 'L', adds: [], outs: [] }, answers);
  assert.ok(alone.length > 0, 'the printed recipe book has this pizza');
  assert.deepEqual(bookUsage(pizza, answers), alone);
});

test('combos are checked: names, whole-rupee prices, real dishes in real sizes, a usual in the price', () => {
  assert.equal(checkCombo(FAMILY, MENU), null);
  assert.match(checkCombo({ ...FAMILY, name: { en: ' ' } }, MENU)!, /name/);
  assert.match(checkCombo({ ...FAMILY, price: 360050 }, MENU)!, /whole rupees/);
  assert.match(checkCombo({ ...FAMILY, slots: [] }, MENU)!, /at least one/);
  assert.match(checkCombo({ ...FAMILY, slots: [{ ...FAMILY.slots[0], size: 'S' }] }, MENU)!, /no such size/);
  assert.match(checkCombo({ ...FAMILY, slots: [{ ...FAMILY.slots[1], size: 'L' }] }, MENU)!, /no such size/);
  assert.match(checkCombo({ ...FAMILY, slots: [{ ...FAMILY.slots[0], usual: 'seafood' }] }, MENU)!, /in the price/);
  assert.match(checkCombo({ ...FAMILY, slots: [{ qty: 1, usual: 'x', options: { x: 0 } }] }, MENU)!, /not on the menu/);
  assert.equal(checkCombo({ ...FAMILY, slots: [{ qty: 1, usual: 'new-wrap', options: { 'new-wrap': 0 } }] }, MENU, (id) => id.startsWith('new-')), null);
  assert.match(checkCombo({ ...FAMILY, slots: [{ ...FAMILY.slots[1], qty: 7 }] }, MENU)!, /1 to 6/);
});

test('combo events: made, changed, deleted; managers and the owner may, cashiers may not', () => {
  const manager = { id: 'm', name: 'Kasun', role: 'manager' as const };
  const ev = (at: number, after: Combo | null) => ({ id: `c${at}`, shopId: 's', at, orderNumber: 0, actor: manager, type: 'menu.combo_set', itemId: 'combo-family-box', before: null, after });
  assert.deepEqual(menuStateFromEvents([ev(1, FAMILY)]).combos, { 'combo-family-box': FAMILY });
  assert.equal(menuStateFromEvents([ev(1, FAMILY), ev(2, { ...FAMILY, price: rs(3500) })]).combos!['combo-family-box'].price, rs(3500));
  assert.equal(menuStateFromEvents([ev(1, FAMILY), ev(2, null)]).combos, undefined);
  assert.equal(mayRecord('manager', 'menu.combo_set'), true);
  assert.equal(mayRecord('owner', 'menu.combo_set'), true);
  assert.equal(mayRecord('cashier', 'menu.combo_set'), false);
  assert.equal(comboIdFor('Family Box!', new Set(['combo-family-box'])), 'combo-family-box-2');
});

test('receipt: the box price once, its dishes under it, an added price only where one was added, and the saving', async () => {
  const { receipt } = await import('./receipt.ts');
  const lines = withIds(boxLines('combo-family-box', FAMILY, MENU, { boxId: 'b1' }));
  lines[0] = { ...lines[0], adds: ['half-cheese'] };
  const order = markSent({ ...emptyOrder(42), lines }, 1);
  const paid = { ...order, total: orderTotal(order), tender: 'cash' as const, tendered: rs(4000), change: rs(100), paidAt: 1 };
  const text = receipt(paid, { cashier: 'Nimal' }).map((l) => l.text);
  assert.ok(text.some((t) => /^Family Box\s+3,600$/.test(t)), text.join('\n'));
  assert.ok(text.some((t) => /^ {2}Devilled Chicken Large\s+300$/.test(t)), text.join('\n'));
  assert.ok(text.includes('  Chicken Burger'));
  assert.ok(text.includes('You saved Rs 799 with the Family Box'));
});

test('box shares are whole rupees, so reports never show a dish at Rs 1,842.12', () => {
  const lines = boxLines('c', { ...FAMILY, price: rs(3599) }, MENU)!;
  assert.ok(lines.every((l) => l.box!.share % 100 === 0));
  assert.equal(lines.reduce((s, l) => s + l.box!.share, 0), rs(3599));
});
