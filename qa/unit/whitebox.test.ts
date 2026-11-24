/**
 * EC4206 3.4 White-box tests for ShorthandInterpreter.parseSegment (src/domain/parser.ts:86).
 * Cyclomatic complexity V(G) = 26 decisions + 1 = 27 (ESLint `complexity` agrees: 27).
 * Each case names the decisions (D1..D26, numbered in the report) whose true/false outcome it
 * exercises, so together they reach every statement and both outcomes of every decision.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ShorthandInterpreter } from '../../src/domain/parser.ts';
import { MENU } from '../../src/domain/menu.ts';

const p = new ShorthandInterpreter(MENU);
const one = (s: string) => p.interpret(s);

describe('WB parseSegment statement + branch coverage', () => {
  test('WB-01 "burger": no modifier (D1F,D2F), name found (D17T,D18), no variants (D23F), no note (D26F)', () => {
    const [l] = one('burger').lines;
    assert.deepEqual([l.itemId, l.qty, l.size, l.note], ['chicken-burger', 1, undefined, undefined]);
  });
  test('WB-02 "2 L devilled chicken no onion": modifier (D1T,D2T), digit qty (D7T), size word (D13T), variant wanted (D24 left)', () => {
    assert.deepEqual(one('2 L devilled chicken no onion').lines[0], { itemId: 'devilled-chicken', qty: 2, size: 'L', adds: [], outs: ['no-onion'] });
  });
  test('WB-03 "#5": menu-number token (D4T), no name (D17F), menuNo defined (D19F,D21F)', () => {
    assert.equal(one('#5').lines[0].itemId, 'devilled-chicken');
  });
  test('WB-04 "5 L": lone digit becomes menu number (D19T)', () => {
    assert.deepEqual(one('5 L').lines[0], { itemId: 'devilled-chicken', qty: 1, size: 'L', adds: [], outs: [] });
  });
  test('WB-05 "2 5 L": second digit is the menu number (D10T)', () => {
    assert.equal(one('2 5 L').lines[0].qty, 2);
    assert.equal(one('2 5 L').lines[0].itemId, 'devilled-chicken');
  });
  test('WB-06 "3x 5 L": "3x" quantity form (D5F,D6T)', () => {
    assert.equal(one('3x 5 L').lines[0].qty, 3);
  });
  test('WB-07 "two burgers": word quantity (D6F), plural alias', () => {
    assert.equal(one('two burgers').lines[0].qty, 2);
  });
  test('WB-08 "L": no name and no number -> item undefined (D21T), unresolved (D22T)', () => {
    assert.deepEqual(one('L').unresolved, ['l']);
  });
  test('WB-09 "nothing here": name not on menu (D18 -> undefined, D22T)', () => {
    assert.deepEqual(one('nothing here').unresolved, ['nothing here']);
  });
  test('WB-10 "margherita": pizza with no size -> Medium (D24 right, find M)', () => {
    assert.equal(one('margherita').lines[0].size, 'M');
  });
  test('WB-11 "number 5": the word "number" is skipped (D15F)', () => {
    assert.equal(one('number 5').lines[0].itemId, 'devilled-chicken');
  });
  test('WB-12 "L L margherita": second size word ignored (D13F: the extra size letter falls into the name)', () => {
    // "l" after a size is already set falls to rest -> name "l margherita" -> not on menu.
    assert.deepEqual(one('L L margherita').unresolved, ['l l margherita']);
  });
  test('WB-13 "margherita extra pineapple": unmatched modifier becomes a note (D26T)', () => {
    assert.equal(one('margherita extra pineapple').lines[0].note, 'extra pineapple');
  });
  test('WB-14 "2 3 4 margherita": a third number goes to the name (D7F,D10F) -> unresolved', () => {
    assert.equal(one('2 3 4 margherita').lines.length, 0);
  });
  test('WB-15 "coke 1l": item with no variants via the volume alias', () => {
    const l = one('coke 1l').lines[0];
    assert.deepEqual([l.itemId, l.qty, l.size], ['coca-cola-1l', 1, undefined]);
  });
  test('WB-16 an owner section item with sizes x1/x2 and no M falls back to its first size (D25 right)', () => {
    const shake = { id: 'sec-shakes-1', category: 'sec-shakes', name: { en: 'Milkshake' }, description: '', aliases: ['shake'],
      variants: [{ id: 'x1', label: 'Small', price: 50000 }, { id: 'x2', label: 'Big', price: 70000 }], price: 50000, adds: [], leaveOut: [] };
    const own = new ShorthandInterpreter([...MENU, shake] as typeof MENU);
    assert.equal(own.interpret('shake').lines[0].size, 'x1');
  });
});
