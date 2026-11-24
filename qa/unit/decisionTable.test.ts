/**
 * EC4206 3.3 Decision table for the bill total (src/domain/totals.ts).
 * Conditions: C1 discount (none | percent 10% | Free), C2 delivery order, C3 line adjustment.
 * Bill: 1 x Margherita M (Rs 1,450) + 1 x Chicken burger (Rs 450) = Rs 1,900.00 subtotal.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { totals } from '../../src/domain/totals.ts';
import type { Discount, Order } from '../../src/domain/types.ts';

const FEE = 15000; // Rs 150 delivery (3 started km at Rs 50)
const bill = (discount: Discount | undefined, delivery: boolean, lineOff: number): Order => ({
  number: 42,
  lines: [
    { id: 'a', itemId: 'margherita', qty: 1, size: 'M', adds: [], outs: [] },
    { id: 'b', itemId: 'chicken-burger', qty: 1, adds: [], outs: [] },
  ],
  adjust: { ...(discount ? { discount } : {}), ...(lineOff ? { lines: { b: lineOff } } : {}) },
  ...(delivery ? { delivery: { fee: FEE } } : {}),
}) as Order;

const P10: Discount = { kind: 'percent', pct: 10 };
const FREE: Discount = { kind: 'comp' };
// [rule, discount, delivery, line adjustment (cents), expected total (cents)]
const rules: [string, Discount | undefined, boolean, number, number][] = [
  ['R1', undefined, false, 0, 190000],
  ['R2', undefined, true, 0, 205000],
  ['R3', undefined, false, 5000, 185000],
  ['R4', undefined, true, 5000, 200000],
  ['R5', P10, false, 0, 171000],
  ['R6', P10, true, 0, 186000],     // fee is never discounted
  ['R7', P10, false, 5000, 166500], // 10% of what is left after the line adjustment
  ['R8', P10, true, 5000, 181500],
  ['R9', FREE, false, 0, 0],
  ['R10', FREE, true, 0, 0],        // Free waives the delivery fee
  ['R11', FREE, false, 5000, 0],
  ['R12', FREE, true, 5000, 0],
];

describe('DT-1 bill total decision table', () => {
  for (const [id, d, del, off, want] of rules) {
    test(`${id} discount=${d ? (d.kind === 'comp' ? 'Free' : `${d.pct}%`) : 'none'} delivery=${del ? 'Y' : 'N'} lineAdj=${off ? 'Y' : 'N'} -> ${want}`, () => {
      const t = totals(bill(d, del, off));
      assert.equal(t.total, want);
      // Invariant from totals.ts: total + adjustments === subtotal + fee, to the cent.
      assert.equal(t.total + t.lineAdjust + t.orderDiscount, t.subtotal + t.deliveryFee);
    });
  }
});
