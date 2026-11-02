import type { MoneyOut } from './moneyOut.ts';
import { grnValueCents, type PurchaseGrn } from './purchaseOrders.ts';
import type { Cents } from './types.ts';

/**
 * What each delivery still owes (SCRUM-204). A GRN is what the shop owes a supplier; a supplier
 * payment pays it. Pure: GRNs and payments in, what is owed out. Nothing is stored: it follows
 * from the two, so undoing a GRN or a payment puts it right by itself.
 *
 * A payment goes first to the GRNs it names, oldest first. Anything left (a named GRN undone, or an
 * older entry that named none) goes to that supplier's oldest unpaid GRN: money paid to a supplier
 * is never lost, however it was recorded. New payments always name a GRN (checkGrnPayment).
 */

export interface GrnOwed { id: string; grnNo: string; supplierId: string; at: number; value: Cents; paid: Cents; owed: Cents }
type Grn = Pick<PurchaseGrn, 'id' | 'grnNo' | 'supplierId' | 'at' | 'lines' | 'undone'>;

/** Every delivery, however old, oldest first, with what is paid and owed; not the undone, nor those the owner removed. */
export const grnsOwed = (grns: readonly Grn[], paid: readonly MoneyOut[], removed: ReadonlySet<string> = new Set()): GrnOwed[] => {
  const rows: GrnOwed[] = grns
    .filter((g) => !g.undone && !removed.has(g.id))
    .map((g) => ({ id: g.id, grnNo: g.grnNo, supplierId: g.supplierId, at: g.at, value: grnValueCents(g.lines), paid: 0, owed: grnValueCents(g.lines) }))
    .sort((a, b) => a.at - b.at);
  const pay = (row: GrnOwed, cents: Cents): Cents => {
    const part = Math.min(row.owed, cents);
    row.paid += part;
    row.owed -= part;
    return cents - part;
  };
  const leftover = new Map<string, Cents>();
  for (const o of paid) {
    if (o.what !== 'supplier' || !o.supplierId) continue;
    let left = o.cents;
    for (const row of rows) {
      if (left > 0 && o.grnIds?.includes(row.id) && row.supplierId === o.supplierId) left = pay(row, left);
    }
    if (left > 0) leftover.set(o.supplierId, (leftover.get(o.supplierId) ?? 0) + left);
  }
  for (const row of rows) {
    const left = leftover.get(row.supplierId) ?? 0;
    if (left > 0) leftover.set(row.supplierId, pay(row, left));
  }
  return rows;
};

/**
 * A supplier is paid only against its GRNs (the owner, 2026-11-03): null when this can be recorded,
 * else what is missing. The screen asks this; the server cannot, since older entries name no GRN.
 */
export const checkGrnPayment = (grnIds: readonly string[], cents: Cents | null, rows: readonly GrnOwed[]): string | null => {
  if (grnIds.length === 0) return rows.length === 0 ? 'No GRN to pay' : 'Choose the GRN';
  const owed = rows.filter((r) => grnIds.includes(r.id)).reduce((n, r) => n + r.owed, 0);
  if (cents !== null && cents > owed) return 'More than the GRN owes';
  return null;
};
