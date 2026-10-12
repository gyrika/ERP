import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoHistory } from '../fake/history.ts';
import { rulesSuggestions, salesFrom, type ShopData } from './insights.ts';
import { SEED_INVENTORY, SEED_SUPPLIERS } from './inventoryData.ts';
import type { SyncEvent } from './sync.ts';

const stock = { items: SEED_INVENTORY, suppliers: SEED_SUPPLIERS };
const friday = new Date(2026, 9, 9, 20, 30).getTime(); // a Friday evening, local time
const ids = (data: ShopData) => rulesSuggestions.insights(data).map((i) => i.id);

const actor = { id: 'n', name: 'Nimal', role: 'cashier' as const };
const paid = (orderNumber: number, at: number, total: number): SyncEvent =>
  ({ type: 'order.paid', id: `p${orderNumber}-${at}`, shopId: 's', at, actor, orderNumber, total, tender: 'cash', tendered: total });

test('the demo Friday: every kind of card, things needing a decision first, good news last', () => {
  const insights = rulesSuggestions.insights({ events: demoHistory(friday), now: friday, stock });
  assert.deepEqual(insights.map((i) => i.id), ['sales-vs-usual', 'voids', 'kitchen-slow', 'running-low', 'not-selling', 'best-seller']);
  const [sales, voids, kitchen, low, idle] = insights;
  assert.match(sales.title, /^Sales \d+% below a usual Friday$/);
  assert.match(voids.title, /voids today, \d+ by Ravi$/);
  assert.ok(voids.action.items.every((i) => i.secondary?.startsWith('Ravi')), 'each void says who and why');
  assert.match(kitchen.detail, /Usually \d+ min/);
  assert.equal(low.title, '2 items running low');
  assert.deepEqual(low.action.items.map((i) => i.primary).sort(), ['Mozzarella (Prabhat)', 'Pizza Flour']);
  assert.equal(idle.title, "BBQ Pork hasn't sold in 2 weeks");
});

test('the summary counts today only, and a payment undone does not count', () => {
  const today = new Date(friday); today.setHours(0, 0, 0, 0);
  const events: SyncEvent[] = [
    paid(1, today.getTime() - 1000, 999900), // yesterday
    paid(2, today.getTime() + 3_600_000, 250000),
    paid(3, today.getTime() + 7_200_000, 150000),
    { type: 'order.payment_undone', id: 'u3', shopId: 's', at: today.getTime() + 7_300_000, actor, orderNumber: 3 },
  ];
  assert.deepEqual(rulesSuggestions.summary({ events, now: friday }), { salesCents: 250000, orders: 1, averageCents: 250000 });
  assert.equal(salesFrom(events).length, 2);
});

test('a new shop: no history, so no "usual" to compare with, and no false alarms', () => {
  const day = new Date(friday); day.setHours(0, 0, 0, 0);
  const events = Array.from({ length: 30 }, (_, i) => paid(i + 1, day.getTime() + (12 * 60 + i) * 60_000, 300000));
  assert.deepEqual(ids({ events, now: friday, stock }), []);
});

test('sales well above usual is good news; within 20% says nothing', () => {
  const day = new Date(friday); day.setHours(0, 0, 0, 0);
  const at = (weeks: number, minute: number) => { const d = new Date(day); d.setDate(d.getDate() - 7 * weeks); return d.getTime() + minute * 60_000; };
  const pastFridays = [1, 2, 3, 4].flatMap((w) => [paid(100 + w, at(w, 12 * 60), 1000000)]);
  const up = rulesSuggestions.insights({ events: [...pastFridays, paid(1, at(0, 12 * 60), 1500000)], now: friday });
  assert.equal(up[0].tone, 'good');
  assert.equal(up[0].title, 'Sales 50% above a usual Friday');
  assert.deepEqual(ids({ events: [...pastFridays, paid(1, at(0, 12 * 60), 1100000)], now: friday }), []);
});

test('running low counts only items someone has counted', () => {
  const ravi = { id: 'r', name: 'Ravi', role: 'manager' as const };
  const events: SyncEvent[] = [
    { type: 'stock.adjusted', id: 's1', shopId: 's', at: 1, orderNumber: 0, actor: ravi, itemId: 'inv-0001', deltaPacks: 1 },
    { type: 'stock.adjusted', id: 's2', shopId: 's', at: 2, orderNumber: 0, actor: ravi, itemId: 'inv-0006', deltaPacks: 9 },
  ];
  const low = rulesSuggestions.insights({ events, now: friday, stock });
  assert.deepEqual(low.map((i) => i.title), ['1 item running low']);
  assert.match(low[0].action.items[0].secondary ?? '', /1 pack left · Prima/);
});
