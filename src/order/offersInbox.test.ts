import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEEP_MAX, keepOffers, unseenCount, type Offer } from './offersInbox.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 14, 6, 0);
const offer = (daysAgo: number, n = 0): Offer => ({ id: `${daysAgo}-${n}`, title: `Offer ${daysAgo}`, body: '', at: NOW - daysAgo * DAY - n });

test('the phone keeps the newest first, nothing older than 90 days, at most 50', () => {
  assert.deepEqual(keepOffers([offer(5), offer(100), offer(1), offer(89)], NOW).map((o) => o.id), ['1-0', '5-0', '89-0']);
  const many = Array.from({ length: 70 }, (_, i) => offer(1, i));
  const kept = keepOffers(many, NOW);
  assert.equal(kept.length, KEEP_MAX);
  assert.equal(kept[0].id, '1-0', 'the newest stay');
});

test('new: what arrived since the list was last opened', () => {
  const list = [offer(0), offer(2), offer(6)];
  assert.equal(unseenCount(list, 0), 3);
  assert.equal(unseenCount(list, NOW - 3 * DAY), 2);
  assert.equal(unseenCount(list, NOW), 0);
});
