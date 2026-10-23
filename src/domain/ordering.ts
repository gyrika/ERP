import type { BaseUnit } from './inventoryData.ts';
import type { StockSettings } from './stockSettings.ts';
import { formatQuantity } from './quantity.ts';

/**
 * Ordering from a supplier: what the manager needs when an item runs low is the
 * message, ready to send. All the reorder maths is `suggestions` below, nowhere else;
 * every number it uses is in stockSettings.ts.
 */
export interface OrderLine { name: string; packs: number; packQty: number; baseUnit: BaseUnit }

/** "2 × Mozzarella (Prabhat), 2 kg packs", one line per item; lines with no packs are left out. */
export const orderMessage = (lines: readonly OrderLine[], shop = 'CheesyBeez', intro = `Hi, this is ${shop}. Please send:`): string => [
  intro,
  ...lines.filter((l) => l.packs > 0).map((l) => `${l.packs} × ${l.name} (${formatQuantity(l.packQty, l.baseUnit)} ${l.packs === 1 ? 'pack' : 'packs'})`),
  'Thank you.',
].join('\n');

/** WhatsApp links need the country code: 077 123 4567 becomes 94771234567. */
export const whatsAppNumber = (phone: string): string => {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 10 && digits.startsWith('0') ? `94${digits.slice(1)}` : digits;
};

/** Opens WhatsApp with the message typed in; the manager presses send. */
export const whatsAppLink = (phone: string, text: string): string =>
  `https://wa.me/${whatsAppNumber(phone)}?text=${encodeURIComponent(text)}`;

export interface Suggestion { itemId: string; supplierId: string; packs: number; stockQty: number }

/** The row facts a suggestion needs. */
export interface SuggestRow {
  id: string;
  counted: boolean;
  archived: boolean;
  usedPerDay: number;
  onHandBaseUnits: number;
  packQty: number;
  supplierIds: readonly string[];
}

/** The supplier an item is ordered from: the one it last came from, else its first active one. */
const supplierOf = (row: SuggestRow, active: ReadonlySet<string>, last: ReadonlyMap<string, string>): string | null => {
  const prev = last.get(row.id);
  if (prev && active.has(prev) && row.supplierIds.includes(prev)) return prev;
  return row.supplierIds.find((id) => active.has(id)) ?? null;
};

/**
 * What to order now (THE reorder rule). For each item with a known rate of use:
 *   reorder point = daily use × (delivery time + spare days)
 *   suggest when on hand + on order <= reorder point
 *   packs = daily use × (delivery time + order days) − (on hand + on order), rounded up
 * Items never counted, archived, with no use, or with no active supplier are skipped.
 * Never 0 or negative packs. `onOrderPacks` is what open orders still owe, in packs.
 */
export const suggestions = (
  rows: readonly SuggestRow[],
  active: ReadonlySet<string>,
  onOrderPacks: ReadonlyMap<string, number>,
  leadDays: ReadonlyMap<string, number>,
  lastSupplier: ReadonlyMap<string, string>,
  settings: Pick<StockSettings, 'defaultLeadDays' | 'spareDays' | 'orderDays'>,
): Suggestion[] => {
  const out: Suggestion[] = [];
  for (const row of rows) {
    if (row.archived || !row.counted || row.usedPerDay <= 0 || row.packQty <= 0) continue;
    const supplierId = supplierOf(row, active, lastSupplier);
    if (!supplierId) continue;
    const lead = leadDays.get(supplierId) ?? settings.defaultLeadDays;
    const have = Math.max(0, row.onHandBaseUnits) + (onOrderPacks.get(row.id) ?? 0) * row.packQty;
    if (have > row.usedPerDay * (lead + settings.spareDays)) continue;
    const packs = Math.max(1, Math.ceil((row.usedPerDay * (lead + settings.orderDays) - have) / row.packQty));
    out.push({ itemId: row.id, supplierId, packs, stockQty: packs * row.packQty });
  }
  return out;
};

/** The suggestions as drafts: packs per item, grouped by supplier. */
export const draftsOf = (rows: readonly { id: string; suggestedPacks: number; suggestedSupplierId: string | null }[]): Map<string, Record<string, number>> => {
  const drafts = new Map<string, Record<string, number>>();
  for (const r of rows) {
    if (r.suggestedPacks > 0 && r.suggestedSupplierId) drafts.set(r.suggestedSupplierId, { ...drafts.get(r.suggestedSupplierId), [r.id]: r.suggestedPacks });
  }
  return drafts;
};

/**
 * What each supplier's cart holds (THE cart rule): a saved cart as it was saved; else what the
 * reorder rule suggests for that supplier, less any item already in another supplier's saved
 * cart, so an item moved to another cart never comes back to the first one.
 */
export const cartsOf = (
  suggested: ReadonlyMap<string, Record<string, number>>,
  saved: ReadonlyMap<string, Record<string, number>>,
): Map<string, Record<string, number>> => {
  const inCart = new Set([...saved.values()].flatMap((c) => Object.keys(c)));
  const carts = new Map<string, Record<string, number>>();
  for (const [supplierId, packs] of suggested) {
    if (saved.has(supplierId)) continue;
    const left = Object.fromEntries(Object.entries(packs).filter(([id]) => !inCart.has(id)));
    if (Object.keys(left).length > 0) carts.set(supplierId, left);
  }
  for (const [supplierId, packs] of saved) carts.set(supplierId, packs);
  return carts;
};

/** The supplier whose cart holds this item, if any. */
export const cartOf = (carts: ReadonlyMap<string, Record<string, number>>, itemId: string): string | null =>
  [...carts].find(([, c]) => itemId in c)?.[0] ?? null;
