import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COOK_MINUTES, KEEP_DONE_MS, cookTimeMs,
  TICKET_HORIZON_MS, ack, amendLine, bump, cookState, kitchenLine, restoreLine, elapsedLabel, fire, needsAttention, prune, queue, recall,
  ticketLines, ticketsFromEvents, unbump, urgency, start, unstart, cookLog,
} from './kitchen.ts';
import type { SyncEvent } from './sync.ts';
import { addLine, bareLine, emptyOrder, markSent, unsentLines } from './order.ts';

const lines = () =>
  addLine(emptyOrder(0), { itemId: 'devilled-chicken', qty: 2, size: 'L', adds: ['full-cheese'], outs: ['no-onion'], note: 'well done' }).lines;
const SHOP = 'shop-test';
const ticket = (id: string, number: number, firedAt: number) => ({ id, shopId: SHOP, number, lines: lines(), firedAt });

test('queue is open tickets, oldest first', () => {
  let t = fire([], ticket('c', 1003, 300));
  t = fire(t, ticket('a', 1001, 100));
  t = fire(t, ticket('b', 1002, 200));
  t = bump(t, 'b', 400);
  assert.deepEqual(queue(t).map((x) => x.number), [1001, 1003]);
});

test('re-firing an id replaces it, recall removes, unbump reopens', () => {
  let t = fire([], ticket('a', 1001, 100));
  t = fire(t, ticket('a', 1001, 150));
  assert.equal(t.length, 1);
  assert.equal(t[0].firedAt, 150);
  t = bump(t, 'a', 200);
  assert.equal(queue(t).length, 0);
  t = unbump(t, 'a');
  assert.equal(queue(t).length, 1);
  assert.equal(t[0].doneAt, undefined);
  assert.equal(recall(t, 'a').length, 0);
});

test('an add-on round is its own ticket: bumping one leaves the other', () => {
  let t = fire([], ticket('first', 1042, 100));
  t = fire(t, { ...ticket('more', 1042, 500), addOn: true });
  t = bump(t, 'first', 600);
  assert.deepEqual(queue(t).map((x) => [x.number, x.addOn]), [[1042, true]]);
});

test('bumping twice keeps the first done time', () => {
  const t = bump(bump(fire([], ticket('a', 1, 0)), 'a', 10), 'a', 20);
  assert.equal(t[0].doneAt, 10);
});

test("cook times are the owner's: pizza 10, burger 3, pasta 20 minutes", () => {
  assert.deepEqual(COOK_MINUTES, { pizza: 10, burger: 3, pasta: 20 });
});

test("a ticket is late after its slowest item's cook time, very late at one and a half times it", () => {
  const line = (itemId: string, cancelled = false) => ({ id: itemId, itemId, qty: 1, adds: [], outs: [], ...(cancelled ? { cancelled } : {}) });
  const min = 60_000;
  assert.equal(cookTimeMs({ lines: [line('chicken-burger')] }), 3 * min);
  assert.equal(cookTimeMs({ lines: [line('chicken-burger'), line('margherita')] }), 10 * min, 'the pizza sets the pace');
  assert.equal(cookTimeMs({ lines: [line('italian-pasta'), line('chicken-burger', false)] }), 20 * min);
  assert.equal(cookTimeMs({ lines: [line('italian-pasta', true), line('chicken-burger')] }), 3 * min, 'a cancelled pasta no longer counts');

  const burger = 3 * min;
  assert.equal(urgency(burger - 1, burger), 'ok');
  assert.equal(urgency(burger, burger), 'warn');
  assert.equal(urgency(4.5 * min - 1, burger), 'warn');
  assert.equal(urgency(4.5 * min, burger), 'bad');
  assert.equal(urgency(12 * min, 10 * min), 'warn', 'a pizza at 12 minutes is late, not yet very late');
  assert.equal(urgency(15 * min, 10 * min), 'bad');
});

test('elapsed reads mm:ss and keeps counting past an hour', () => {
  assert.equal(elapsedLabel(0), '00:00');
  assert.equal(elapsedLabel(247_900), '04:07');
  assert.equal(elapsedLabel(61 * 60_000 + 5_000), '61:05');
  assert.equal(elapsedLabel(-500), '00:00');
});

test('old done tickets are pruned; open ones never are', () => {
  let t = fire(fire([], ticket('a', 1, 0)), ticket('b', 2, 0));
  t = bump(t, 'a', 0);
  assert.deepEqual(prune(t, KEEP_DONE_MS).map((x) => x.number), [2]);
  assert.equal(prune(t, KEEP_DONE_MS - 1).length, 2);
});

test('ticket lines separate leave-outs from size and extras', () => {
  const [line] = ticketLines(fire([], ticket('a', 1, 0))[0]);
  assert.equal(line.qty, 2);
  assert.equal(line.name, 'Devilled Chicken');
  assert.equal(line.detail, 'Large · Full cheese');
  assert.deepEqual(line.outs, ['No onion']);
  assert.equal(line.note, 'well done');
});

test('a fired ticket is a copy: later edits to the order do not change it', () => {
  const src = ticket('a', 1, 0);
  const [fired] = fire([], src);
  src.lines[0].qty = 9;
  assert.equal(fired.lines[0].qty, 2);
});

test('sending: unsent lines, markSent, and a second round never merges into sent lines', () => {
  let o = addLine(emptyOrder(1042), bareLine('margherita', 'M'));
  assert.equal(unsentLines(o).length, 1);
  o = markSent(o, 100);
  assert.equal(o.sentAt, 100);
  assert.equal(unsentLines(o).length, 0);
  o = addLine(o, bareLine('margherita', 'M')); // same pizza again, after the first went out
  assert.equal(o.lines.length, 2);
  assert.deepEqual(unsentLines(o).map((l) => l.qty), [1]);
  assert.equal(markSent(o, 900).sentAt, 100); // first send time is kept
});

// ----- manager changes, cancels and alerts (the screen is the kitchen's only channel) -----

const M = (id: string, size: 'M' | 'L' = 'M') => ({ id, itemId: 'margherita', qty: 1, size, adds: [], outs: [], sent: true });

test('a new ticket alerts until the kitchen taps it; Done also counts as seen', () => {
  let t = fire([], { shopId: SHOP, id: 'a', number: 1, lines: [M('x')], firedAt: 100 });
  assert.equal(needsAttention(t[0]), true);
  t = ack(t, 'a', 150);
  assert.equal(needsAttention(t[0]), false);
  const d = bump(fire([], { shopId: SHOP, id: 'b', number: 2, lines: [M('y')], firedAt: 100 }), 'b', 200);
  assert.equal(needsAttention(d[0]), false);
});

test('a change keeps the old line, marks the ticket Changed, reopens it and alerts again', () => {
  let t = fire([], { shopId: SHOP, id: 'a', number: 1042, lines: [M('x'), M('y')], firedAt: 100 });
  t = bump(t, 'a', 200); // kitchen already finished it
  t = amendLine(t, 'x', M('x', 'L'), 300);
  const [k] = t;
  assert.equal(k.doneAt, undefined);
  assert.equal(k.changed, true);
  assert.equal(k.alertAt, 300);
  assert.equal(needsAttention(k), true);
  const [changed, untouched] = ticketLines(k);
  assert.equal(changed.status, 'changed');
  assert.equal(changed.was?.detail, 'Medium');
  assert.equal(changed.detail, 'Large');
  assert.equal(untouched.status, 'ok');
});

test('a cancel strikes the line but keeps it on the ticket', () => {
  const t = amendLine(fire([], { shopId: SHOP, id: 'a', number: 1, lines: [M('x')], firedAt: 0 }), 'x', null, 50);
  const [line] = ticketLines(t[0]);
  assert.equal(line.status, 'cancelled');
  assert.equal(line.name, 'Margherita');
  assert.equal(t[0].changed, true);
});

test('changing twice compares with the latest version; other tickets are untouched', () => {
  let t = fire([], { shopId: SHOP, id: 'a', number: 1, lines: [M('x')], firedAt: 0 });
  t = fire(t, { shopId: SHOP, id: 'b', number: 2, lines: [M('z')], firedAt: 0 });
  t = amendLine(t, 'x', M('x', 'L'), 10);
  t = amendLine(t, 'x', { ...M('x', 'L'), qty: 2 }, 20);
  const [line] = ticketLines(t[0]);
  assert.equal(line.was?.qty, 1);
  assert.equal(line.was?.detail, 'Large');
  assert.equal(line.qty, 2);
  assert.equal(t[1].changed, undefined);
});

test('cookState: waiting until Start, cooking once an open ticket is started, done when all are bumped', () => {
  let t = fire([], { shopId: SHOP, id: 'a', number: 1042, lines: [M('x')], firedAt: 0 });
  t = fire(t, { shopId: SHOP, id: 'b', number: 1042, lines: [M('y')], firedAt: 5, addOn: true });
  t = fire(t, { shopId: SHOP, id: 'c', number: 1043, lines: [M('z')], firedAt: 5 });
  assert.equal(cookState(t, 1042), 'waiting', 'sent, but the cook has not started');
  t = start(t, 'a', 8);
  assert.equal(cookState(t, 1042), 'cooking');
  t = bump(t, 'a', 10);
  assert.equal(cookState(t, 1042), 'waiting'); // the added round is not started yet
  t = start(t, 'b', 12);
  assert.equal(cookState(t, 1042), 'cooking');
  t = bump(t, 'b', 20);
  assert.equal(cookState(t, 1042), 'done');
  assert.equal(cookState(t, 1043), 'waiting');
  assert.equal(cookState(amendLine(t, 'x', null, 30), 1042), 'cooking'); // a manager change reopens it
  assert.equal(cookState(prune(t, 10 ** 12), 1042), 'done'); // pruned hours later: still done
});

test('restoreLine puts a cancelled line back exactly and alerts the kitchen again', () => {
  let t = fire([], { shopId: SHOP, id: 'a', number: 1, lines: [M('x'), M('y')], firedAt: 0 });
  t = ack(t, 'a', 5);
  const before = kitchenLine(t, 'y')!;
  t = amendLine(t, 'y', null, 10);
  assert.equal(ticketLines(t[0])[1].status, 'cancelled');
  t = restoreLine(bump(ack(t, 'a', 11), 'a', 12), before, 20);
  assert.equal(ticketLines(t[0])[1].status, 'ok');
  assert.deepEqual(t[0].lines[1], before);
  assert.equal(t[0].doneAt, undefined);
  assert.equal(needsAttention(t[0]), true);
});

test('tickets are folded from events: send, change, undo, seen, done, recall', () => {
  const actor = { id: 's1', name: 'Nimal', role: 'manager' as const };
  const base = { shopId: SHOP, actor, orderNumber: 1001 };
  const [line] = lines();
  const sent = { ...line, sent: true };
  const bigger = { ...sent, qty: 3 };
  const audit = { totalBefore: 0, totalAfter: 0 };
  const ev: SyncEvent[] = [
    { ...base, id: 'e1', at: 100, type: 'order.sent', ticketId: 't1', lines: [sent], addOn: false },
    { ...base, id: 'e2', at: 200, type: 'kitchen.seen', ticketId: 't1' },
    { ...base, ...audit, id: 'e3', at: 300, type: 'order.item_changed', lineId: sent.id, before: sent, after: bigger, reason: 'Customer asked' },
    { ...base, id: 'e4', at: 350, type: 'order.paid', total: 0, tender: 'cash', tendered: 0 },
  ];

  let t = ticketsFromEvents(ev, 400);
  assert.equal(t.length, 1);
  assert.equal(t[0].changed, true);
  assert.equal(t[0].lines[0].qty, 3);
  assert.equal(t[0].lines[0].was?.qty, 2);
  assert.equal(needsAttention(t[0]), true, 'a change alerts again after it was seen');

  const undone: SyncEvent = { ...base, ...audit, id: 'e5', at: 500, type: 'order.change_undone', undoneEventId: 'e3', undoneType: 'order.item_changed' };
  t = ticketsFromEvents([...ev, undone], 600);
  assert.equal(t[0].lines[0].qty, 2);
  assert.equal(t[0].lines[0].was, undefined, 'Undo puts the line back exactly as the kitchen had it');

  const done: SyncEvent = { ...base, id: 'e6', at: 700, type: 'kitchen.bumped', ticketId: 't1' };
  assert.equal(queue(ticketsFromEvents([...ev, undone, done], 800)).length, 0);
  const reopened: SyncEvent = { ...base, id: 'e7', at: 900, type: 'kitchen.unbumped', ticketId: 't1' };
  assert.equal(queue(ticketsFromEvents([...ev, undone, done, reopened], 1000)).length, 1);

  const recalled: SyncEvent = { ...base, id: 'e8', at: 150, type: 'order.send_undone', ticketId: 't1' };
  assert.deepEqual(ticketsFromEvents([ev[0], recalled], 200), []);
});

test('events older than a day are skipped', () => {
  const actor = { id: 's1', name: 'Nimal', role: 'cashier' as const };
  const old: SyncEvent = { id: 'e1', shopId: SHOP, actor, orderNumber: 1001, at: 0, type: 'order.sent', ticketId: 't1', lines: lines(), addOn: false };
  assert.equal(ticketsFromEvents([old], 1000).length, 1);
  assert.equal(ticketsFromEvents([old], TICKET_HORIZON_MS + 1).length, 0);
});

test('an online order keeps its pickup time on the kitchen ticket', () => {
  const actor = { id: 's', name: 'Nimal', role: 'cashier' as const };
  const line = { id: 'l1', itemId: 'margherita', qty: 1, size: 'M' as const, adds: [], outs: [], sent: true };
  const events = [
    { id: 'e1', shopId: 'shop', type: 'order.sent', at: 1000, actor, orderNumber: 1001, ticketId: 't1', lines: [line], addOn: false, online: { pickupBy: 9000 } },
    { id: 'e2', shopId: 'shop', type: 'order.sent', at: 1000, actor, orderNumber: 1002, ticketId: 't2', lines: [line], addOn: false },
  ] as SyncEvent[];
  const [a, b] = ticketsFromEvents(events, 2000);
  assert.deepEqual(a.online, { pickupBy: 9000 });
  assert.equal(b.online, undefined);
});

test('Start marks a ticket cooking (and seen); Undo takes it back', () => {
  let t = fire([], ticket('a', 1001, 100));
  t = start(t, 'a', 200);
  assert.equal(t[0].startedAt, 200);
  assert.equal(needsAttention(t[0]), false);
  t = start(t, 'a', 300);
  assert.equal(t[0].startedAt, 200, 'a second Start keeps the first time');
  t = unstart(t, 'a');
  assert.equal(t[0].startedAt, undefined);
  assert.equal(queue(t).length, 1, 'starting does not take it off the screen');
});

test('cookLog times each finished ticket from the events, Undo applied', () => {
  const actor = { id: 's1', name: 'Nimal', role: 'cashier' as const };
  const base = { shopId: SHOP, orderNumber: 1001 };
  const k = (id: string, at: number, type: 'kitchen.started' | 'kitchen.unstarted' | 'kitchen.bumped' | 'kitchen.unbumped', ticketId = 't1'): SyncEvent =>
    ({ ...base, id, at, type, ticketId });
  const sent = (id: string, ticketId: string, at: number): SyncEvent =>
    ({ ...base, id, actor, at, type: 'order.sent', ticketId, lines: lines(), addOn: false });
  const events: SyncEvent[] = [
    sent('e1', 't1', 0),
    k('e2', 60_000, 'kitchen.started'),
    k('e3', 61_000, 'kitchen.unstarted'), // tapped by mistake
    k('e4', 120_000, 'kitchen.started'),
    k('e5', 600_000, 'kitchen.bumped'),
    sent('e6', 't2', 0),
    k('e7', 300_000, 'kitchen.bumped', 't2'), // Done without Start
    sent('e8', 't3', 0),
    k('e9', 10_000, 'kitchen.started', 't3'), // still cooking
  ];
  const log = cookLog(events);
  assert.deepEqual(log.map((r) => r.ticketId), ['t2', 't1'], 'finished tickets only, in the order they were done');
  const [t2, t1] = log;
  assert.deepEqual(
    { sentAt: t1.sentAt, startedAt: t1.startedAt, doneAt: t1.doneAt, waitMs: t1.waitMs, cookMs: t1.cookMs, totalMs: t1.totalMs },
    { sentAt: 0, startedAt: 120_000, doneAt: 600_000, waitMs: 120_000, cookMs: 480_000, totalMs: 600_000 },
  );
  assert.deepEqual(t1.items, [{ itemId: 'devilled-chicken', category: 'pizza', size: 'L', qty: 2 }]);
  assert.equal(t2.cookMs, null);
  assert.equal(t2.totalMs, 300_000);

  const reopened = cookLog([...events, k('e10', 700_000, 'kitchen.unbumped')]);
  assert.deepEqual(reopened.map((r) => r.ticketId), ['t2'], 'a Done taken back is not cooked yet');
});

test('a Remake marks the line on its ticket, which stays open to make again; its Undo clears the mark (SCRUM-177)', () => {
  const actor = { id: 'c1', name: 'Kasun', role: 'cashier' as const };
  const sent: SyncEvent = { id: 's1', shopId: SHOP, at: 1000, orderNumber: 1001, actor, type: 'order.sent', ticketId: 't1', addOn: false,
    lines: [{ id: 'L1', itemId: 'margherita', size: 'L', qty: 1, adds: [], outs: [], sent: true }] };
  const remade: SyncEvent = { id: 'w1', shopId: SHOP, at: 2000, orderNumber: 0, actor, type: 'stock.wasted',
    what: { kind: 'dish', itemId: 'margherita', size: 'L' }, name: 'Margherita · Large', qty: 1, reason: 'burnt', ticketId: 't1', lineId: 'L1' };
  const [t] = ticketsFromEvents([sent, remade], 3000);
  assert.equal(t.doneAt, undefined);
  assert.equal(ticketLines(t)[0].remade, 1);
  const undo: SyncEvent = { id: 'u1', shopId: SHOP, at: 2500, orderNumber: 0, actor, type: 'stock.waste_undone', wasteId: 'w1', ticketId: 't1' };
  assert.equal(ticketLines(ticketsFromEvents([sent, remade, undo], 3000)[0])[0].remade, undefined);
  // The bin's waste (no ticket) does not touch the kitchen.
  const bin: SyncEvent = { ...remade, id: 'w2', ticketId: undefined, lineId: undefined };
  assert.equal(ticketLines(ticketsFromEvents([sent, bin], 3000)[0])[0].remade, undefined);
});
