import type { BaseUnit } from './inventoryData.ts';
import { formatQuantity } from './quantity.ts';

/**
 * Ordering from a supplier (SCRUM-92): what the manager needs when an item runs low
 * is the message, ready to send. How many packs: enough for ORDER_DAYS at the last
 * week's rate, at least one. The manager can change every number before sending.
 */
export const ORDER_DAYS = 7;

export const suggestPacks = (row: { usedPerDay: number; onHandBaseUnits: number; packQty: number }): number => {
  if (row.packQty <= 0) return 1;
  const need = row.usedPerDay * ORDER_DAYS - Math.max(0, row.onHandBaseUnits);
  return Math.max(1, Math.ceil(need / row.packQty));
};

export interface OrderLine { name: string; packs: number; packQty: number; baseUnit: BaseUnit }

/** "2 × Mozzarella (Prabhat), 2 kg packs", one line per item; lines with no packs are left out. */
export const orderMessage = (lines: readonly OrderLine[], shop = 'CheesyBeez'): string => [
  `Hi, this is ${shop}. Please send:`,
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

/** Days of use kept in hand beyond the supplier's delivery time. */
export const SAFETY_DAYS = 2;

/**
 * Packs to order now, 0 when not yet (SCRUM purchase orders). With a known rate of use:
 * order when on hand + already on order covers no more than the delivery time plus
 * SAFETY_DAYS, and then enough for the delivery time plus ORDER_DAYS. Without one, the
 * old rule: low or out, one pack. Not counted: unknown, never suggested.
 */
export const suggestOrder = (
  row: { counted: boolean; usedPerDay: number; onHandBaseUnits: number; packQty: number; low: boolean },
  onOrderPacks: number,
  leadDays: number,
): number => {
  if (!row.counted || row.packQty <= 0) return 0;
  const have = Math.max(0, row.onHandBaseUnits) + onOrderPacks * row.packQty;
  if (row.usedPerDay <= 0) return row.low && onOrderPacks === 0 ? 1 : 0;
  if (have > row.usedPerDay * (leadDays + SAFETY_DAYS)) return 0;
  return Math.max(1, Math.ceil((row.usedPerDay * (leadDays + ORDER_DAYS) - have) / row.packQty));
};
