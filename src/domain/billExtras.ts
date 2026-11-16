import type { Actor } from './auth.ts';
import { ticketTimes } from './insights.ts';
import type { SyncEvent } from './sync.ts';

/**
 * What makes the bill worth keeping (SCRUM-256): the owner's line of the day, how fast the kitchen
 * made this order, and the honeycomb strip that stands in for the dashed rules.
 */

/**
 * The owner's line on the bill (Settings › Printer, owner's PIN, recorded by the shop server). The
 * latest one is printed under the money; an empty text takes it off.
 */
export type BillEvent = {
  id: string;
  shopId: string;
  at: number;
  orderNumber: 0;
  actor: Actor;
  type: 'shop.bill_line_set';
  text: string;
};

export const BILL_EVENT_TYPES = ['shop.bill_line_set'] as const satisfies readonly BillEvent['type'][];

/** Two printed lines at most. */
export const BILL_LINE_MAX = 96;

/**
 * Why this line cannot go on the bill, or null. The printer knows plain letters only (its own code
 * page): Sinhala, Tamil and emoji would print as '?', so they are refused here, not on paper.
 */
export const checkBillLine = (text: unknown): string | null => {
  if (typeof text !== 'string') return 'write the line';
  if (text.length > BILL_LINE_MAX) return `keep it to ${BILL_LINE_MAX} letters`;
  if (!/^[\x20-\x7e]*$/.test(text)) return 'the printer prints English letters, numbers and signs only';
  return null;
};

/** The line the bill prints now ('' when none). */
export const billLineOf = (events: readonly SyncEvent[]): string => {
  let out = '';
  for (const e of events) if (e.type === 'shop.bill_line_set') out = e.text.trim();
  return out;
};

/**
 * How many minutes the kitchen took for this order, from Send to Done, for "MADE FRESH IN N MIN".
 * The order's slowest ticket sent in the 6 hours before `at`, rounded up to a whole minute; null
 * when the kitchen has not finished it yet (paid before it was made) or nothing went to it.
 */
export const madeInMinutes = (events: readonly SyncEvent[], orderNumber: number, at: number): number | null => {
  const mine = ticketTimes(events).filter((t) => t.orderNumber === orderNumber && t.sentAt <= at && t.sentAt > at - 6 * 60 * 60_000);
  if (!mine.length) return null;
  return Math.max(1, Math.ceil(Math.max(...mine.map((t) => t.minutes))));
};
