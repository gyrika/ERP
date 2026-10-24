import type { Actor } from '../src/domain/auth.ts';
import { gapOf } from '../src/domain/counting.ts';
import { SEED_INVENTORY } from '../src/domain/inventoryData.ts';
import { grnProblem, purchasesFromEvents, settleGrn, undoCheck, type PurchaseState } from '../src/domain/purchaseOrders.ts';
import { stockSettingsFromEvents, type StockSettings } from '../src/domain/stockSettings.ts';
import { PULL_LIMIT, type SyncEvent } from '../src/domain/sync.ts';
import type { Device, EventStore, StaffMember } from './store.ts';

/**
 * The server re-checks the purchasing rules against what the shop has already stored, so a
 * device is never trusted alone (two devices may have worked offline, or one may be out of
 * date or lying). Each refusal says what to do next and is shown to the person on the device.
 * Checked one batch at a time per shop, so two pushes never both pass the same rule.
 */
const RELEVANT = new Set<string>([
  'stock.ordered', 'stock.order_edited', 'stock.order_cancelled', 'stock.order_reopened',
  'stock.grn', 'stock.grn_undone', 'stock.counted', 'stock.settings_set',
  // What a count is checked against: has the item been counted before, and what is it worth.
  'stock.adjusted', 'stock.movement', 'stock.item_added', 'stock.price_set',
]);

/** What the server knows of an item for a count: its pack and price, and whether stock was ever recorded for it. */
export interface StockFacts { packQty: number | null; workingPriceCents: number | null; counted: boolean }

/** Each item's facts from the stored records (the price list, then the shop's changes), as the stock fold has them. */
export const stockFacts = (log: readonly SyncEvent[]): Map<string, StockFacts> => {
  const facts = new Map<string, StockFacts>(SEED_INVENTORY.map((i) => [i.id, { packQty: i.packQty, workingPriceCents: i.workingPriceCents, counted: false }]));
  const of = (id: string) => facts.get(id) ?? facts.set(id, { packQty: null, workingPriceCents: null, counted: false }).get(id)!;
  for (const e of log) {
    if (e.type === 'stock.item_added' && !facts.has(e.item.id)) facts.set(e.item.id, { packQty: e.item.packQty, workingPriceCents: e.item.workingPriceCents, counted: false });
    else if (e.type === 'stock.price_set') of(e.itemId).workingPriceCents = e.after;
    // A delivery is not a count: an item first counted after one still gives its opening stock.
    else if (e.type === 'stock.counted' || e.type === 'stock.adjusted' || (e.type === 'stock.movement' && e.kind === 'COUNT_ADJUST')) of(e.itemId).counted = true;
  }
  return facts;
};

interface Context { state: PurchaseState; settings: StockSettings; staff: readonly StaffMember[]; now: number; items: ReadonlyMap<string, StockFacts> }

const orderPriceProblem = (lines: readonly { itemId: string; unitPriceCents?: number }[]): string | null => {
  if (new Set(lines.map((l) => l.itemId)).size !== lines.length) return 'A purchase order lists an item twice. Place it again.';
  return lines.some((l) => l.unitPriceCents !== undefined && (!Number.isSafeInteger(l.unitPriceCents) || l.unitPriceCents < 0))
    ? 'A purchase-order price must be a whole number of cents, zero or more.'
    : null;
};

/** The approver on a record must be a real, active manager or owner of this shop. */
const approverProblem = (by: Actor | null | undefined, staff: readonly StaffMember[]): string | null => {
  if (!by) return 'A manager or the owner must approve this.';
  const person = staff.find((m) => m.id === by.id && m.active);
  if (!person || person.role !== by.role || (person.role !== 'manager' && person.role !== 'owner')) {
    return 'That approval is not from a manager or the owner of this shop. Ask a manager to approve it again.';
  }
  return null;
};

/** Why this record is not allowed now, or null. */
export const stockRuleProblem = (e: SyncEvent, { state, settings, staff, now, items }: Context): string | null => {
  switch (e.type) {
    case 'stock.ordered':
      return orderPriceProblem(e.lines);
    case 'stock.order_edited': {
      const o = state.orders.find((x) => x.id === e.orderId);
      if (!o) return 'That purchase order is not here. Refresh and try again.';
      if (!o.editable) return `${o.poNo} is ${o.status === 'cancelled' ? 'cancelled' : 'already being received'}: it can no longer be changed.`;
      return orderPriceProblem(e.lines);
    }
    case 'stock.order_cancelled': {
      const o = state.orders.find((x) => x.id === e.orderId);
      if (!o) return 'That purchase order is not here. Refresh and try again.';
      return o.editable ? null : `${o.poNo} is ${o.status === 'cancelled' ? 'already cancelled' : 'already being received'}: it can no longer be cancelled.`;
    }
    case 'stock.order_reopened': {
      const o = state.orders.find((x) => x.id === e.orderId);
      if (!o) return 'That purchase order is not here. Refresh and try again.';
      return o.status === 'cancelled' ? null : `${o.poNo} is not cancelled.`;
    }
    case 'stock.grn': {
      const o = state.orders.find((x) => x.id === e.orderId);
      if (!o) return 'That purchase order is not here. Refresh and try again.';
      if (o.supplierId !== e.supplierId) return `That GRN names a different supplier than ${o.poNo}. Open the GRN again.`;
      const decisions = { short: e.shortDecision ?? null, over: e.overDecision ?? null };
      const why = grnProblem(o, e.lines, decisions, e.approvedBy);
      if (why) return why;
      if (e.approvedBy) { const bad = approverProblem(e.approvedBy, staff); if (bad) return bad; }
      // The stock a GRN puts in is worked out here, never taken on the device's word.
      const settled = settleGrn(e.lines, decisions.over);
      const same = e.lines.every((l, i) => l.accepted !== undefined && Math.abs(l.accepted - settled[i].accepted!) < 1e-6 && Math.abs((l.returned ?? 0) - settled[i].returned!) < 1e-6);
      return same ? null : 'The amounts that go into stock do not match what was received. Open the GRN again.';
    }
    case 'stock.grn_undone': {
      const why = undoCheck(state, e.grnId, now, settings.grnUndoHours);
      if (why) return why;
      if (!e.reason?.trim()) return 'Say why the GRN is being undone.';
      return approverProblem(e.approvedBy, staff);
    }
    case 'stock.price_set':
      // A price a delivery set stands only with that delivery: a refused GRN takes its prices with it.
      // A price typed by hand (no grnId) is not ours to check; an undone GRN's prices may still go back.
      return e.grnId === undefined || state.grns.some((g) => g.id === e.grnId)
        ? null
        : 'That price came with a delivery that was not saved. Receive the delivery again.';
    case 'stock.counted': {
      // A gap beyond the owner's allowance must say why: the device is not trusted to have asked. As on the
      // count screen, an item's first count (its opening stock) needs no reason; a shelf below zero still does.
      // Its value is worked out here from the stored price, never taken on the device's word.
      const item = items.get(e.itemId);
      if (e.reason !== null || !item?.counted) return null;
      const priced = item.packQty !== null && item.packQty > 0 && item.workingPriceCents !== null;
      const gap = gapOf(e.expected, e.counted, priced ? { packQty: item.packQty!, workingPriceCents: item.workingPriceCents! } : { packQty: 1, workingPriceCents: 0 }, settings);
      const big = gap.big || (!priced && Math.abs(e.valueCents) > settings.countGapCents);
      return big ? 'This count is a long way from what was expected. Count again and say why: spoiled, spilled, wrong entry, or other.' : null;
    }
    case 'stock.adjusted':
    case 'stock.movement':
      // Stock moves only by a count, a GRN, a sale or waste, each with its own checks.
      return 'Stock is changed by counting it, or by receiving a delivery. Count the item instead.';
    default:
      return null;
  }
};

export function createStockRules(store: EventStore, now: () => number) {
  /** Each shop's purchasing records, read once and then kept up to date here. */
  const logs = new Map<string, Promise<SyncEvent[]>>();
  const queues = new Map<string, Promise<unknown>>();

  const load = async (tenantId: string): Promise<SyncEvent[]> => {
    const out: SyncEvent[] = [];
    for (let after = 0;;) {
      const rows = await store.pull(tenantId, after, PULL_LIMIT);
      out.push(...rows.map((r) => r.event).filter((e) => RELEVANT.has(e.type)));
      if (rows.length < PULL_LIMIT) break;
      after = rows[rows.length - 1].seq;
    }
    return out;
  };

  /**
   * Checks the batch in order (each record sees the ones allowed before it), then calls
   * `push` with the allowed ones while no other batch for this shop can slip in between.
   */
  return async <T>(device: Device, events: readonly SyncEvent[], push: (allowed: SyncEvent[]) => Promise<T>): Promise<{ result: T; rejected: { id: string; reason: string }[] }> => {
    const tenant = device.tenantId;
    const run = (queues.get(tenant) ?? Promise.resolve()).then(async () => {
      if (!logs.has(tenant)) logs.set(tenant, load(tenant));
      try {
        const log = [...await logs.get(tenant)!];
        const staff = events.some((e) => e.type === 'stock.grn' || e.type === 'stock.grn_undone') ? await store.listStaff(tenant) : [];
        const allowed: SyncEvent[] = [];
        const rejected: { id: string; reason: string }[] = [];
        const known = new Set(log.map((e) => e.id));
        for (const e of events) {
          if (!RELEVANT.has(e.type) || known.has(e.id)) { allowed.push(e); continue; } // not ours to check, or sent before
          const why = stockRuleProblem(e, { state: purchasesFromEvents(log, stockSettingsFromEvents(log)), settings: stockSettingsFromEvents(log), staff, now: now(), items: stockFacts(log) });
          if (why) { rejected.push({ id: e.id, reason: why }); continue; }
          allowed.push(e);
          log.push(e);
          known.add(e.id);
        }
        const result = await push(allowed);
        logs.set(tenant, Promise.resolve(log));
        return { result, rejected };
      } catch (err) {
        logs.delete(tenant); // what we kept may differ from what was stored: read it again next time
        throw err;
      }
    });
    queues.set(tenant, run.catch(() => undefined));
    return run;
  };
}
