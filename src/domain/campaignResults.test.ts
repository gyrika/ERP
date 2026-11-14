import assert from 'node:assert/strict';
import { test } from 'node:test';
import { campaignResult, RESULT_DAYS, resultText } from './campaignResults.ts';
import type { Visit } from './customers.ts';

const DAY = 86_400_000;
const SENT = Date.UTC(2026, 10, 1, 6, 0);
const visit = (daysAfter: number, total: number): Visit => ({ saleId: `s${daysAfter}-${total}`, orderNumber: 1001, at: SENT + daysAfter * DAY, total });
const fmt = (c: number) => (c / 100).toLocaleString('en-GB');

const visits = new Map<string, Visit[]>([
  ['a', [visit(-10, 100_000), visit(2, 250_000), visit(5, 150_000)]], // reached, came twice in the week
  ['b', [visit(-3, 90_000)]], // reached, did not come
  ['c', [visit(9, 300_000)]], // reached, came after the week: not counted
  ['x', [visit(1, 80_000)]], // not reached (no app), came anyway
  ['y', []],
]);

test('a week after: who it reached and came in, what they spent, the others beside them', () => {
  const r = campaignResult(SENT, ['a', 'b', 'c'], ['x', 'y'], visits, SENT + 20 * DAY);
  assert.deepEqual(r, { reached: 3, cameIn: 1, spent: 400_000, compared: 2, comparedCameIn: 1, final: true });
  assert.deepEqual(resultText(r, fmt), { brought: '1 of 3 came in · Rs 4,000', others: 'Others in it: 1 of 2 (50%) vs 33%' });
});

test('during the week: only what happened so far, and it says so', () => {
  const r = campaignResult(SENT, ['a', 'b', 'c'], ['x', 'y'], visits, SENT + 3 * DAY);
  assert.equal(r.final, false);
  assert.equal(r.spent, 250_000); // the visit on day 5 has not happened yet
  assert.equal(resultText(r, fmt).brought, '1 of 3 came in so far · Rs 2,500');
});

test('a visit at the moment of sending is not the campaign; the last moment of the week is', () => {
  const edge = new Map<string, Visit[]>([['a', [{ saleId: 's', orderNumber: 1, at: SENT, total: 1 }]], ['b', [{ saleId: 't', orderNumber: 2, at: SENT + RESULT_DAYS * DAY, total: 2 }]]]);
  const r = campaignResult(SENT, ['a', 'b'], [], edge, SENT + 30 * DAY);
  assert.equal(r.cameIn, 1);
  assert.equal(r.spent, 2);
});

test('nobody reached, nobody to compare: plain words, no percentages over nothing', () => {
  const r = campaignResult(SENT, [], [], visits, SENT + 30 * DAY);
  assert.deepEqual(resultText(r, fmt), { brought: 'Reached nobody', others: null });
  const some = campaignResult(SENT, [], ['x'], visits, SENT + 30 * DAY);
  assert.equal(resultText(some, fmt).others, 'Others in it: 1 of 1 (100%)');
});

test('the same customer twice in a list counts once', () => {
  const r = campaignResult(SENT, ['a', 'a'], ['x', 'x'], visits, SENT + 30 * DAY);
  assert.equal(r.reached, 1);
  assert.equal(r.compared, 1);
});
