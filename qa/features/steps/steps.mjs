import { Given, When, Then } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { ShorthandInterpreter } from '../../../src/domain/parser.ts';
import { MENU } from '../../../src/domain/menu.ts';
import { addLines, emptyOrder } from '../../../src/domain/order.ts';
import { totals } from '../../../src/domain/totals.ts';
import { parseLKR } from '../../../src/domain/money.ts';
import { validatePush } from '../../../server/validate.ts';

const parser = new ShorthandInterpreter(MENU);
const rs = (text) => parseLKR(text);

Given('an empty bill', function () { this.order = emptyOrder(42); });
When('I type {string}', function (typed) { this.order = addLines(this.order, parser.interpret(typed).lines); });
Given('the order is a delivery with a fee of Rs {}', function (fee) { this.order = { ...this.order, delivery: { fee: rs(fee) } }; });
When('the manager gives {int}% off', function (pct) {
  this.discount = { kind: 'percent', pct };
  this.order = { ...this.order, adjust: { ...this.order.adjust, discount: this.discount } };
});
When('the manager makes the order Free', function () { this.order = { ...this.order, adjust: { discount: { kind: 'comp' } } }; });

Then('the bill has {int} lines', function (n) { assert.equal(this.order.lines.length, n); });
Then('line {int} is {int} x {string}', function (i, qty, item) {
  const l = this.order.lines[i - 1];
  assert.deepEqual([l.qty, l.itemId], [qty, item]);
});
Then('line {int} is {int} x {string} size {string}', function (i, qty, item, size) {
  const l = this.order.lines[i - 1];
  assert.deepEqual([l.qty, l.itemId, l.size], [qty, item, size]);
});
Then('line {int} is {int} x {string} size {string} without {string}', function (i, qty, item, size, out) {
  const l = this.order.lines[i - 1];
  assert.deepEqual([l.qty, l.itemId, l.size], [qty, item, size]);
  assert.ok(l.outs.includes(out));
});
Then('the net amount is Rs {}', function (amount) { assert.equal(totals(this.order).total, rs(amount)); });
Then('the discount line shows Rs {}', function (amount) { assert.equal(totals(this.order).orderDiscount, rs(amount)); });
Then('the sync server refuses the discount', function () {
  const event = { id: 'bdd-1', shopId: 'shop-qa', at: 1, orderNumber: 42, type: 'order.discount_set',
    actor: { id: 'm1', name: 'Ravi', role: 'manager' }, totalBefore: 190000, totalAfter: 190000, before: null, after: this.discount };
  assert.ok('reason' in validatePush({ events: [event] }, 'shop-qa'), 'the server accepted a negative discount');
});
