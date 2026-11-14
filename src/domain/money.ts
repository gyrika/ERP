import { basePrice } from './halves.ts';
import type { Cents, MenuItem, OrderLine } from './types.ts';

/**
 * Size price (for a half-and-half pizza, half of each half's) plus extras. A dish in a combo box
 * costs its share of the box price, plus what its pick costs extra, plus extras.
 */
export const unitPrice = (item: MenuItem, line: Pick<OrderLine, 'size' | 'adds' | 'half' | 'box'>): Cents => {
  const base = line.box ? line.box.share + line.box.extra : basePrice(item, line);
  const adds = line.adds.reduce((sum, id) => sum + (item.adds.find((o) => o.id === id)?.price ?? 0), 0);
  return base + adds;
};

export const lineTotal = (item: MenuItem, line: OrderLine): Cents => unitPrice(item, line) * line.qty;

/** "6,600" — the design shows whole rupees with no currency prefix. */
export const fmt = (cents: Cents): string => {
  const rupees = Math.floor(cents / 100);
  const rest = cents % 100;
  const body = rupees.toLocaleString('en-US');
  return rest ? `${body}.${String(rest).padStart(2, '0')}` : body;
};

/** Menu-card style from the design: whole rupees, no thousands separator ("M 1450"). */
export const fmtPlain = (cents: Cents): string => String(Math.round(cents / 100));

/** A typed rupee amount ("6,400", "6400.5", "1,250.25") in cents, or null. Parsed as text: no float maths. */
export const parseLKR = (raw: string): Cents | null => {
  const match = raw.trim().replace(/^rs\.?\s*/i, '').match(/^(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const cents = Number(match[1].replace(/,/g, '')) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
};

/** Receipts and exports: "Rs 6,600". */
export const formatLKR = (cents: Cents): string => `Rs ${fmt(cents)}`;

const ROUND_UPS: Cents[] = [10000, 50000, 100000, 500000]; // Rs 100, 500, 1k, 5k

/** Quick cash buttons: exact, then the total rounded up to each step, what a customer really hands over. */
export const quickCashAmounts = (total: Cents): Cents[] => {
  if (total <= 0) return [];
  const amounts = new Set([total, ...ROUND_UPS.map((step) => Math.ceil(total / step) * step)]);
  // Near a big note the steps collapse (4,700: only 5,000); the next Rs 5k is the one other real choice.
  if (amounts.size < 3) amounts.add((Math.ceil(total / 500000) + 1) * 500000);
  return [...amounts].sort((a, b) => a - b);
};
