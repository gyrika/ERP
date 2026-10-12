import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MENU, itemById } from './menu.ts';
import { ShorthandInterpreter } from './parser.ts';
import { fmt, formatLKR, lineTotal, quickCashAmounts, unitPrice } from './money.ts';
import { addLine, addLines, bareLine, emptyOrder, orderTotal, removeLine } from './order.ts';

const p = new ShorthandInterpreter(MENU);

test('typed shorthand → correct lines', () => {
  const d = p.interpret('2 L devilled chicken no onion, 1 margherita, burger');
  assert.deepEqual(d.unresolved, []);
  assert.deepEqual(d.lines, [
    { itemId: 'devilled-chicken', qty: 2, size: 'L', adds: [], outs: ['no-onion'] },
    { itemId: 'margherita', qty: 1, size: 'M', adds: [], outs: [] },
    { itemId: 'chicken-burger', qty: 1, size: undefined, adds: [], outs: [] },
  ]);
});

test('longest alias wins; pizza names containing "and" survive splitting', () => {
  const d = p.interpret('crispy chicken burger and large bacon and onion');
  assert.deepEqual(d.lines.map((l) => l.itemId), ['crispy-chicken-burger', 'bacon-onion']);
  assert.equal(d.lines[1].size, 'L');
});

test('extras map to priced options, unknown ones become a note', () => {
  const d = p.interpret('l margherita extra cheese extra pineapple');
  assert.deepEqual(d.lines[0].adds, ['full-cheese']);
  assert.equal(d.lines[0].note, 'extra pineapple');
});

test('printed menu numbers: pizzas are 1-12 in menu order, nothing else is numbered', () => {
  const pizzas = MENU.filter((m) => m.category === 'pizza');
  assert.deepEqual(pizzas.map((m) => m.number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(itemById('devilled-chicken').number, 5);
  assert.ok(MENU.filter((m) => m.category !== 'pizza').every((m) => m.number === undefined));
});

test('order by menu number: "5 L" is a large Devilled Chicken', () => {
  const line = (s: string) => p.interpret(s).lines[0];
  assert.deepEqual(line('5 L'), { itemId: 'devilled-chicken', qty: 1, size: 'L', adds: [], outs: [] });
  assert.deepEqual(line('5'), { itemId: 'devilled-chicken', qty: 1, size: 'M', adds: [], outs: [] });
  for (const s of ['2 5 L', '2x 5 L', '2 x 5 L', '2 #5 L', 'large 2 #5']) {
    assert.deepEqual([line(s).itemId, line(s).qty, line(s).size], ['devilled-chicken', 2, 'L'], s);
  }
  assert.deepEqual([line('#1').itemId, line('number 12 l').itemId], ['margherita', 'bbq-pork']);
  assert.deepEqual(line('5 L no onion').outs, ['no-onion']);
});

test('menu numbers mix with names, and a name after a number is still a quantity', () => {
  const d = p.interpret('5 L, 2 margherita, 3 large seafood');
  assert.deepEqual(d.lines.map((l) => [l.itemId, l.qty, l.size]), [
    ['devilled-chicken', 1, 'L'], ['margherita', 2, 'M'], ['seafood', 3, 'L'],
  ]);
});

test('a number not on the menu is surfaced, not guessed', () => {
  assert.deepEqual(p.interpret('13 L').unresolved, ['13 l']);
  assert.deepEqual(p.interpret('two L').unresolved, ['two l']);
});

test('unknown fragments are surfaced, not dropped', () => {
  const d = p.interpret('margherita, gelato');
  assert.equal(d.lines.length, 1);
  assert.deepEqual(d.unresolved, ['gelato']);
});

test('the design\'s order #1042 totals 6,600', () => {
  let o = emptyOrder(1042);
  o = addLine(o, { itemId: 'devilled-chicken', qty: 1, size: 'L', adds: ['full-cheese'], outs: [] });
  o = addLine(o, { itemId: 'margherita', qty: 2, size: 'M', adds: [], outs: [] });
  o = addLine(o, { itemId: 'chicken-burger', qty: 1, adds: ['cheese-slice'], outs: [] });
  assert.equal(orderTotal(o), 660000);
  assert.equal(fmt(orderTotal(o)), '6,600');
  assert.equal(formatLKR(orderTotal(o)), 'Rs 6,600');
});

test('identical lines merge; different configs do not', () => {
  const o = addLines(emptyOrder(1), [bareLine('margherita', 'M'), bareLine('margherita', 'M'), bareLine('margherita', 'L')]);
  assert.equal(o.lines.length, 2);
  assert.equal(o.lines[0].qty, 2);
  assert.equal(removeLine(o, o.lines[0].id).lines.length, 1);
});

test('pricing: variant + adds, times qty', () => {
  const item = itemById('devilled-chicken');
  const line = { id: 'x', itemId: item.id, qty: 2, size: 'L' as const, adds: ['bacon'], outs: [] };
  assert.equal(unitPrice(item, line), 295000);
  assert.equal(lineTotal(item, line), 590000);
});

test('quick cash amounts', () => {
  assert.deepEqual(quickCashAmounts(620000), [620000, 650000, 1000000, 2000000]);
  assert.deepEqual(quickCashAmounts(100000), [100000, 200000, 500000, 1000000]);
});

test('menu matches the printed prices', () => {
  const price = (id: string, size?: 'S' | 'M' | 'L') =>
    unitPrice(itemById(id), { size, adds: [] }) / 100;
  assert.equal(MENU.filter((m) => m.category === 'pizza').length, 12);
  assert.equal(MENU.filter((m) => m.category === 'burger').length, 5);
  assert.equal(price('veggie', 'M'), 1700);
  assert.equal(price('tonno-cipolla', 'L'), 2700);
  assert.equal(price('bbq-mix', 'L'), 3200);
  assert.equal(price('egg-burger'), 450);
  assert.equal(price('bacon-egg-burger'), 650);
  assert.equal(price('italian-pasta', 'S'), 999);
  assert.equal(price('italian-pasta', 'M'), 1899);
  assert.equal(price('italian-pasta', 'L'), 2650);
  const bullseye = itemById('chicken-burger').adds.find((o) => o.id === 'bullseye');
  assert.equal(bullseye?.price, 7000);
});

test('names that contain "and" are not split; similar names stay distinct', () => {
  const d = p.interpret('bacon and egg burger and 2 bbq pork, large bbq sausages');
  assert.deepEqual(d.unresolved, []);
  assert.deepEqual(d.lines.map((l) => l.itemId), ['bacon-egg-burger', 'bbq-pork', 'bbq-sausages']);
  assert.deepEqual(d.lines.map((l) => l.size), [undefined, 'M', 'L']);
});

test('burger extras and pasta sizes parse', () => {
  const d = p.interpret('fish burger extra egg extra cheese, large pasta');
  assert.deepEqual(d.lines[0].adds, ['bullseye', 'cheese-slice']);
  assert.equal(d.lines[1].itemId, 'italian-pasta');
  assert.equal(d.lines[1].size, 'L');
});
