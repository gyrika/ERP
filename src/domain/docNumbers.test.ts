import test from 'node:test';
import assert from 'node:assert/strict';
import type { SyncEvent } from './sync.ts';
import { docNumber, isPending, numberingOf, numbersFor, pendingNumber, unnumbered } from './docNumbers.ts';

const actor = { id: 'm', name: 'Ravi', role: 'manager' as const };
const po = (id: string, extra: object = {}): SyncEvent => ({ id, shopId: 's', at: 1, orderNumber: 0, actor, type: 'stock.ordered', supplierId: 'x', lines: [{ itemId: 'i', packs: 1 }], ...extra });

test('numbers are PO-0001 and GRN-0001; pending is plain words', () => {
  assert.equal(docNumber('PO', 1), 'PO-0001');
  assert.equal(docNumber('GRN', 12345), 'GRN-12345');
  assert.equal(pendingNumber('PO'), 'PO (pending)');
  assert.equal(isPending(pendingNumber('GRN')), true);
  assert.equal(isPending('GRN-0001'), false);
});

test('the next number follows the highest given, per kind; older documents count', () => {
  const state = numberingOf([po('a', { poNo: 'PO-0005' }), po('b'), { id: 'n', shopId: 's', at: 1, orderNumber: 0, actor, type: 'stock.numbered', docId: 'b', kind: 'PO', number: 'PO-0009' }]);
  assert.deepEqual(state.last, { PO: 9, GRN: 0 });
  assert.deepEqual([...state.numbered].sort(), ['a', 'b']);
  assert.deepEqual(unnumbered([po('a'), po('c')], numberingOf([po('a', { poNo: 'PO-0001' })])), [{ id: 'c', kind: 'PO' }]);
});

test('a document is numbered once; the record is named after it so storing it twice stores it once', () => {
  const state = numberingOf([]);
  const first = numbersFor('s', 5, [{ id: 'd1', kind: 'PO' }, { id: 'd2', kind: 'GRN' }, { id: 'd3', kind: 'PO' }], state);
  assert.deepEqual(first.map((e) => e.type === 'stock.numbered' && [e.id, e.number]), [['num-d1', 'PO-0001'], ['num-d2', 'GRN-0001'], ['num-d3', 'PO-0002']]);
  assert.deepEqual(numbersFor('s', 6, [{ id: 'd1', kind: 'PO' }], state), []);
});
