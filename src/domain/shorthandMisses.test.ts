import test from 'node:test';
import assert from 'node:assert/strict';
import { checkMiss, MISS_PARTS_MAX, MISS_TEXT_MAX, missFrom } from './shorthandMisses.ts';
import { mayRecord } from './auth.ts';

test('a miss keeps what was typed and the unread parts, trimmed to what the server accepts', () => {
  assert.deepEqual(missFrom('  2 l margherita, bbq chkn  ', [' bbq chkn ']), { text: '2 l margherita, bbq chkn', unresolved: ['bbq chkn'] });
  const long = missFrom('x'.repeat(500), Array.from({ length: 20 }, (_, i) => `part ${i}`));
  assert.equal(long?.text.length, MISS_TEXT_MAX);
  assert.equal(long?.unresolved.length, MISS_PARTS_MAX);
  assert.equal(checkMiss(long?.text, long?.unresolved, false), null);
});

test('nothing unread, nothing recorded', () => {
  assert.equal(missFrom('2 l margherita', []), null);
  assert.equal(missFrom('2 l margherita', ['  ']), null);
  assert.equal(missFrom('   ', ['bbq']), null);
});

test('the server refuses a miss without text, without unread parts or without gaveUp', () => {
  assert.equal(checkMiss('bbq chkn', ['bbq chkn'], true), null);
  assert.ok(checkMiss('', ['bbq'], true));
  assert.ok(checkMiss('x'.repeat(MISS_TEXT_MAX + 1), ['bbq'], true));
  assert.ok(checkMiss('bbq', [], true));
  assert.ok(checkMiss('bbq', [''], true));
  assert.ok(checkMiss('bbq', [3], true));
  assert.ok(checkMiss('bbq', ['bbq'], 'yes'));
});

test('anyone who types orders may record a miss; the kitchen does not type orders', () => {
  assert.equal(mayRecord('cashier', 'shorthand.missed'), true);
  assert.equal(mayRecord('manager', 'shorthand.missed'), true);
  assert.equal(mayRecord('owner', 'shorthand.missed'), true);
  assert.equal(mayRecord('kitchen', 'shorthand.missed'), false);
});
