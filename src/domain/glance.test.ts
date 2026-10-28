import test from 'node:test';
import assert from 'node:assert/strict';
import { glanceOf } from './glance.ts';
import type { Insight } from './insights.ts';
import { SEED_INVENTORY, SEED_SUPPLIERS } from './inventoryData.ts';
import type { SyncEvent } from './sync.ts';
import type { Tender } from './types.ts';

// SCRUM-173: the shop at a glance, and the words behind each number.

const NOW = new Date(2026, 9, 26, 17, 20).getTime(); // a Monday, 5:20 pm
const at = (daysBack: number, h: number, m = 0) => { const d = new Date(NOW); d.setDate(d.getDate() - daysBack); d.setHours(h, m, 0, 0); return d.getTime(); };
const ravi = { id: 'c1', name: 'Ravi', role: 'cashier' as const };
let n = 0;
const paid = (when: number, rupees: number, tender: Tender = 'cash'): SyncEvent =>
  ({ id: `p${++n}`, shopId: 's', at: when, orderNumber: 1000 + n, actor: ravi, type: 'order.paid', total: rupees * 100, tender, tendered: rupees * 100 });
const shop = { items: SEED_INVENTORY, suppliers: SEED_SUPPLIERS };
/** The last 4 Mondays: Rs 2,000 at noon and Rs 1,000 at 7 pm each. */
const usualMondays = [7, 14, 21, 28].flatMap((d) => [paid(at(d, 12), 2000), paid(at(d, 19), 1000)]);
const todays = [paid(at(0, 12, 30), 3000), paid(at(0, 13, 10), 1000, 'transfer')];
const glance = (events: SyncEvent[], insights: Insight[] = []) => glanceOf(events, shop, insights, NOW);

test('the ring: today against a usual day for this weekday, and how it is worked out', () => {
  const g = glance([...usualMondays, ...todays]);
  assert.equal(g.sales, 400000);
  assert.equal(g.orders, 2);
  assert.equal(g.usualDay, 300000);
  assert.ok(Math.abs(g.share! - 4 / 3) < 1e-9);
  assert.match(g.ringExplain, /By 5:20 pm a usual Monday has made Rs 2,000, and Rs 3,000 by closing\./);
});

test('no history for this weekday: no usual, and the screen says so', () => {
  const g = glance(todays);
  assert.equal(g.usualDay, null);
  assert.equal(g.share, null);
  assert.match(g.ringExplain, /No usual yet/);
  assert.match(g.summary, /Rs 4,000 from 2 orders so far\./);
});

test('sales by hour: the hours the shop sells in; today against usual; later hours still to come', () => {
  const { hours } = glance([...usualMondays, ...todays]);
  assert.deepEqual(hours.map((h) => h.hour), [12, 13, 14, 15, 16, 17, 18, 19]);
  assert.deepEqual([hours[0].today, hours[0].usual], [300000, 200000]);
  assert.match(hours[0].explain, /^12 pm: Rs 3,000\.\nA usual Monday: Rs 2,000\.\nRs 1,000 more than usual\.$/);
  assert.equal(hours[7].today, null);
  assert.match(hours[7].explain, /^7 pm: still to come\.\nA usual Monday makes Rs 1,000 in this hour\.$/);
});

test('the day in a sentence: the pace, the busiest hour, and what needs the owner first', () => {
  const low: Insight = { id: 'running-low', tone: 'attention', title: '3 items running low', detail: '', action: { label: 'Order list', items: [] } };
  const g = glance([...usualMondays, ...todays], [low]);
  assert.equal(g.summary, 'Good evening. Rs 4,000 so far, 100% above a usual Monday.\nBusiest hour: 12 pm (Rs 3,000).\nNeeds you: 3 items running low.');
  assert.match(glance([...usualMondays, ...todays]).summary, /Nothing needs you right now\.$/);
});

test('Money splits what was taken by how it was paid', () => {
  const money = glance([...usualMondays, ...todays]).stations.find((s) => s.id === 'money')!;
  assert.equal(money.value, 'Rs 4,000');
  assert.match(money.explain, /Cash: Rs 3,000\nBank transfer: Rs 1,000/);
});

test('Shelves and the stock dots: the value, each item in words, never-counted items apart', () => {
  const counted: SyncEvent = { id: 'c1', shopId: 's', at: at(1, 9), orderNumber: 0, actor: ravi, type: 'stock.counted', itemId: 'inv-0001',
    counted: 5000, expected: 0, entries: [], reason: null, valueCents: 0, tier: 'daily' };
  const g = glance([counted]);
  const shelves = g.stations.find((s) => s.id === 'shelves')!;
  assert.equal(shelves.value, 'Rs 1,280'); // 5 kg of flour at Rs 6,400 a 25 kg bag
  assert.equal(g.stock.unknown, SEED_INVENTORY.length - 1);
  const flour = g.stock.dots.find((d) => d.id === 'inv-0001')!;
  assert.equal(flour.status, 'ok');
  assert.match(flour.explain, /^Pizza Flour: in stock\.\n¼ pack · 5 kg on hand, worth Rs 1,280\./);
  assert.match(g.stock.dots.find((d) => d.id === 'inv-0005')!.explain, /never counted/);
});

test('every Rs 100 sold adds up to 100, and is not shown before the first sale', () => {
  assert.equal(glance(usualMondays).split, null);
  const sent: SyncEvent = { id: 's1', shopId: 's', at: at(0, 12, 20), orderNumber: 1, actor: ravi, type: 'order.sent', ticketId: 't1', addOn: false,
    lines: [{ id: 'l1', itemId: 'margherita', size: 'L', qty: 1, adds: [], outs: [] }] };
  const split = glance([...todays, sent]).split!;
  assert.equal(split.food + split.waste + split.kept, 100);
  assert.match(split.explain, /^Of every Rs 100 sold today:/);
});

test('Money: Uber Eats orders are counted, and said to be paid later by Uber, not in the drawer', () => {
  const money = glance([...todays, paid(at(0, 14), 2500, 'uber')]).stations.find((s) => s.id === 'money')!;
  assert.match(money.explain, /Uber Eats: Rs 2,500/);
  assert.match(money.explain, /Uber Eats pays the shop later, less its commission: not in the drawer\./);
});
