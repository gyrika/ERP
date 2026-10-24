import test from 'node:test';
import assert from 'node:assert/strict';
import type { Actor } from '../src/domain/auth.ts';
import { purchasesFromEvents } from '../src/domain/purchaseOrders.ts';
import { SEED_INVENTORY } from '../src/domain/inventoryData.ts';
import { STOCK_DEFAULTS } from '../src/domain/stockSettings.ts';
import type { GrnLine, SyncEvent } from '../src/domain/sync.ts';
import { createStockRules, stockFacts, stockRuleProblem } from './stockRules.ts';
import { memoryStore, type StaffMember } from './store.ts';

const HOUR = 3_600_000;
const by = (e: SyncEvent, actor: Actor): SyncEvent => ({ ...e, actor }) as SyncEvent;
const ravi: Actor = { id: 'staff-ravi', name: 'Ravi', role: 'manager' };
const nimal: Actor = { id: 'staff-nimal', name: 'Nimal', role: 'cashier' };
const staff: StaffMember[] = [{ ...ravi, active: true }, { ...nimal, active: true }, { id: 'staff-gone', name: 'Old', role: 'manager', active: false }];
const base = { shopId: 'shop-a', orderNumber: 0 as const, actor: ravi };

const po = (id: string, packs = 2, at = 0): SyncEvent => ({ ...base, id, at, type: 'stock.ordered', supplierId: 'sup', lines: [{ itemId: 'flour', packs }] });
const line = (ordered: number, received: number, accepted = received): GrnLine => ({ itemId: 'flour', ordered, received, accepted, returned: Math.round((received - accepted) * 1000) / 1000 });
const grn = (id: string, orderId: string, lines: GrnLine[], extra: object = {}, at = 1): SyncEvent =>
  ({ ...base, id, at, type: 'stock.grn', orderId, supplierId: 'sup', lines, approvedBy: null, ...extra } as SyncEvent);

/** What the server would say about `e` once `history` is stored, at time `now`. */
const ask = (history: SyncEvent[], e: SyncEvent, now = 2 * HOUR) =>
  stockRuleProblem(e, { state: purchasesFromEvents(history), settings: STOCK_DEFAULTS, staff, now, items: stockFacts(history) });

test('an edit or cancel needs an order that is there and has had no goods', () => {
  const edit = (orderId: string): SyncEvent => ({ ...base, id: 'e', at: 1, type: 'stock.order_edited', orderId, lines: [{ itemId: 'flour', packs: 3 }] });
  const cancel = (orderId: string): SyncEvent => ({ ...base, id: 'c', at: 1, type: 'stock.order_cancelled', orderId, reason: 'Ordered by mistake' });
  assert.equal(ask([po('p1')], edit('p1')), null);
  assert.equal(ask([po('p1')], cancel('p1')), null);
  assert.match(ask([po('p1')], edit('nope')) ?? '', /not here/);
  assert.match(ask([po('p1')], cancel('nope')) ?? '', /not here/);
  const received = [po('p1'), grn('g1', 'p1', [line(2, 1)], { approvedBy: ravi, shortDecision: 'wait' })];
  assert.match(ask(received, edit('p1')) ?? '', /already being received/);
  assert.match(ask(received, cancel('p1')) ?? '', /already being received/);
  assert.match(ask([po('p1'), cancel('p1')], cancel('p1')) ?? '', /already cancelled/);
  assert.match(ask([po('p1'), cancel('p1')], edit('p1')) ?? '', /cancelled/);
  assert.equal(ask([po('p1'), cancel('p1')], { ...base, id: 'r', at: 2, type: 'stock.order_reopened', orderId: 'p1' }), null);
  assert.match(ask([po('p1')], { ...base, id: 'r', at: 2, type: 'stock.order_reopened', orderId: 'p1' }) ?? '', /not cancelled/);
});

test('a GRN: as owed passes; a difference needs a real manager and the decisions; stock cannot be made up', () => {
  const orders = [po('p1', 2)];
  assert.equal(ask(orders, grn('g1', 'p1', [line(2, 2)])), null);
  assert.match(ask(orders, grn('g1', 'p1', [line(2, 1)])) ?? '', /needs a manager/);
  assert.match(ask(orders, grn('g1', 'p1', [line(2, 1)], { approvedBy: ravi })) ?? '', /wait for the rest, or close the order/);
  assert.equal(ask(orders, grn('g1', 'p1', [line(2, 1)], { approvedBy: ravi, shortDecision: 'close' })), null);
  assert.equal(ask(orders, grn('g1', 'p1', [line(2, 3, 2)], { approvedBy: ravi, overDecision: 'return' })), null);
  assert.match(ask(orders, grn('g1', 'p1', [line(2, 3, 3)], { approvedBy: ravi, overDecision: 'return' })) ?? '', /do not match what was received/, 'returning extra but taking it all in');
  assert.match(ask(orders, grn('g1', 'p1', [{ itemId: 'flour', ordered: 2, received: 2 }])) ?? '', /do not match/, 'a GRN with no accepted puts nothing in: refused');
  // The approver must be a real, active manager or owner of this shop: names on the device are not enough.
  const short = (by: Actor) => grn('g1', 'p1', [line(2, 1)], { approvedBy: by, shortDecision: 'wait' });
  assert.match(ask(orders, short(nimal)) ?? '', /needs a manager to approve|not from a manager or the owner/, 'a cashier');
  assert.match(ask(orders, short({ id: 'staff-gone', name: 'Old', role: 'manager' })) ?? '', /not from a manager or the owner/, 'someone who left');
  assert.match(ask(orders, short({ id: 'made-up', name: 'Boss', role: 'owner' })) ?? '', /not from a manager or the owner/);
  assert.match(ask(orders, short({ ...nimal, role: 'manager' })) ?? '', /not from a manager or the owner/, 'a cashier claiming to be a manager');
});

test('the server requires a real manager for a delivered price that differs from the PO', () => {
  const order: SyncEvent = {
    ...base, id: 'p1', at: 0, type: 'stock.ordered', supplierId: 'sup',
    lines: [{ itemId: 'flour', packs: 2, unitPriceCents: 640000 }],
  };
  const deliveredLines = [{ ...line(2, 2), unitPriceCents: 650000 }];
  const delivered = grn('g1', 'p1', deliveredLines);
  assert.match(ask([order], delivered) ?? '', /needs a manager/);
  assert.match(ask([order], grn('g1', 'p1', [line(2, 2)])) ?? '', /Enter the delivered price/);
  assert.equal(ask([order], grn('g1', 'p1', deliveredLines, { approvedBy: ravi })), null);
  assert.match(ask([order], grn('g1', 'p1', deliveredLines, { approvedBy: nimal })) ?? '', /needs a manager|not from a manager or the owner/);
  assert.match(ask([order], grn('g1', 'p1', [{ ...line(2, 2), unitPriceCents: 640000.5 }])) ?? '', /whole number of cents/);
  assert.match(ask([], { ...order, lines: [{ itemId: 'flour', packs: 2, unitPriceCents: -1 }] }) ?? '', /purchase-order price must be a whole number of cents/);
});

test('a PO lists each item once; a GRN lists each item once and everything still owed', () => {
  const twice: SyncEvent = { ...base, id: 'p2', at: 0, type: 'stock.ordered', supplierId: 'sup', lines: [{ itemId: 'flour', packs: 1 }, { itemId: 'flour', packs: 1 }] };
  assert.match(ask([], twice) ?? '', /lists an item twice/);
  assert.match(ask([po('p1')], { ...base, id: 'e', at: 1, type: 'stock.order_edited', orderId: 'p1', lines: [{ itemId: 'flour', packs: 1 }, { itemId: 'flour', packs: 2 }] }) ?? '', /lists an item twice/);
  assert.match(ask([po('p1', 2)], grn('g1', 'p1', [line(1, 1), line(1, 1)])) ?? '', /lists an item twice/);
  const two: SyncEvent = { ...base, id: 'p3', at: 0, type: 'stock.ordered', supplierId: 'sup', lines: [{ itemId: 'flour', packs: 2 }, { itemId: 'salt', packs: 1 }] };
  assert.match(ask([two], grn('g1', 'p3', [line(2, 2)])) ?? '', /leaves out something still owed/, 'no short decision: it would close the order with salt owed');
});

test('a GRN needs an order that is waiting for goods, from that supplier, for exactly what is still owed', () => {
  assert.match(ask([po('p1')], grn('g1', 'nope', [line(2, 2)])) ?? '', /not here/);
  assert.match(ask([po('p1')], grn('g1', 'p1', [line(2, 2)], { supplierId: 'other' })) ?? '', /different supplier/);
  const closed = [po('p1'), grn('g1', 'p1', [line(2, 2)])];
  assert.match(ask(closed, grn('g2', 'p1', [line(2, 2)])) ?? '', /is closed/);
  assert.match(ask([po('p1'), { ...base, id: 'c', at: 1, type: 'stock.order_cancelled', orderId: 'p1', reason: 'x' } as SyncEvent], grn('g2', 'p1', [line(2, 2)])) ?? '', /cancelled/);
  // Another device already received 1 pack and waits for the rest: this device, still working from the old amount, is told to open it again.
  const partly = [po('p1'), grn('g1', 'p1', [line(2, 1)], { approvedBy: ravi, shortDecision: 'wait' })];
  assert.match(ask(partly, grn('g2', 'p1', [line(2, 2)])) ?? '', /changed since this GRN was opened/);
  assert.equal(ask(partly, grn('g2', 'p1', [line(1, 1)])), null, 'for the 1 left');
});

test('an undo: latest GRN only, inside the hours, with a reason and a real manager', () => {
  const two = [po('p1', 4), grn('g1', 'p1', [line(4, 1)], { approvedBy: ravi, shortDecision: 'wait' }, 1 * HOUR), grn('g2', 'p1', [line(3, 1)], { approvedBy: ravi, shortDecision: 'wait' }, 2 * HOUR)];
  const undo = (grnId: string, extra: object = {}): SyncEvent => ({ ...base, id: 'u', at: 3 * HOUR, type: 'stock.grn_undone', grnId, reason: 'Wrong amounts', approvedBy: ravi, ...extra } as SyncEvent);
  assert.equal(ask(two, undo('g2'), 3 * HOUR), null);
  assert.match(ask(two, undo('g1'), 3 * HOUR) ?? '', /Only the latest GRN of PO \(pending\) can be undone/);
  assert.match(ask(two, undo('g2'), 2 * HOUR + 25 * HOUR) ?? '', /older than 24 hours/, 'the server\'s clock decides, not the device\'s');
  assert.match(ask(two, undo('nope'), 3 * HOUR) ?? '', /not here/);
  assert.match(ask(two, undo('g2', { reason: '  ' }), 3 * HOUR) ?? '', /Say why/);
  assert.match(ask(two, undo('g2', { approvedBy: nimal }), 3 * HOUR) ?? '', /not from a manager or the owner/, 'a cashier cannot undo a GRN');
  assert.match(ask([...two, undo('g2')], undo('g2'), 3 * HOUR) ?? '', /already undone/);
});

const count = (counted: number, expected: number, valueCents: number, reason: 'spoiled' | null, itemId = 'flour', id = 'c'): SyncEvent =>
  ({ ...base, id, at: 1, type: 'stock.counted', itemId, counted, expected, entries: [], reason, valueCents, tier: 'daily' });
/** flour has been counted once already: later counts are checked. */
const before = [count(6000, 0, 0, null, 'flour', 'c0')];

test('a count far from what was expected must say why, by the owner\'s numbers; a small one need not', () => {
  assert.match(ask(before, count(4000, 6000, -50000, null)) ?? '', /Count again and say why/, 'a third short, no reason');
  assert.equal(ask(before, count(4000, 6000, -50000, 'spoiled')), null);
  assert.equal(ask(before, count(5900, 6000, -5000, null)), null, 'under both allowances');
  assert.match(ask(before, count(99000, 100000, -260000, null)) ?? '', /Count again/, 'only 1% but over Rs 2,000');
  // The owner raised the allowance: the same count now needs no reason.
  assert.equal(stockRuleProblem(count(4000, 6000, -50000, null), { state: purchasesFromEvents([]), settings: { ...STOCK_DEFAULTS, countGapShare: 0.5 }, staff, now: 1, items: stockFacts(before) }), null);
});

test('a count: the first one is opening stock; below zero is still checked; the value is the server\'s', () => {
  assert.equal(ask([], count(4000, 6000, -50000, null)), null, 'never counted before: its opening stock needs no reason');
  assert.match(ask(before, count(3000, -2000, 0, null)) ?? '', /Count again/, 'sold below zero: what is there is a gap from zero, and needs a reason');
  // Mozzarella (inv-0006 on the price list) is dear: the device says the gap is worth Rs 0, the server works it out.
  const mozz = SEED_INVENTORY.find((i) => i.id === 'inv-0006')!;
  const counted = [count(10 * mozz.packQty, 0, 0, null, mozz.id, 'm0')];
  const short = count(Math.round(9.5 * mozz.packQty), 10 * mozz.packQty, 0, null, mozz.id);
  assert.ok(mozz.workingPriceCents / 2 > STOCK_DEFAULTS.countGapCents, 'half a pack is over the Rs allowance');
  assert.match(ask(counted, short) ?? '', /Count again/, 'a 5% gap, but worth more than the allowance');
});

test('a count after a delivery but before any count is still the opening stock', () => {
  const delivered = [po('p1', 5), grn('g1', 'p1', [line(5, 5)])];
  assert.equal(ask(delivered, count(9000, 5000, 0, null)), null, 'the delivery is not a count: no reason asked');
  assert.match(ask([...delivered, count(9000, 5000, 0, null, 'flour', 'c0')], count(4000, 9000, 0, null)) ?? '', /Count again/, 'once counted, a gap needs a reason');
});

test('stock is not changed by a bare movement: it is counted or received', () => {
  const adjusted: SyncEvent = { ...base, id: 'a1', at: 1, type: 'stock.adjusted', itemId: 'flour', deltaPacks: 5 };
  const moved: SyncEvent = { ...base, id: 'm1', at: 1, type: 'stock.movement', itemId: 'flour', kind: 'COUNT_ADJUST', qtyBase: 5000, docId: 'manual' };
  assert.match(ask([], adjusted) ?? '', /Count the item instead/);
  assert.match(ask([], moved) ?? '', /Count the item instead/);
});

// ----- one batch at a time, each record seeing the ones before it -----

async function shop() {
  const store = memoryStore();
  const manager = await store.addStaff('shop-a', 'Ravi', 'manager', '2580');
  const device = (await store.addDevice('shop-a', 'A', 'counter')).device;
  const by: Actor = { id: manager.id, name: 'Ravi', role: 'manager' };
  const check = createStockRules(store, () => 5 * HOUR);
  const push = (events: SyncEvent[]) => check(device, events, (ok) => store.push(device, ok, 1));
  const stored = async () => (await store.pull('shop-a', 0, 100)).map((r) => r.event.id);
  return { store, by, push, stored };
}

test('a batch is checked in order: an order and its GRN can arrive together', async () => {
  const s = await shop();
  const out = await s.push([by(po('p1', 2), s.by), by(grn('g1', 'p1', [line(2, 2)]), s.by)]);
  assert.deepEqual(out.rejected, []);
  assert.deepEqual(await s.stored(), ['p1', 'g1']);
});

test('two devices receiving the same order: the first is stored, the second is told it changed', async () => {
  const s = await shop();
  await s.push([by(po('p1', 2), s.by)]);
  const mine = (id: string) => (by(grn(id, 'p1', [line(2, 2)]), s.by));
  const [a, b] = await Promise.all([s.push([mine('g-a')]), s.push([mine('g-b')])]);
  assert.deepEqual([a.rejected.length, b.rejected.length].sort(), [0, 1]);
  const refused = [...a.rejected, ...b.rejected][0];
  assert.match(refused.reason, /is closed/);
  assert.equal((await s.stored()).filter((id) => id.startsWith('g-')).length, 1);
});

test('a record sent again is not a conflict with itself, and a refused one is never stored', async () => {
  const s = await shop();
  const events = [by(po('p1', 2), s.by), by(grn('g1', 'p1', [line(2, 2)]), s.by)];
  await s.push(events);
  const again = await s.push(events);
  assert.deepEqual(again.rejected, []);
  const bad = await s.push([by(grn('g2', 'p1', [line(2, 2)]), s.by)]);
  assert.equal(bad.rejected.length, 1);
  assert.deepEqual(await s.stored(), ['p1', 'g1']);
});

test('a failed store does not leave the checker believing something that was not saved', async () => {
  const s = await shop();
  await s.push([by(po('p1', 2), s.by)]);
  await assert.rejects(() => (async () => { const check = createStockRules({ ...s.store, push: async () => { throw new Error('disk'); } }, () => 5 * HOUR); await check({ id: 'd', tenantId: 'shop-a', kind: 'counter' }, [by(grn('g1', 'p1', [line(2, 2)]), s.by)], (ok) => s.store.push({ id: 'd', tenantId: 'shop-a', kind: 'counter' }, ok, 1).then(() => { throw new Error('disk'); })); })(), /disk/);
});

test('records that are not purchasing rules are passed through untouched', async () => {
  const s = await shop();
  const adjust: SyncEvent = { ...base, actor: s.by, id: 'a1', at: 1, type: 'stock.unit_set', itemId: 'flour', name: 'Tray', base: 30 };
  const out = await s.push([adjust]);
  assert.deepEqual(out.rejected, []);
  assert.deepEqual(await s.stored(), ['a1']);
});
