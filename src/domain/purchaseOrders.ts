import type { Actor } from './auth.ts';
import type { GrnLine, PoLine, SyncEvent } from './sync.ts';
import { docNumber, pendingNumber } from './docNumbers.ts';
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

/** A GRN as the screens list it: it stays on record when undone. */
export interface PurchaseGrn {
  id: string;
  grnNo: string;
  orderId: string;
  poNo: string;
  supplierId: string;
  at: number;
  lines: GrnLine[];
  shortDecision: 'wait' | 'close' | null;
  overDecision: 'accept' | 'return' | null;
  /** Taken back: when, and why. */
  undone: { at: number; reason: string } | null;
}

export interface PurchaseState {
  /** Every GRN, newest first (undone ones marked). */
  grns: PurchaseGrn[];
  /** Orders still awaiting goods: Open and Partly received, oldest first. */
  open: PurchaseOrder[];
  /** Every order, with its status. */
  orders: PurchaseOrder[];
  /** Days a supplier takes from order to first delivery, from its last orders. */
  leadDays: Map<string, number>;
  /** The supplier each item last came from. */
  lastSupplier: Map<string, string>;
}

const DAY = 86_400_000;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export const poNumber = (n: number): string => docNumber('PO', n);
export const grnNumber = (n: number): string => docNumber('GRN', n);

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
  interface Doc { id: string; poNo: string | undefined; supplierId: string; lines: PoLine[]; at: number; actor: Actor; cancelled: string | null }
  const docs = new Map<string, Doc>();
  const grns = new Map<string, { id: string; grnNo: string | undefined; orderId: string; supplierId: string; at: number; lines: GrnLine[]; closes: boolean; shortDecision: 'wait' | 'close' | null; overDecision: 'accept' | 'return' | null }>();
  const undone = new Map<string, { at: number; reason: string }>();
  /** Live GRNs per order, as the events arrive: an edit or cancel after one is ignored. */
  const live = new Map<string, Set<string>>();
  /** The number the shop server gave each document; until it arrives the document is "pending". */
  const numbers = new Map<string, string>();
  /** A record that arrives twice (a sync retry, two routes) counts once. */
  const seen = new Set<string>();
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    if (e.type === 'stock.numbered') numbers.set(e.docId, e.number);
    else if (e.type === 'stock.ordered') {
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
      grns.set(e.id, { id: e.id, grnNo: e.grnNo, orderId: e.orderId, supplierId: e.supplierId, at: e.at, lines: e.lines, closes: e.shortDecision !== 'wait', shortDecision: e.shortDecision ?? null, overDecision: e.overDecision ?? null });
      live.set(e.orderId, (live.get(e.orderId) ?? new Set()).add(e.id));
    } else if (e.type === 'stock.grn_undone') {
      undone.set(e.grnId, { at: e.at, reason: e.reason ?? '' });
      const g = grns.get(e.grnId);
      if (g) live.get(g.orderId)?.delete(e.grnId);
    }
  }

  const standing = [...grns.values()].filter((g) => !undone.has(g.id)).sort((a, b) => a.at - b.at);
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
      got.set(l.itemId, round3((got.get(l.itemId) ?? 0) + (l.accepted ?? l.received)));
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
    return { id: d.id, poNo: numbers.get(d.id) ?? d.poNo ?? pendingNumber('PO'), supplierId: d.supplierId, lines, at: d.at, actor: d.actor, status, editable: !hasGrn && d.cancelled === null, cancelReason: d.cancelled };
  });

  const poNoOf = new Map(orders.map((o) => [o.id, o.poNo]));
  const grnList = [...grns.values()].sort((a, b) => b.at - a.at).map((g): PurchaseGrn => ({
    id: g.id, grnNo: numbers.get(g.id) ?? g.grnNo ?? pendingNumber('GRN'), orderId: g.orderId, poNo: poNoOf.get(g.orderId) ?? pendingNumber('PO'), supplierId: g.supplierId, at: g.at, lines: g.lines,
    shortDecision: g.shortDecision, overDecision: g.overDecision, undone: undone.get(g.id) ?? null,
  }));

  return { open: orders.filter((o) => o.status === 'open' || o.status === 'partly'), orders, grns: grnList, leadDays, lastSupplier };
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

/** What came against what was still owed, line by line (in packs); any difference needs a manager. */
export const compareDelivery = (lines: readonly GrnLine[]): { lines: CheckedLine[]; needsApproval: boolean; hasShort: boolean; hasOver: boolean } => {
  const checked = lines.map((l) => {
    const diff = round3(l.received - l.ordered);
    return { ...l, diff, match: diff === 0 ? 'ok' : diff < 0 ? 'short' : 'over' } as CheckedLine;
  });
  return {
    lines: checked, needsApproval: checked.some((l) => l.match !== 'ok'),
    hasShort: checked.some((l) => l.match === 'short'), hasOver: checked.some((l) => l.match === 'over'),
  };
};

/**
 * What goes into stock. Extra that came: "accept" takes what came; "return" takes only what
 * was owed and records the rest as returned. A short line takes what came.
 */
export const settleGrn = (lines: readonly GrnLine[], overDecision: 'accept' | 'return' | null): GrnLine[] =>
  lines.map((l) => {
    const over = l.received > l.ordered;
    const accepted = over && overDecision === 'return' ? l.ordered : l.received;
    return { itemId: l.itemId, ordered: l.ordered, received: l.received, accepted, returned: round3(l.received - accepted) };
  });

/** The delivery date the GRN list shows: placed on + the supplier's delivery time. */
export const expectedBy = (order: Pick<PurchaseOrder, 'at' | 'supplierId'>, leadDays: ReadonlyMap<string, number>, defaultLeadDays: number): number =>
  order.at + Math.ceil(leadDays.get(order.supplierId) ?? defaultLeadDays) * DAY;

/**
 * Can this GRN be undone now? null: yes. Otherwise why not, in plain words. Only the
 * latest GRN of an order, only within the allowed hours; once.
 */
export const undoCheck = (state: Pick<PurchaseState, 'grns'>, grnId: string, now: number, hours: number): string | null => {
  const g = state.grns.find((x) => x.id === grnId);
  if (!g) return 'That GRN is not here.';
  if (g.undone) return `${g.grnNo} was already undone.`;
  const latest = state.grns.find((x) => x.orderId === g.orderId && !x.undone);
  if (latest?.id !== g.id) return `Only the latest GRN of ${g.poNo} can be undone. Undo ${latest?.grnNo ?? 'the later one'} first.`;
  if (now - g.at > hours * 3_600_000) return `${g.grnNo} is older than ${hours} hours: it can no longer be undone. Correct the stock with a count.`;
  return null;
};

export interface GrnDecisions { short: 'wait' | 'close' | null; over: 'accept' | 'return' | null }

/**
 * Is this GRN allowed against this order? null: yes. Otherwise why not, in plain words.
 * The one check: the screen, the store and the server all use it.
 */
export const grnProblem = (
  order: Pick<PurchaseOrder, 'poNo' | 'status' | 'lines'>, lines: readonly GrnLine[], decisions: GrnDecisions, approver: Pick<Actor, 'role'> | null,
): string | null => {
  if (order.status !== 'open' && order.status !== 'partly') return `${order.poNo} is ${order.status}: nothing more can be received on it.`;
  if (lines.length === 0) return 'There is nothing on this GRN.';
  for (const l of lines) {
    const owed = order.lines.find((x) => x.itemId === l.itemId);
    if (!owed) return 'That item is not on this order.';
    if (!Number.isFinite(l.received) || l.received < 0) return 'An amount cannot be less than zero.';
    if (round3(l.ordered) !== owed.remaining) return `${order.poNo} changed since this GRN was opened. Open it again.`;
  }
  const checked = compareDelivery(lines);
  if (checked.needsApproval && !(approver && (approver.role === 'manager' || approver.role === 'owner'))) return 'A delivery that differs from the order needs a manager to approve it.';
  if (checked.hasShort && !decisions.short) return 'Choose: wait for the rest, or close the order.';
  if (checked.hasOver && !decisions.over) return 'Choose: accept the extra, or return it.';
  return null;
};

export const UNDO_REASONS = ['Entered by mistake', 'Wrong amounts', 'Goods sent back', 'Other'] as const;

/** What an order draft comes to: items, packs, and about what it costs at today's pack prices. */
export const orderTotals = (lines: readonly PoLine[], priceCents: ReadonlyMap<string, number>): { items: number; packs: number; cents: number } => {
  let packs = 0;
  let cents = 0;
  const counted = lines.filter((l) => l.packs > 0);
  for (const l of counted) { packs += l.packs; cents += Math.round(l.packs * (priceCents.get(l.itemId) ?? 0)); }
  return { items: counted.length, packs: round3(packs), cents };
};

/** What a delivery comes to against what was owed, in packs. */
export const grnTotals = (lines: readonly GrnLine[]): { expected: number; received: number } => ({
  expected: round3(lines.reduce((n, l) => n + l.ordered, 0)),
  received: round3(lines.reduce((n, l) => n + l.received, 0)),
});
