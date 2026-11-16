import { lineItemName } from './halves.ts';
import { itemById } from './menu.ts';
import type { SyncEvent } from './sync.ts';
import type { OrderLine } from './types.ts';

/**
 * What changed on a paid order since its money last moved (SCRUM-247), for the change slip:
 * "- 1 x Devilled Chicken L" for what came off, "+ ..." for what went on. Only changes made after
 * paying (`afterPay`), after the payment at `paidAt` and its last settle, and not undone.
 */
export function paidChanges(events: readonly SyncEvent[], orderNumber: number, paidAt: number): string[] {
  const undone = new Set(events.flatMap((e) => (e.type === 'order.change_undone' ? [e.undoneEventId] : [])));
  const out: string[] = [];
  for (const e of events) {
    if (e.orderNumber !== orderNumber || e.at < paidAt || undone.has(e.id)) continue;
    if (e.type === 'order.settled') out.length = 0; // already on an earlier slip
    if (e.type === 'order.item_cancelled' && e.afterPay) out.push(`- ${lineText(e.before)}`);
    if (e.type === 'order.item_changed' && e.afterPay) out.push(`- ${lineText(e.before)}`, `+ ${lineText(e.after)}`);
  }
  return out;
}

const lineText = (l: OrderLine): string => {
  const size = itemById(l.itemId).variants?.find((v) => v.id === l.size)?.label;
  return [`${l.qty} x ${lineItemName(l)}`, size].filter(Boolean).join(' ');
};
