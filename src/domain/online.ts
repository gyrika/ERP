import { menuItems } from './menu.ts';
import { unitPrice } from './money.ts';
import type { Cents, LineSpec, MenuItem, SizeId } from './types.ts';

/**
 * Online orders (cheesybeez.com): order ahead, collect at the shop, pay there.
 * The customer's phone sends what they chose; the cloud checks it and prices it
 * with these rules (never trusting a price from the phone); the counter accepts
 * or declines it, and the customer's page follows its status.
 *
 * A customer's name and phone live only with the online order (so the shop can call
 * them and call out their order). The order in the Register is identified by its
 * number only, as every other order.
 */

/** What the customer chose, line by line: the same shape as a Register line. */
export type OnlineLine = Pick<LineSpec, 'itemId' | 'qty' | 'size' | 'adds' | 'outs'>;

/**
 * new → accepted → ready → collected, or new → declined.
 * `expired`: nobody answered within ONLINE_ANSWER_MS (the customer is told to call instead).
 */
export type OnlineStatus = 'new' | 'accepted' | 'declined' | 'ready' | 'collected' | 'expired';

export interface OnlineOrder {
  id: string;
  createdAt: number;
  status: OnlineStatus;
  name: string;
  phone: string;
  lines: OnlineLine[];
  note: string;
  total: Cents;
  /** The Register's number, once accepted: the customer says it at the counter. */
  orderNumber: number | null;
  /** Accepted with a time: "ready around 7:40". */
  readyBy: number | null;
  /** Why it was declined. */
  reason: string | null;
}

/** An unanswered order expires: the customer is told, rather than waiting for nothing. */
export const ONLINE_ANSWER_MS = 10 * 60_000;
/** The shop counts as taking orders while its server asked within this time. */
export const ONLINE_SEEN_MS = 2 * 60_000;
/** Minutes the counter can promise when accepting. */
export const READY_IN_MINUTES = [15, 20, 30, 45] as const;
export const DECLINE_REASONS = ['Too busy right now', 'Something on the order is sold out', 'Closing soon'] as const;

const LIMITS = { lines: 30, qty: 20, name: 40, note: 140 };

/**
 * A Sri Lankan phone number in its everyday form, 0XXXXXXXXX (mobiles 07…), or null.
 * Accepts spaces, dashes, +94 and 94 in front.
 */
export const normalisePhone = (input: string): string | null => {
  let d = input.replace(/[\s()-]/g, '');
  if (d.startsWith('+94')) d = `0${d.slice(3)}`;
  else if (d.startsWith('94') && d.length === 11) d = `0${d.slice(2)}`;
  else if (/^7\d{8}$/.test(d)) d = `0${d}`;
  return /^0\d{9}$/.test(d) ? d : null;
};

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** One line as the phone sent it, or why not. Unknown items, sizes or extras are refused, never guessed. */
const checkLine = (raw: unknown, items: readonly MenuItem[]): OnlineLine | string => {
  if (typeof raw !== 'object' || raw === null) return 'a line is not readable';
  const r = raw as Record<string, unknown>;
  const item = items.find((entry) => entry.id === r.itemId);
  if (!item || item.hidden) return 'something on the order is not on the menu';
  if (item.soldOut) return `sorry, ${item.name.en} is sold out today`;
  if (!Number.isSafeInteger(r.qty) || (r.qty as number) < 1 || (r.qty as number) > LIMITS.qty) return `at most ${LIMITS.qty} of one item`;
  if (item.variants) {
    if (!item.variants.some((v) => v.id === r.size)) return `choose a size for ${item.name.en}`;
  } else if (r.size !== undefined) return `${item.name.en} has no sizes`;
  const adds = r.adds ?? [];
  const outs = r.outs ?? [];
  if (!isStrings(adds) || !adds.every((id) => item.adds.some((o) => o.id === id))) return `an extra on ${item.name.en} is not offered`;
  if (!isStrings(outs) || !outs.every((id) => item.leaveOut.some((o) => o.id === id))) return `a choice on ${item.name.en} is not offered`;
  if (new Set(adds).size !== adds.length || new Set(outs).size !== outs.length) return 'an extra is twice on one line';
  return { itemId: item.id, qty: r.qty as number, ...(item.variants ? { size: r.size as SizeId } : {}), adds, outs };
};

export const onlineLineTotal = (l: OnlineLine, items: readonly MenuItem[] = menuItems()): Cents => {
  const item = items.find((entry) => entry.id === l.itemId);
  return item ? unitPrice(item, l) * l.qty : 0;
};
export const onlineTotal = (lines: OnlineLine[], items: readonly MenuItem[] = menuItems()): Cents =>
  lines.reduce((sum, line) => sum + onlineLineTotal(line, items), 0);

export interface CheckedOnlineOrder { name: string; phone: string; lines: OnlineLine[]; note: string; total: Cents }

/** What the phone sent, checked and priced here, or the reason it cannot be taken (shown to the customer). */
export const checkOnlineOrder = (body: unknown, items: readonly MenuItem[] = menuItems()): CheckedOnlineOrder | { reason: string } => {
  if (typeof body !== 'object' || body === null) return { reason: 'the order is not readable' };
  const b = body as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim().replace(/\s+/g, ' ') : '';
  if (!name) return { reason: 'type your name' };
  if (name.length > LIMITS.name) return { reason: 'a shorter name, please' };
  const phone = typeof b.phone === 'string' ? normalisePhone(b.phone) : null;
  if (!phone) return { reason: 'type your phone number, like 077 123 4567' };
  const note = typeof b.note === 'string' ? b.note.trim() : '';
  if (note.length > LIMITS.note) return { reason: `a note of at most ${LIMITS.note} letters` };
  if (!Array.isArray(b.lines) || !b.lines.length) return { reason: 'the order is empty' };
  if (b.lines.length > LIMITS.lines) return { reason: 'that is a big order: please call the shop' };
  const lines: OnlineLine[] = [];
  for (const raw of b.lines) {
    const l = checkLine(raw, items);
    if (typeof l === 'string') return { reason: l };
    lines.push(l);
  }
  return { name, phone, lines, note, total: onlineTotal(lines, items) };
};

/** The status the customer sees: an unanswered order runs out after ONLINE_ANSWER_MS. */
export const effectiveStatus = (o: Pick<OnlineOrder, 'status' | 'createdAt'>, now: number): OnlineStatus =>
  o.status === 'new' && now - o.createdAt > ONLINE_ANSWER_MS ? 'expired' : o.status;

/** Which changes the counter may make, from which status. */
export const NEXT_STATUS: Record<OnlineStatus, OnlineStatus[]> = {
  new: ['accepted', 'declined'],
  accepted: ['ready', 'collected'],
  ready: ['collected'],
  declined: [], collected: [], expired: [],
};

/** The shop takes online orders: switched on at the counter, and its server was heard from lately. */
export const takingOrders = (shop: { open: boolean; seenAt: number | null }, now: number): boolean =>
  shop.open && shop.seenAt !== null && now - shop.seenAt < ONLINE_SEEN_MS;
