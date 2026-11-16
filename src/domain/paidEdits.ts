import { itemById } from './menu.ts';
import { lineGross } from './totals.ts';
import type { SyncEvent } from './sync.ts';
import type { Cents, OrderLine, PaidOrder } from './types.ts';

/**
 * Every change made to a paid order after it was paid (SCRUM-253), one per line, for the bill on
 * screen: an item added, an item changed (extras, size, how many) or an item taken off, when, and
 * what it did to the money. Lines added on the screen and not yet settled are in it too (`at`
 * undefined: not written to the log until their money is taken).
 *
 * `settled`: its money has changed hands (an `order.settled` came after it). Undone changes are
 * left out. A line added and then taken off again before anything else happened is left out too.
 */
export interface PaidEdit {
  lineId: string;
  kind: 'added' | 'changed' | 'removed';
  /** What it did to the order's total: + the customer owes more, − the shop owes back. */
  amount: Cents;
  /** When it was made; undefined for a line added on screen and not yet settled. */
  at?: number;
  /** What changed, in a few words for the line: "+ Full cheese", "Medium → Large", "2 → 3". */
  what: string[];
  /** A taken-off line, to show struck through (it is no longer on the order). */
  before?: OrderLine;
  settled: boolean;
}

export function paidEdits(events: readonly SyncEvent[], paid: PaidOrder): PaidEdit[] {
  const mine = events.filter((e) => e.orderNumber === paid.number && e.at >= paid.paidAt);
  const undone = new Set(events.flatMap((e) => (e.type === 'order.change_undone' ? [e.undoneEventId] : [])));
  const lastSettle = Math.max(-Infinity, ...mine.filter((e) => e.type === 'order.settled').map((e) => e.at));
  const byLine = new Map<string, PaidEdit>();
  const note = (lineId: string, edit: Omit<PaidEdit, 'lineId' | 'settled'>) => {
    const settled = edit.at !== undefined && edit.at <= lastSettle;
    const was = byLine.get(lineId);
    if (!was) { byLine.set(lineId, { lineId, ...edit, settled }); return; }
    // An item added after paying stays "added" whatever is done to it next; taken off again, it was never there.
    if (was.kind === 'added' && edit.kind === 'removed') { byLine.delete(lineId); return; }
    byLine.set(lineId, {
      ...was,
      kind: was.kind === 'added' ? 'added' : edit.kind,
      amount: was.amount + edit.amount,
      at: edit.at ?? was.at,
      what: was.kind === 'added' ? was.what : [...was.what, ...edit.what],
      ...(edit.before ? { before: edit.before } : {}),
      settled: was.settled && settled,
    });
  };

  for (const e of mine) {
    if (undone.has(e.id)) continue;
    // An add-on send after paying: items added to the paid order.
    if (e.type === 'order.sent' && e.addOn && e.at > paid.paidAt) {
      for (const l of e.lines) note(l.id, { kind: 'added', amount: lineGross(l), at: e.at, what: [] });
    }
    if (e.type === 'order.item_changed' && e.afterPay) {
      note(e.lineId, { kind: 'changed', amount: lineGross(e.after) - lineGross(e.before), at: e.at, what: whatChanged(e.before, e.after) });
    }
    if (e.type === 'order.item_cancelled' && e.afterPay) {
      note(e.lineId, { kind: 'removed', amount: -lineGross(e.before), at: e.at, what: [], before: e.before });
    }
  }
  // Added on screen, not yet settled: nothing in the log yet.
  for (const l of paid.lines) {
    if (!l.sent && !byLine.has(l.id)) byLine.set(l.id, { lineId: l.id, kind: 'added', amount: lineGross(l), what: [], settled: false });
  }
  return [...byLine.values()];
}

/** In a few words what a change did to a line: extras on and off, the size, how many. */
export const whatChanged = (before: OrderLine, after: OrderLine): string[] => {
  const item = itemById(after.itemId);
  const out: string[] = [];
  if (before.itemId !== after.itemId) out.push(`was ${itemById(before.itemId).name.en}`);
  const size = (id: string | undefined) => item.variants?.find((v) => v.id === id)?.label ?? id;
  if (before.size !== after.size && before.itemId === after.itemId) out.push(`${size(before.size)} → ${size(after.size)}`);
  if (before.qty !== after.qty) out.push(`${before.qty} → ${after.qty}`);
  const label = (id: string) => item.adds.find((o) => o.id === id)?.label ?? itemById(before.itemId).adds.find((o) => o.id === id)?.label ?? id;
  for (const id of after.adds) if (!before.adds.includes(id)) out.push(`+ ${label(id)}`);
  for (const id of before.adds) if (!after.adds.includes(id)) out.push(`− ${label(id)}`);
  const outLabel = (id: string) => item.leaveOut?.find((o) => o.id === id)?.label ?? id;
  for (const id of after.outs) if (!before.outs.includes(id)) out.push(outLabel(id));
  if ((before.note ?? '') !== (after.note ?? '') && after.note) out.push(`“${after.note}”`);
  return out;
};
