import type { MoneyOut } from './moneyOut.ts';
import { grnValueCents, type PurchaseGrn } from './purchaseOrders.ts';
import type { Cents } from './types.ts';

/**
 * What each delivery still owes (SCRUM-204). A GRN is what the shop owes a supplier; a supplier
 * payment pays it. Pure: GRNs and payments in, what is owed out. Nothing is stored: it follows
 * from the two, so undoing a GRN or a payment puts it right by itself.
 *
 * A payment goes first to the GRNs it names, oldest first. Anything left (paid more, a named GRN
 * undone, or paid with no GRN named) goes to that supplier's oldest unpaid GRN: money paid to a
 * supplier is never lost, however it was recorded.
 */

/**
 * Deliveries before this were never tracked against payments: without a line, every old GRN would
 * read as a debt the shop has already paid. 3 Nov 2026, when Money out began to link them.
 */
export const OWED_SINCE = new Date(2026, 10, 3).getTime();

export interface GrnOwed { id: string; grnNo: string; supplierId: string; at: number; value: Cents; paid: Cents; owed: Cents }
type Grn = Pick<PurchaseGrn, 'id' | 'grnNo' | 'supplierId' | 'at' | 'lines' | 'undone'>;

/** Every delivery that counts, oldest first, with what is paid and owed. */
export const grnsOwed = (grns: readonly Grn[], paid: readonly MoneyOut[], since: number = OWED_SINCE): GrnOwed[] => {
  const rows: GrnOwed[] = grns
    .filter((g) => !g.undone && g.at >= since)
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

export interface SupplierOwed { supplierId: string; owed: Cents; grns: number }

/** Who is owed, most first. */
export const suppliersOwed = (rows: readonly GrnOwed[]): SupplierOwed[] => {
  const by = new Map<string, SupplierOwed>();
  for (const r of rows) {
    if (r.owed <= 0) continue;
    const s = by.get(r.supplierId) ?? { supplierId: r.supplierId, owed: 0, grns: 0 };
    by.set(r.supplierId, { ...s, owed: s.owed + r.owed, grns: s.grns + 1 });
  }
  return [...by.values()].sort((a, b) => b.owed - a.owed);
};
