import type { Actor } from '../src/domain/auth.ts';
import { isBigGap } from '../src/domain/counting.ts';
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
]);

interface Context { state: PurchaseState; settings: StockSettings; staff: readonly StaffMember[]; now: number }

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
export const stockRuleProblem = (e: SyncEvent, { state, settings, staff, now }: Context): string | null => {
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
    case 'stock.counted': {
      // A gap beyond the owner's allowance must say why: the device is not trusted to have asked.
      if (e.reason === null && isBigGap(e.counted - Math.max(0, e.expected), e.expected, e.valueCents, settings) && e.expected > 0) {
        return 'This count is a long way from what was expected. Count again and say why: spoiled, spilled, wrong entry, or other.';
      }
      return null;
    }
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
          const why = stockRuleProblem(e, { state: purchasesFromEvents(log, stockSettingsFromEvents(log)), settings: stockSettingsFromEvents(log), staff, now: now() });
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
