import test from 'node:test';
import assert from 'node:assert/strict';
import { passes, toggleChip } from './filters.ts';

// SCRUM-187: filters that combine: any within a group, all across groups.

const flour = { status: ['low'], kind: ['raw'], wh: ['wh-1', 'wh-2'] };
const dough = { status: [], kind: ['semi'], wh: ['wh-3'] };

test('nothing picked: everything passes', () => {
  assert.equal(passes(new Set(), flour), true);
});

test('within a group any picked one will do', () => {
  assert.equal(passes(new Set(['kind:raw', 'kind:semi']), dough), true);
  assert.equal(passes(new Set(['status:low', 'status:out']), flour), true);
});

test('across groups all must hold: Low and in Warehouse 2', () => {
  assert.equal(passes(new Set(['status:low', 'wh:wh-2']), flour), true);
  assert.equal(passes(new Set(['status:low', 'wh:wh-3']), flour), false);
  assert.equal(passes(new Set(['status:low', 'wh:wh-3']), dough), false);
});

test('a chip toggles on and off, leaving the others', () => {
  const a = toggleChip(new Set(['status:low']), 'wh:wh-2');
  assert.deepEqual([...a], ['status:low', 'wh:wh-2']);
  assert.deepEqual([...toggleChip(a, 'status:low')], ['wh:wh-2']);
});
