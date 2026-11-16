import type { SyncEvent } from './sync.ts';
import type { Order, OrderLine } from './types.ts';

/**
 * Sent items taken off an order before it was paid, for the bill on screen: still drawn there,
 * struck through, so the history stays in sight (owner, 2026-11-17). Items never sent come off
 * completely (a mis-tap has its Undo); items taken off after paying are `paidEdits`' (they carry
 * money back). Undone removals are left out.
 */
export interface RemovedLine {
  lineId: string;
  before: OrderLine;
  at: number;
  /** The manager's reason, or the counter's own ("Before it was made", "Already made"). */
  reason: string;
  by: string;
}

export function removedLines(events: readonly SyncEvent[], order: Order & { paidAt?: number }): RemovedLine[] {
  // A sent line can only come off after the order first went to the kitchen: that also keeps
  // yesterday's order with the same number out.
  if (order.sentAt === undefined) return [];
  const undone = new Set(events.flatMap((e) => (e.type === 'order.change_undone' ? [e.undoneEventId] : [])));
  const out: RemovedLine[] = [];
  for (const e of events) {
    if (e.type !== 'order.item_cancelled' || e.orderNumber !== order.number || e.afterPay) continue;
    if (e.at < order.sentAt || (order.paidAt !== undefined && e.at > order.paidAt) || undone.has(e.id)) continue;
    if (!e.before.sent || order.lines.some((l) => l.id === e.lineId)) continue;
    out.push({ lineId: e.lineId, before: e.before, at: e.at, reason: e.reason, by: e.actor.name });
  }
  return out;
}
