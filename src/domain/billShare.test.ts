import test from 'node:test';
import assert from 'node:assert/strict';
import { billOfLine, billParts, BILLS_NODE, cookMinutesSold } from './billShare.ts';
import { RATES_QUESTION, recipeQuestion, resourcesQuestion, type Answer } from './costing.ts';
import { SEED_INVENTORY } from './inventoryData.ts';
import { MENU } from './menu.ts';
import type { MoneyWhat } from './moneyOut.ts';
import { buildFlow } from './visualFlow.ts';

const owner = { id: 'owner-1', name: 'Owner', role: 'owner' as const };
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();
const NOW = at(2026, 11, 2);
const pizza = MENU.find((m) => m.category === 'pizza')!;
const burger = MENU.find((m) => m.category === 'burger')!;

let id = 0;
const sent = (when: number, itemId: string, qty: number, half?: string) =>
  ({ id: `e${++id}`, type: 'order.sent', at: when, ticketId: `t${id}`, lines: [{ itemId, qty, ...(half ? { half } : {}) }] });
const paid = (what: MoneyWhat, cents: number, when: number, month?: string) =>
  ({ id: `e${++id}`, shopId: 's', type: 'money.out', at: when, orderNumber: 0, actor: owner, what, from: 'bank', cents, ...(month ? { month } : {}) });

test('cook minutes: a pizza 10, a burger 3; a half and half counts half each; an undone send counts nothing', () => {
  const undone = sent(at(2026, 10, 5), pizza.id, 5);
  const events = [
    sent(at(2026, 10, 3), pizza.id, 2), sent(at(2026, 10, 4), burger.id, 10), sent(at(2026, 10, 4), pizza.id, 1, burger.id),
    undone, { type: 'order.send_undone', at: at(2026, 10, 5), ticketId: undone.ticketId },
    sent(at(2026, 11, 1), pizza.id, 100),
  ];
  assert.equal(cookMinutesSold(events, MENU, at(2026, 10, 1), at(2026, 11, 1) - 1), 20 + 30 + 6.5);
});

test('electricity: the latest finished month, over that month\'s sales; shares add up to the bill', () => {
  const events = [
    paid('electricity', 40_000_00, at(2026, 9, 10), '2026-08'),
    paid('electricity', 50_000_00, at(2026, 11, 1), '2026-10'),
    paid('electricity', 99_000_00, at(2026, 11, 1), '2026-11'), // this month: its sales are not all in
    sent(at(2026, 10, 10), pizza.id, 100), sent(at(2026, 10, 11), burger.id, 100),
    sent(at(2026, 9, 10), pizza.id, 999),
  ];
  const [p] = billParts(events, MENU, NOW);
  assert.equal(p.kind, 'electricity');
  assert.equal(p.cents, 50_000_00);
  assert.equal(p.minutes, 1300);
  assert.ok(Math.abs(p.perMinute * 10 * 100 + p.perMinute * 3 * 100 - p.cents) < 1e-6);
});

test('gas counts from cylinder to cylinder: the one still in use waits; one purchase says nothing yet', () => {
  const sales = [sent(at(2026, 10, 5), pizza.id, 50), sent(at(2026, 10, 25), pizza.id, 50)];
  assert.deepEqual(billParts([paid('gas', 5_000_00, at(2026, 10, 1)), ...sales], MENU, NOW), []);
  const [p] = billParts([paid('gas', 5_000_00, at(2026, 10, 1)), paid('gas', 6_000_00, at(2026, 10, 20)), ...sales], MENU, NOW);
  assert.equal(p.kind, 'gas');
  assert.equal(p.cents, 5_000_00); // the first cylinder, not the one in use
  assert.equal(p.minutes, 500); // the sales before the second, not after
});

test('a bill with no sales in its time is not spread, and a bill taken back is gone', () => {
  assert.deepEqual(billParts([paid('electricity', 50_000_00, at(2026, 11, 1), '2026-10')], MENU, NOW), []);
  const bill = paid('water', 2_000_00, at(2026, 11, 1), '2026-10');
  const events = [bill, sent(at(2026, 10, 10), pizza.id, 10)];
  assert.equal(billParts(events, MENU, NOW).length, 1);
  assert.deepEqual(billParts([...events, { id: 'x', shopId: 's', type: 'money.out_undone', at: NOW, orderNumber: 0, actor: owner, outId: bill.id } as { type: string }], MENU, NOW), []);
});

test('which typed line a bill replaces', () => {
  assert.equal(billOfLine({ kind: 'electricity', qty: 1 }), 'electricity');
  assert.equal(billOfLine({ kind: 'other', cents: 100, label: 'LPG' }), 'gas');
  assert.equal(billOfLine({ kind: 'other', cents: 100, label: 'Gas' }), 'gas');
  assert.equal(billOfLine({ kind: 'other', cents: 100, label: 'Box' }), null);
  assert.equal(billOfLine({ kind: 'labour', qty: 5 }), null);
});

const FOCUS = recipeQuestion('margherita', 'L');
const typed: [string, Answer][] = [
  [RATES_QUESTION, { kind: 'rates', rates: { electricity: 10000, labour: 0, equipment: 0 } } as Answer],
  [resourcesQuestion(FOCUS), { kind: 'resources', lines: [{ kind: 'electricity', qty: 1 }, { kind: 'other', cents: 3000, label: 'Gas' }, { kind: 'other', cents: 2000, label: 'Box' }] } as Answer],
];
const flow = (bills: ReturnType<typeof billParts>, focus = FOCUS) =>
  buildFlow({ focus, ctx: { items: SEED_INVENTORY, answers: new Map(typed) }, menu: MENU, bills });

test('in the flow a real bill replaces the typed estimate of the same thing, not added on top', () => {
  const none = flow([]);
  assert.ok(Math.abs(none.breakdown.electricity - 10000) < 1e-6);
  assert.equal(none.breakdown.bills, 0);
  assert.ok(!none.nodes.some((n) => n.id === BILLS_NODE));

  const bills = billParts([paid('electricity', 50_000_00, at(2026, 11, 1), '2026-10'), sent(at(2026, 10, 10), 'margherita', 1000)], MENU, NOW);
  const g = flow(bills);
  assert.equal(g.breakdown.electricity, 0); // the typed kWh is out
  assert.ok(Math.abs(g.breakdown.bills - 5000) < 1e-6); // Rs 50,000 over 10,000 min: Rs 50 for 10 min
  assert.ok(Math.abs(g.breakdown.overhead - 5000) < 1e-6); // no gas bill yet: typed gas and the box stay
  assert.ok(Math.abs(g.breakdown.total - (none.breakdown.total - 10000 + 5000)) < 1e-6);
  const into = g.edges.filter((e) => e.target === FOCUS).reduce((s, e) => s + e.cents, 0);
  assert.ok(Math.abs(into - g.breakdown.total) < 1e-6);
});

test('a batch has no cook minutes, so it keeps its estimates', () => {
  const bills = billParts([paid('electricity', 50_000_00, at(2026, 11, 1), '2026-10'), sent(at(2026, 10, 10), 'margherita', 10)], MENU, NOW);
  assert.equal(flow(bills, 'semi:Pizza Dough Batch').breakdown.bills, 0);
});
