import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BAD_AFTER_MS, KEEP_DONE_MS, WARN_AFTER_MS,
  TICKET_HORIZON_MS, ack, amendLine, bump, cookState, kitchenLine, restoreLine, elapsedLabel, fire, needsAttention, prune, queue, recall,
  ticketLines, ticketsFromEvents, unbump, urgency,
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

test('urgency follows wait time', () => {
  assert.equal(urgency(0), 'ok');
  assert.equal(urgency(WARN_AFTER_MS - 1), 'ok');
  assert.equal(urgency(WARN_AFTER_MS), 'warn');
  assert.equal(urgency(BAD_AFTER_MS), 'bad');
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

test('cookState: cooking while any ticket of the order is open, done when all are bumped', () => {
  let t = fire([], { shopId: SHOP, id: 'a', number: 1042, lines: [M('x')], firedAt: 0 });
  t = fire(t, { shopId: SHOP, id: 'b', number: 1042, lines: [M('y')], firedAt: 5, addOn: true });
  t = fire(t, { shopId: SHOP, id: 'c', number: 1043, lines: [M('z')], firedAt: 5 });
  assert.equal(cookState(t, 1042), 'cooking');
  t = bump(t, 'a', 10);
  assert.equal(cookState(t, 1042), 'cooking'); // the added round is still cooking
  t = bump(t, 'b', 20);
  assert.equal(cookState(t, 1042), 'done');
  assert.equal(cookState(t, 1043), 'cooking');
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
