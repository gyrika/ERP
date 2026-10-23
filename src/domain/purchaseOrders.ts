import type { Actor } from './auth.ts';
import type { GrnLine, PoLine, SyncEvent } from './sync.ts';
import { STOCK_DEFAULTS, type StockSettings } from './stockSettings.ts';

/**
 * Purchase orders and goods received (GRN), folded from the event log.
 * Status: Open (nothing received) → Partly received (some came, the rest is awaited)
 * → Closed (everything came, or the manager closed it short); or Cancelled. The GRN
 * screen offers Open and Partly received orders, for what is still owed. An order
 * can be edited or cancelled (with a reason) only while no GRN stands against it.
 */
export type PoStatus = 'open' | 'partly' | 'closed' | 'cancelled';

export interface PoLineState {
  itemId: string;
  packs: number;
  /** The packs in base units, when the order recorded it. */
  stockQty: number | null;
  /** Packs received so far (GRNs that stand, not undone). */
  received: number;
  /** Packs still owed: ordered less received, never below zero. */
  remaining: number;
}

export interface PurchaseOrder {
  id: string;
  poNo: string;
  supplierId: string;
  lines: PoLineState[];
  at: number;
  actor: Actor;
  status: PoStatus;
  /** No GRN stands against it: it can still be edited or cancelled. */
  editable: boolean;
  cancelReason: string | null;
}

export interface PurchaseState {
  /** Orders still awaiting goods: Open and Partly received, oldest first. */
  open: PurchaseOrder[];
  /** Every order, with its status. */
  orders: PurchaseOrder[];
  /** POs and GRNs ever written: the next numbers follow them. */
  poCount: number;
  grnCount: number;
  /** Days a supplier takes from order to first delivery, from its last orders. */
  leadDays: Map<string, number>;
  /** The supplier each item last came from. */
  lastSupplier: Map<string, string>;
}

const DAY = 86_400_000;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export const poNumber = (n: number): string => `PO-${String(n).padStart(4, '0')}`;
export const grnNumber = (n: number): string => `GRN-${String(n).padStart(4, '0')}`;

export const CANCEL_REASONS = ['Ordered by mistake', "Supplier can't deliver", 'No longer needed', 'Other'] as const;

/** Merges lines of the same item (packs add up). Lines with no packs are dropped. */
export const mergeLines = (lines: readonly PoLine[]): PoLine[] => {
  const by = new Map<string, PoLine>();
  for (const l of lines) {
    if (!(l.packs > 0)) continue;
    const had = by.get(l.itemId);
    by.set(l.itemId, had ? { ...had, packs: round3(had.packs + l.packs), stockQty: had.stockQty !== undefined && l.stockQty !== undefined ? had.stockQty + l.stockQty : undefined } : { ...l });
  }
  return [...by.values()].map((l) => (l.stockQty === undefined ? { itemId: l.itemId, packs: l.packs } : l));
};

export const purchasesFromEvents = (events: readonly SyncEvent[], settings: Pick<StockSettings, 'leadSamples'> = STOCK_DEFAULTS): PurchaseState => {
  interface Doc { id: string; poNo: string; supplierId: string; lines: PoLine[]; at: number; actor: Actor; cancelled: string | null }
  const docs = new Map<string, Doc>();
  const grns = new Map<string, { orderId: string; supplierId: string; at: number; lines: GrnLine[]; closes: boolean }>();
  const undone = new Set<string>();
  /** Live GRNs per order, as the events arrive: an edit or cancel after one is ignored. */
  const live = new Map<string, Set<string>>();
  let poCount = 0;
  let grnCount = 0;
  for (const e of events) {
    if (e.type === 'stock.ordered') {
      poCount++;
      docs.set(e.id, { id: e.id, poNo: e.poNo, supplierId: e.supplierId, lines: e.lines, at: e.at, actor: e.actor, cancelled: null });
    } else if (e.type === 'stock.order_edited') {
      const d = docs.get(e.orderId);
      if (d && !d.cancelled && !live.get(e.orderId)?.size) d.lines = mergeLines(e.lines);
    } else if (e.type === 'stock.order_cancelled') {
      const d = docs.get(e.orderId);
      if (d && !live.get(e.orderId)?.size) d.cancelled = e.reason;
    } else if (e.type === 'stock.order_reopened') {
      const d = docs.get(e.orderId);
      if (d) d.cancelled = null;
    } else if (e.type === 'stock.grn') {
      grnCount++;
      grns.set(e.id, { orderId: e.orderId, supplierId: e.supplierId, at: e.at, lines: e.lines, closes: e.shortDecision !== 'wait' });
      live.set(e.orderId, (live.get(e.orderId) ?? new Set()).add(e.id));
    } else if (e.type === 'stock.grn_undone') {
      undone.add(e.grnId);
      const g = grns.get(e.grnId);
      if (g) live.get(g.orderId)?.delete(e.grnId);
    }
  }

  const standing = [...grns.entries()].filter(([id]) => !undone.has(id)).map(([, g]) => g).sort((a, b) => a.at - b.at);
  const leadSamples = new Map<string, number[]>();
  const lastSupplier = new Map<string, string>();
  const receivedBy = new Map<string, Map<string, number>>();
  const lastCloses = new Map<string, boolean>();
  /** Delivery time is learned from the FIRST GRN of each order only. */
  const firstOf = new Set<string>();
  for (const g of standing) {
    const doc = docs.get(g.orderId);
    if (doc && !firstOf.has(g.orderId)) {
      firstOf.add(g.orderId);
      leadSamples.set(g.supplierId, [...(leadSamples.get(g.supplierId) ?? []), (g.at - doc.at) / DAY].slice(-settings.leadSamples));
    }
    const got = receivedBy.get(g.orderId) ?? new Map<string, number>();
    for (const l of g.lines) {
      if (l.received > 0) lastSupplier.set(l.itemId, g.supplierId);
      got.set(l.itemId, round3((got.get(l.itemId) ?? 0) + l.received));
    }
    receivedBy.set(g.orderId, got);
    lastCloses.set(g.orderId, g.closes);
  }
  /** Average days from order to first delivery, of the last few; a supplier with none is not in the map. */
  const leadDays = new Map([...leadSamples].map(([id, days]) => [id, days.reduce((a, b) => a + b, 0) / days.length]));

  const orders = [...docs.values()].sort((a, b) => a.at - b.at).map((d): PurchaseOrder => {
    const got = receivedBy.get(d.id);
    const lines = d.lines.map((l): PoLineState => {
      const received = got?.get(l.itemId) ?? 0;
      return { itemId: l.itemId, packs: l.packs, stockQty: l.stockQty ?? null, received, remaining: Math.max(0, round3(l.packs - received)) };
    });
    const hasGrn = got !== undefined;
    const allIn = lines.every((l) => l.remaining === 0);
    const status: PoStatus = d.cancelled !== null ? 'cancelled' : !hasGrn ? 'open' : allIn || lastCloses.get(d.id) ? 'closed' : 'partly';
    return { id: d.id, poNo: d.poNo, supplierId: d.supplierId, lines, at: d.at, actor: d.actor, status, editable: !hasGrn && d.cancelled === null, cancelReason: d.cancelled };
  });

  return { open: orders.filter((o) => o.status === 'open' || o.status === 'partly'), orders, poCount, grnCount, leadDays, lastSupplier };
};

/** Packs of each item still owed on open orders: they are already coming. */
export const onOrder = (open: readonly PurchaseOrder[]): Map<string, number> => {
  const packs = new Map<string, number>();
  for (const o of open) for (const l of o.lines) if (l.remaining > 0) packs.set(l.itemId, round3((packs.get(l.itemId) ?? 0) + l.remaining));
  return packs;
};

/**
 * What "Place order" does with a supplier's draft, so one item is never on two orders:
 * lines already on one of this supplier's open orders are ADDED to it (when it can still
 * be edited), or BLOCKED (it is partly received: wait for it or close it first); the
 * rest become a new order.
 */
export interface OrderPlan {
  add: { order: PurchaseOrder; lines: PoLine[] }[];
  blocked: { itemId: string; poNo: string }[];
  create: PoLine[];
  /** For each draft item already on an open order of this supplier. */
  onOrder: Map<string, string>;
}

export const planOrder = (open: readonly PurchaseOrder[], supplierId: string, lines: readonly PoLine[]): OrderPlan => {
  const plan: OrderPlan = { add: [], blocked: [], create: [], onOrder: new Map() };
  for (const l of lines) {
    if (!(l.packs > 0)) continue;
    const po = open.find((o) => o.supplierId === supplierId && o.lines.some((x) => x.itemId === l.itemId));
    if (!po) { plan.create.push(l); continue; }
    plan.onOrder.set(l.itemId, po.poNo);
    if (!po.editable) { plan.blocked.push({ itemId: l.itemId, poNo: po.poNo }); continue; }
    const slot = plan.add.find((a) => a.order.id === po.id);
    if (slot) slot.lines.push(l); else plan.add.push({ order: po, lines: [l] });
  }
  return plan;
};

export type Match = 'ok' | 'short' | 'over';
export interface CheckedLine extends GrnLine { match: Match; diff: number }

/** What came against what was ordered, line by line (in packs); any difference needs a manager. */
export const compareDelivery = (lines: readonly GrnLine[]): { lines: CheckedLine[]; needsApproval: boolean } => {
  const checked = lines.map((l) => {
    const diff = Math.round((l.received - l.ordered) * 1000) / 1000;
    return { ...l, diff, match: diff === 0 ? 'ok' : diff < 0 ? 'short' : 'over' } as CheckedLine;
  });
  return { lines: checked, needsApproval: checked.some((l) => l.match !== 'ok') };
};
