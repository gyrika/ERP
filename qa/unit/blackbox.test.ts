/**
 * EC4206 3.3 Black-box tests: Equivalence Partitioning (EP) and Boundary Value Analysis (BVA).
 * Test IDs match the tables in the report. Known open defects run as `todo` so CI stays green
 * while the defect is visible in the output.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseLKR, quickCashAmounts, fmt } from '../../src/domain/money.ts';
import { percentOf, discountAmount } from '../../src/domain/totals.ts';
import { ShorthandInterpreter } from '../../src/domain/parser.ts';
import { MENU } from '../../src/domain/menu.ts';

const parser = new ShorthandInterpreter(MENU);
const first = (s: string) => parser.interpret(s).lines[0];

describe('EP-1 cash amount field (parseLKR)', () => {
  const cases: [string, string, number | null][] = [
    ['EP1-V1', '500', 50000],            // valid: whole rupees
    ['EP1-V2', '1,250.25', 125025],      // valid: thousands separator + cents
    ['EP1-V3', 'Rs 500', 50000],         // valid: currency prefix
    ['EP1-I1', '', null],                // invalid: empty
    ['EP1-I2', 'abc', null],             // invalid: not a number
    ['EP1-I3', '-1', null],              // invalid: negative
    ['EP1-I4', '1.505', null],           // invalid: more than 2 decimals
    ['EP1-I5', '1,00', null],            // invalid: badly grouped thousands
    ['EP1-I6', '1e3', null],             // invalid: scientific notation
  ];
  for (const [id, input, want] of cases) test(`${id} "${input}" -> ${want}`, () => assert.equal(parseLKR(input), want));
});

describe('EP-2 typed order quantity (ShorthandInterpreter)', () => {
  test('EP2-V1 digit quantity "2 margherita" -> qty 2', () => assert.equal(first('2 margherita').qty, 2));
  test('EP2-V2 word quantity "two burgers" -> qty 2', () => assert.equal(first('two burgers').qty, 2));
  test('EP2-V3 no quantity "burger" -> qty 1', () => assert.equal(first('burger').qty, 1));
  test('EP2-I1 negative "-1 margherita" -> unresolved', () => assert.deepEqual(parser.interpret('-1 margherita').unresolved, ['-1 margherita']));
  test('EP2-I2 zero "0 margherita" is refused (BUG-03)', { todo: 'BUG-03: zero quantity silently becomes 1' }, () =>
    assert.equal(parser.interpret('0 margherita').lines.length, 0));
  test('EP2-I3 absurd "1000000000000000000000 burger" is refused (BUG-02)', { todo: 'BUG-02: no upper bound on typed quantity' }, () =>
    assert.equal(parser.interpret('1000000000000000000000 burger').lines.length, 0));
});

describe('EP-3 pizza size word', () => {
  test('EP3-V1 "L margherita" -> L', () => assert.equal(first('L margherita').size, 'L'));
  test('EP3-V2 "large margherita" -> L', () => assert.equal(first('large margherita').size, 'L'));
  test('EP3-V3 no size -> M (default)', () => assert.equal(first('margherita').size, 'M'));
  test('EP3-I1 unknown size "xl" is reported, not silently M (BUG-05)', { todo: 'BUG-05: unknown size word dropped silently' }, () =>
    assert.ok(first('margherita xl').note?.includes('xl')));
});

describe('BVA-1 order discount percent on Rs 100.00 (10000 cents), valid range 0..100', () => {
  const cases: [string, number, number][] = [
    ['BVA1-01', -1, 0],      // just below min: must never raise the bill (BUG-01, fixed)
    ['BVA1-02', 0, 0],       // min
    ['BVA1-03', 1, 100],     // just above min
    ['BVA1-04', 50, 5000],   // nominal
    ['BVA1-05', 99, 9900],   // just below max
    ['BVA1-06', 100, 10000], // max
    ['BVA1-07', 101, 10000], // just above max: capped at the bill
  ];
  for (const [id, pct, want] of cases) test(`${id} pct ${pct} -> ${want} cents off`, () =>
    assert.equal(discountAmount(10000, { kind: 'percent', pct }), want));
});

describe('BVA-2 percent rounding half-up at the cent boundary (10%)', () => {
  test('BVA2-01 14 cents -> 1 (1.4 rounds down)', () => assert.equal(percentOf(14, 10), 1));
  test('BVA2-02 15 cents -> 2 (1.5 rounds up)', () => assert.equal(percentOf(15, 10), 2));
  test('BVA2-03 16 cents -> 2', () => assert.equal(percentOf(16, 10), 2));
});

describe('BVA-3 quick cash buttons around the Rs 100 note (10000 cents)', () => {
  test('BVA3-01 total 0 -> no buttons', () => assert.deepEqual(quickCashAmounts(0), []));
  test('BVA3-02 total 1 -> exact + 100/500/1k/5k', () => assert.deepEqual(quickCashAmounts(1), [1, 10000, 50000, 100000, 500000]));
  test('BVA3-03 total 9999 -> 9999 first, then Rs 100', () => assert.deepEqual(quickCashAmounts(9999).slice(0, 2), [9999, 10000]));
  test('BVA3-04 total 10000 -> exact is Rs 100, no duplicate', () => assert.deepEqual(quickCashAmounts(10000), [10000, 50000, 100000, 500000]));
  test('BVA3-05 total 10001 -> next Rs 100 step is 200', () => assert.deepEqual(quickCashAmounts(10001).slice(0, 2), [10001, 20000]));
  test('BVA3-06 total 500000 -> exact and next Rs 5k', () => assert.deepEqual(quickCashAmounts(500000), [500000, 1000000]));
});

describe('BVA-4 cash amount field size (safe integer cents)', () => {
  test('BVA4-01 max safe "90071992547409.91" -> 9007199254740991', () => assert.equal(parseLKR('90071992547409.91'), Number.MAX_SAFE_INTEGER));
  test('BVA4-02 max safe + 1 cent -> null', () => assert.equal(parseLKR('90071992547409.92'), null));
  test('BVA4-03 min "0" -> 0', () => assert.equal(parseLKR('0'), 0));
  test('BVA4-04 min + 1 "0.01" -> 1', () => assert.equal(parseLKR('0.01'), 1));
});

test('EP-4 negative amount display (BUG-04)', { todo: 'BUG-04: fmt(-150) prints "-2.-50"' }, () => assert.equal(fmt(-150), '-1.50'));
