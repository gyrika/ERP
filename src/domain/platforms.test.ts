import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanCode, isPlatformMark, platformLabel, PLATFORMS } from './platforms.ts';
import { ticketsFromEvents } from './kitchen.ts';
import type { SyncEvent } from './sync.ts';

test('Uber Eats is the shop\'s one delivery app today', () => {
  assert.deepEqual(PLATFORMS, [{ id: 'uber', name: 'Uber Eats' }]);
  assert.equal(platformLabel({ id: 'uber', code: '4F2A9' }), 'Uber Eats · 4F2A9');
});

test('the app\'s order code as typed: trimmed, upper case, a # in front dropped; nothing odd', () => {
  assert.equal(cleanCode(' 4f2a9 '), '4F2A9');
  assert.equal(cleanCode('#A1-22'), 'A1-22');
  for (const bad of ['', '4', '4F 2A', '4F2A9<script>', 'x'.repeat(21)]) assert.equal(cleanCode(bad), null, bad);
});

test('a mark in an event: a known app and a clean code only', () => {
  assert.ok(isPlatformMark({ id: 'uber', code: '4F2A9' }));
  assert.ok(!isPlatformMark({ id: 'pickme', code: '4F2A9' }), 'not on PickMe yet');
  assert.ok(!isPlatformMark({ id: 'uber', code: '4f2a9' }), 'kept as cleaned');
  assert.ok(!isPlatformMark(null));
});

test('the kitchen ticket carries the app and its code', () => {
  const sent = {
    id: 'e1', shopId: 's', at: 1, orderNumber: 1001, actor: { id: 'c', name: 'Nimal', role: 'cashier' }, type: 'order.sent', ticketId: 't1',
    lines: [{ id: 'l1', itemId: 'margherita', qty: 1, size: 'M', adds: [], outs: [], sent: true }], addOn: false, platform: { id: 'uber', code: '4F2A9' },
  } as SyncEvent;
  assert.deepEqual(ticketsFromEvents([sent], 2)[0].platform, { id: 'uber', code: '4F2A9' });
});
