import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOW_CENTS, checkUnitName, countedBase, countedSince, countHistory, countsDue, dailyStreak, dayGrid, gapOf, reasonsFor, tiersOf,
  unitsOf, type Tier,
} from './counting.ts';
import { inventoryFromEvents } from './inventory.ts';
import { SEED_INVENTORY } from './inventoryData.ts';
import type { SyncEvent } from './sync.ts';
import { validatePush } from '../../server/validate.ts';

// Shelf counts (SCRUM-89).

const MOZZ = SEED_INVENTORY.find((i) => i.id === 'inv-0006')!; // a 2 kg block
const actor = { id: 'm', name: 'Manager', role: 'manager' as const };
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 9, 15, 20, 0).getTime();

test('count in packs, an opened pack by eye or weighed, kg or g, or a unit learned once', () => {
  const units = unitsOf({ ...MOZZ, units: [{ name: 'Slab', base: 500 }] });
  assert.deepEqual(units.map((u) => u.id), ['pack', 'unit:Slab', 'kg', 'g']);
  assert.equal(countedBase([{ unit: 'pack', qty: 3 }, { unit: 'pack', qty: 0.5 }], units), 7000);
  assert.equal(countedBase([{ unit: 'unit:Slab', qty: 2 }, { unit: 'g', qty: 450 }], units), 1450);
  assert.equal(countedBase([{ unit: 'kg', qty: 1.25 }], units), 1250);
  assert.equal(checkUnitName('Tray', MOZZ), null);
  assert.ok(checkUnitName('kg', MOZZ), 'built-in names are taken');
  assert.ok(checkUnitName('3', MOZZ));
});

test('a gap within 2% or under Rs 100 matches; beyond both it needs a reason', () => {
  const item = { packQty: 2000, workingPriceCents: 520000 }; // Rs 2.60 a gram
  assert.equal(gapOf(10000, 9850, item).big, false, '1.5% short: matches');
  assert.equal(gapOf(1000, 970, item).big, false, '3% but only Rs 78: matches');
  const g = gapOf(10000, 9400, item);
  assert.deepEqual(g, { delta: -600, valueCents: -156000, big: true });
  assert.ok(Math.abs(g.valueCents) >= ALLOW_CENTS);
  assert.deepEqual(reasonsFor(-1).map((r) => r.id), ['spoiled', 'spilled', 'staff-meal', 'delivery-short', 'miscounted', 'unknown']);
  assert.deepEqual(reasonsFor(1).map((r) => r.id), ['not-received', 'miscounted', 'unknown']);
});

test('the items carrying most of the spend are counted daily, then weekly, the rest monthly', () => {
  const rows = [
    { id: 'cheese', usedPerDay: 1000, packQty: 1000, workingPriceCents: 100000 }, // Rs 7,000 a week
    { id: 'flour', usedPerDay: 1000, packQty: 1000, workingPriceCents: 20000 }, // Rs 1,400
    { id: 'salt', usedPerDay: 100, packQty: 1000, workingPriceCents: 50000 }, // Rs 350
    { id: 'oregano', usedPerDay: 10, packQty: 100, workingPriceCents: 50000 }, // Rs 350
    { id: 'unused', usedPerDay: 0, packQty: 1, workingPriceCents: 900000 },
  ];
  assert.deepEqual(Object.fromEntries(tiersOf(rows)), { cheese: 'daily', flour: 'weekly', oregano: 'monthly', salt: 'monthly', unused: 'monthly' });
});

test('before the first sale the dearest packs start daily (8) and weekly (12)', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: `i${String(i).padStart(2, '0')}`, usedPerDay: 0, packQty: 1, workingPriceCents: (30 - i) * 1000 }));
  const tiers = tiersOf(rows);
  assert.equal(tiers.get('i00'), 'daily');
  assert.equal(tiers.get('i07'), 'daily');
  assert.equal(tiers.get('i08'), 'weekly');
  assert.equal(tiers.get('i19'), 'weekly');
  assert.equal(tiers.get('i20'), 'monthly');
});

test("the owner's choice wins over the automatic one", () => {
  const rows = [
    { id: 'cheese', usedPerDay: 1000, packQty: 1000, workingPriceCents: 100000, tier: 'monthly' as const },
    { id: 'flour', usedPerDay: 1000, packQty: 1000, workingPriceCents: 20000, tier: null },
    { id: 'salt', usedPerDay: 0, packQty: 1000, workingPriceCents: 50000, tier: 'daily' as const },
  ];
  assert.deepEqual(Object.fromEntries(tiersOf(rows)), { cheese: 'monthly', salt: 'daily', flour: 'daily' });
});

test('a tier set by the owner folds onto the item; null hands it back', () => {
  const set = (id: string, at: number, tier: Tier | null): SyncEvent =>
    ({ id, shopId: 's', at, orderNumber: 0, actor, type: 'stock.tier_set', itemId: MOZZ.id, tier });
  const row = (events: SyncEvent[]) => inventoryFromEvents(SEED_INVENTORY, events).find((r) => r.id === MOZZ.id)!;
  assert.equal(row([]).tier, null);
  assert.equal(row([set('a', 1, 'daily')]).tier, 'daily');
  assert.equal(row([set('a', 1, 'daily'), set('b', 2, null)]).tier, null);
  const push = (tier: unknown) => validatePush({ events: [{ id: 't', shopId: 'shop-1', at: 1, orderNumber: 0, actor, type: 'stock.tier_set', itemId: MOZZ.id, tier }] }, 'shop-1');
  assert.equal('reason' in push('weekly'), false);
  assert.equal('reason' in push(null), false);
  assert.equal('reason' in push('hourly'), true);
});

test("today's list: due by tier, overdue first, never-counted last; counted today drops off", () => {
  const tiers = new Map<string, Tier>([['a', 'daily'], ['b', 'weekly'], ['c', 'daily'], ['d', 'monthly'], ['e', 'daily']]);
  const due = countsDue([
    { id: 'a', lastCountedAt: NOW - DAY },
    { id: 'b', lastCountedAt: NOW - 20 * DAY },
    { id: 'c', lastCountedAt: NOW - 60_000 },
    { id: 'd', lastCountedAt: NOW - 10 * DAY },
    { id: 'e', lastCountedAt: null },
  ], tiers, NOW);
  assert.deepEqual(due.map((d) => `${d.id}:${d.state}`), ['b:overdue', 'a:due', 'e:never']);
});

const counted = (id: string, at: number, counted: number, expected: number): SyncEvent =>
  ({ id, shopId: 's', at, orderNumber: 0, actor, type: 'stock.counted', itemId: MOZZ.id, counted, expected, entries: [], reason: null, valueCents: 0, tier: 'daily' });

test('a count sets the shelf to what was counted, keeps sales made meanwhile, and Undo takes it back', () => {
  const row = (events: SyncEvent[]) => inventoryFromEvents(SEED_INVENTORY, events, { now: NOW }).find((r) => r.id === MOZZ.id)!;
  const first = row([counted('c1', NOW - DAY, 6000, 0)]);
  assert.equal(first.onHandBaseUnits, 6000);
  assert.equal(first.lastCountedAt, NOW - DAY);
  const again = row([counted('c1', NOW - DAY, 6000, 0), counted('c2', NOW - 60_000, 5400, 6000)]);
  assert.equal(again.onHandBaseUnits, 5400);
  const undone = row([
    counted('c1', NOW - DAY, 6000, 0), counted('c2', NOW - 60_000, 5400, 6000),
    { id: 'u', shopId: 's', at: NOW, orderNumber: 0, actor, type: 'stock.count_undone', countId: 'c2' },
  ]);
  assert.equal(undone.onHandBaseUnits, 6000);
  assert.equal(undone.lastCountedAt, NOW - DAY, 'the earlier count is the last one again');
});

test('a learned unit belongs to its item; base 0 removes it', () => {
  const unit = (id: string, name: string, base: number): SyncEvent =>
    ({ id, shopId: 's', at: 1, orderNumber: 0, actor, type: 'stock.unit_set', itemId: MOZZ.id, name, base });
  const units = (events: SyncEvent[]) => inventoryFromEvents(SEED_INVENTORY, events, { now: NOW }).find((r) => r.id === MOZZ.id)!.units;
  assert.deepEqual(units([unit('a', 'Slab', 500)]), [{ name: 'Slab', base: 500 }]);
  assert.deepEqual(units([unit('a', 'Slab', 500), unit('b', 'slab', 450)]), [{ name: 'slab', base: 450 }]);
  assert.deepEqual(units([unit('a', 'Slab', 500), unit('b', 'Slab', 0)]), []);
});

test('the server takes well-formed counts and units only', () => {
  const ok = { ...counted('c1', 1, 5400, 6000), shopId: 'shop-1', entries: [{ unit: 'pack', qty: 2.7 }], reason: 'spoiled', valueCents: -156000 };
  assert.deepEqual(validatePush({ events: [ok] }, 'shop-1'), { events: [ok] });
  for (const bad of [{ ...ok, reason: 'stolen?' }, { ...ok, counted: -1 }, { ...ok, tier: 'yearly' }, { ...ok, valueCents: 1.5 }]) {
    assert.ok('reason' in validatePush({ events: [bad] }, 'shop-1'));
  }
  const unit = { id: 'u', shopId: 'shop-1', at: 1, orderNumber: 0, actor, type: 'stock.unit_set', itemId: MOZZ.id, name: 'Tray', base: 30 };
  assert.deepEqual(validatePush({ events: [unit] }, 'shop-1'), { events: [unit] });
  assert.ok('reason' in validatePush({ events: [{ ...unit, base: -1 }] }, 'shop-1'));
});

// ----- progress -----


test('the record: undone counts drop out; each day shaded by how much of the daily count was done', () => {
  const at = (daysAgo: number) => NOW - daysAgo * DAY;
  const c = (id: string, item: string, daysAgo: number, reason: string | null = null): SyncEvent =>
    ({ id, shopId: 's', at: at(daysAgo), orderNumber: 0, actor, type: 'stock.counted', itemId: item, counted: 1, expected: 1, entries: [], reason: reason as never, valueCents: 0, tier: 'daily' });
  const history = countHistory([
    c('a', 'x', 0), c('b', 'y', 0),
    c('c', 'x', 1), c('d', 'y', 1, 'spoiled'),
    c('e', 'x', 2),
    c('f', 'x', 3), c('g', 'y', 3),
    { id: 'u', shopId: 's', at: at(3), orderNumber: 0, actor, type: 'stock.count_undone', countId: 'g' },
  ]);
  assert.equal(history.length, 6);
  const cells = dayGrid(history, new Set(['x', 'y']), NOW, 2);
  assert.equal(cells.length, 14);
  const byAgo = (n: number) => cells.find((cell) => cell.day === new Date(new Date(at(n)).setHours(0, 0, 0, 0)).getTime())!;
  assert.deepEqual([byAgo(0).level, byAgo(1).level, byAgo(2).level, byAgo(3).level], [3, 3, 2, 2]);
  assert.equal(byAgo(1).gaps, 1);
  assert.ok(cells.some((cell) => cell.level === null), 'days after today are blank');
  assert.equal(dailyStreak(cells, NOW), 2);
  assert.equal(countedSince(history, ['x', 'y', 'z'], at(0) - 3600_000), 2);
});

test('a streak survives today still being open', () => {
  const history = countHistory([
    { id: 'a', shopId: 's', at: NOW - DAY, orderNumber: 0, actor, type: 'stock.counted', itemId: 'x', counted: 1, expected: 1, entries: [], reason: null, valueCents: 0, tier: 'daily' },
  ]);
  assert.equal(dailyStreak(dayGrid(history, new Set(['x']), NOW, 2), NOW), 1);
});
