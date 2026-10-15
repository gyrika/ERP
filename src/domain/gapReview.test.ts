import test from 'node:test';
import assert from 'node:assert/strict';
import { asked, gapCases, shortStreaks, toCheck, weekLoss } from './gapReview.ts';
import { mayRecord } from './auth.ts';
import type { SyncEvent } from './sync.ts';
import { validatePush } from '../../server/validate.ts';

// The owner checks the gaps (SCRUM-95).

const ravi = { id: 'r', name: 'Ravi', role: 'manager' as const };
const nisal = { id: 'n', name: 'Owner', role: 'owner' as const };
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 9, 15, 20, 0).getTime();
const base = { shopId: 's', orderNumber: 0 as const };
const count = (id: string, at: number, valueCents: number, reason: 'spoiled' | null = 'spoiled', itemId = 'inv-0006'): SyncEvent =>
  ({ ...base, id, at, actor: ravi, type: 'stock.counted', itemId, counted: 1000, expected: 1500, entries: [], reason, valueCents, tier: 'daily', ...(reason ? { photo: 'ph-abcdefgh12' } : {}) });
const review = (id: string, countId: string, decision: 'ok' | 'ask', note = '', at = NOW): SyncEvent =>
  ({ ...base, id, at, actor: nisal, type: 'stock.gap_reviewed', itemId: 'inv-0006', countId, decision, note });
const answer = (id: string, countId: string, note: string): SyncEvent =>
  ({ ...base, id, at: NOW, actor: ravi, type: 'stock.gap_answered', itemId: 'inv-0006', countId, note });

test('each big gap is a case: open, asked (then answered), or OK; small gaps and undone counts are not', () => {
  const events = [
    count('c1', NOW - 3 * DAY, -130000),
    count('c2', NOW - 2 * DAY, -50000),
    count('small', NOW - DAY, -5000, null),
    count('gone', NOW - DAY, -90000),
    { ...base, id: 'u', at: NOW, actor: ravi, type: 'stock.count_undone', countId: 'gone' } as SyncEvent,
    review('r1', 'c1', 'ask', 'Spoiled how? It was new on Monday.'),
    answer('a1', 'c1', 'The fridge door was left open overnight.'),
    review('r2', 'c2', 'ok'),
  ];
  const cases = gapCases(events);
  assert.deepEqual(cases.map((c) => [c.countId, c.review.kind]), [['c2', 'ok'], ['c1', 'asked']]);
  const c1 = cases.find((c) => c.countId === 'c1')!;
  assert.equal(c1.photo, 'ph-abcdefgh12');
  assert.deepEqual(c1.review.kind === 'asked' && c1.review.answer?.note, 'The fridge door was left open overnight.');
  assert.deepEqual(toCheck(cases).map((c) => c.countId), ['c1']);
  assert.deepEqual(asked(cases), [], 'answered: nothing waits on the manager');
  assert.deepEqual(asked(gapCases(events.slice(0, 6))).map((c) => c.countId), ['c1']);
});

test('the week in counts: what went missing this week and the week before (small gaps too)', () => {
  const events = [count('a', NOW - DAY, -130000), count('b', NOW - 2 * DAY, -5000, null), count('c', NOW - 9 * DAY, -40000), count('d', NOW, 20000, null)];
  assert.deepEqual(weekLoss(events, NOW), { thisWeek: 135000, lastWeek: 40000 });
});

test('short three counts in a row is a pattern; a good count breaks it', () => {
  const events = [count('a', 1, -10000), count('b', 2, -20000), count('c', 3, -30000), count('x', 1, -10000, 'spoiled', 'inv-0001'), count('y', 2, 0, null, 'inv-0001'), count('z', 3, -9000, 'spoiled', 'inv-0001')];
  assert.deepEqual(shortStreaks(events), [{ itemId: 'inv-0006', counts: 3, cents: 60000 }]);
});

test('only the owner checks a gap; any manager answers; notes are short', () => {
  assert.equal(mayRecord('owner', 'stock.gap_reviewed'), true);
  assert.equal(mayRecord('manager', 'stock.gap_reviewed'), false);
  assert.equal(mayRecord('manager', 'stock.gap_answered'), true);
  assert.equal(mayRecord('cashier', 'stock.gap_answered'), false);
  const ok = { ...review('r', 'c1', 'ask', 'Why?'), shopId: 'shop-1' };
  assert.deepEqual(validatePush({ events: [ok] }, 'shop-1'), { events: [ok] });
  assert.ok('reason' in validatePush({ events: [{ ...ok, decision: 'maybe' }] }, 'shop-1'));
  assert.ok('reason' in validatePush({ events: [{ ...ok, note: 'x'.repeat(201) }] }, 'shop-1'));
});
