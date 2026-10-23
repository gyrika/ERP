import type { Actor } from './auth.ts';
import type { GrnLine, PoLine, SyncEvent } from './sync.ts';
import { STOCK_DEFAULTS, type StockSettings } from './stockSettings.ts';

/**
 * Purchase orders and goods received (GRN), folded from the event log. A PO is open
 * until a GRN receives it or it is cancelled; "Goods receiving" offers only open POs,
 * and only their lines. A GRN that differs from its PO needs a manager's PIN.
 */
export interface PurchaseOrder {
  id: string;
  poNo: string;
  supplierId: string;
  lines: PoLine[];
  at: number;
  actor: Actor;
}

export interface PurchaseState {
  open: PurchaseOrder[];
  /** POs and GRNs ever written: the next numbers follow them. */
  poCount: number;
  grnCount: number;
  /** Days a supplier takes from order to first delivery, from its last orders. */
  leadDays: Map<string, number>;
  /** The supplier each item last came from. */
  lastSupplier: Map<string, string>;
}

const DAY = 86_400_000;

export const poNumber = (n: number): string => `PO-${String(n).padStart(4, '0')}`;
export const grnNumber = (n: number): string => `GRN-${String(n).padStart(4, '0')}`;

export const purchasesFromEvents = (events: readonly SyncEvent[], settings: Pick<StockSettings, 'leadSamples'> = STOCK_DEFAULTS): PurchaseState => {
  const orders = new Map<string, PurchaseOrder>();
  const closed = new Set<string>();
  const grns = new Map<string, { orderId: string; supplierId: string; at: number; lines: GrnLine[] }>();
  const undone = new Set<string>();
  let poCount = 0;
  let grnCount = 0;
  for (const e of events) {
    if (e.type === 'stock.ordered') {
      poCount++;
      orders.set(e.id, { id: e.id, poNo: e.poNo, supplierId: e.supplierId, lines: e.lines, at: e.at, actor: e.actor });
    } else if (e.type === 'stock.order_cancelled') closed.add(e.orderId);
    else if (e.type === 'stock.order_reopened') closed.delete(e.orderId);
    else if (e.type === 'stock.grn') {
      grnCount++;
      grns.set(e.id, { orderId: e.orderId, supplierId: e.supplierId, at: e.at, lines: e.lines });
    } else if (e.type === 'stock.grn_undone') undone.add(e.grnId);
  }

  const received = [...grns.entries()].filter(([id]) => !undone.has(id)).map(([, g]) => g).sort((a, b) => a.at - b.at);
  const leadSamples = new Map<string, number[]>();
  const lastSupplier = new Map<string, string>();
  /** Delivery time is learned from the FIRST GRN of each order only. */
  const firstOf = new Set<string>();
  for (const g of received) {
    closed.add(g.orderId);
    const po = orders.get(g.orderId);
    if (po && !firstOf.has(g.orderId)) {
      firstOf.add(g.orderId);
      leadSamples.set(g.supplierId, [...(leadSamples.get(g.supplierId) ?? []), (g.at - po.at) / DAY].slice(-settings.leadSamples));
    }
    for (const l of g.lines) if (l.received > 0) lastSupplier.set(l.itemId, g.supplierId);
  }
  /** Average days from order to first delivery, of the last few; a supplier with none is not in the map. */
  const leadDays = new Map([...leadSamples].map(([id, days]) => [id, days.reduce((a, b) => a + b, 0) / days.length]));

  return {
    open: [...orders.values()].filter((o) => !closed.has(o.id)).sort((a, b) => a.at - b.at),
    poCount, grnCount, leadDays, lastSupplier,
  };
};

/** Packs of each item on open orders: they are already coming. */
export const onOrder = (open: readonly PurchaseOrder[]): Map<string, number> => {
  const packs = new Map<string, number>();
  for (const o of open) for (const l of o.lines) packs.set(l.itemId, (packs.get(l.itemId) ?? 0) + l.packs);
  return packs;
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
