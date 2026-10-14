import { basePrice } from './halves.ts';
import type { Cents, MenuItem, OrderLine } from './types.ts';

/** Size price (for a half-and-half pizza, half of each half's) plus extras. */
export const unitPrice = (item: MenuItem, line: Pick<OrderLine, 'size' | 'adds' | 'half'>): Cents => {
  const base = basePrice(item, line);
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

const NOTES: Cents[] = [100000, 200000, 500000, 1000000, 2000000]; // Rs 1k, 2k, 5k, 10k, 20k

/** Quick cash buttons: exact, next Rs 500, then the notes a customer would hand over. */
export const quickCashAmounts = (total: Cents): Cents[] => {
  if (total <= 0) return [];
  const roundedUp = Math.ceil(total / 50000) * 50000;
  const notes = NOTES.filter((n) => n >= total);
  return [...new Set([total, roundedUp, ...notes])].sort((a, b) => a - b).slice(0, 4);
};
