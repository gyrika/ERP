import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balanceDue } from './order.ts';
import type { PaidOrder } from './types.ts';

const paid = (over: Partial<PaidOrder> = {}): PaidOrder => ({
  number: 1001, sentAt: 1,
  lines: [{ id: 'a', itemId: 'margherita', qty: 1, size: 'M', adds: [], outs: [], sent: true, unit: 145000 }],
  total: 145000, tender: 'cash', tendered: 150000, change: 5000, paidAt: 2, ...over,
});

test('a paid order changed afterwards (SCRUM-242) owes the difference, either way, until settled', () => {
  assert.equal(balanceDue(paid()), 0);
  const large = paid({ lines: [{ ...paid().lines[0], size: 'L', unit: 205000 }] });
  assert.equal(balanceDue(large), 60000, 'Medium to Large: Rs 600 more');
  assert.equal(balanceDue({ ...large, settled: 60000 }), 0);
  assert.equal(balanceDue(paid({ lines: [] })), -145000, 'all taken off: all back');
  assert.equal(balanceDue({ ...large, tender: 'comp', total: 0 }), 0, 'a Free order owes nothing');
  assert.equal(balanceDue({ ...large, tender: 'uber' }), 0, 'a delivery app settles with the app');
});
