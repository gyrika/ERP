import { menuItems } from './menu.ts';
import { unitPrice } from './money.ts';
import type { Cents, LineSpec, MenuItem, SizeId } from './types.ts';

/**
 * Online orders (cheesybeez.com): order ahead, then collect at the shop and pay there,
 * or have the shop's rider bring it and pay the rider in cash (delivery, SCRUM-193).
 * The customer's phone sends what they chose; the cloud checks it and prices it
 * with these rules (never trusting a price from the phone); the counter accepts
 * or declines it, and the customer's page follows its status.
 *
 * A customer's name, phone and delivery address live only with the online order (so the
 * shop can call them, call out their order, and find their door). The order in the Register is identified by its
 * number only, as every other order.
 */

/** What the customer chose, line by line: the same shape as a Register line. */
export type OnlineLine = Pick<LineSpec, 'itemId' | 'qty' | 'size' | 'adds' | 'outs'>;

/**
 * Pickup: new → accepted → ready → collected. Delivery: new → accepted → ready → out → delivered.
 * Either can be new → declined.
 * `expired`: nobody answered within ONLINE_ANSWER_MS (the customer is told to call instead).
 */
export type OnlineStatus = 'new' | 'accepted' | 'declined' | 'ready' | 'collected' | 'out' | 'delivered' | 'expired';

export type OnlineKind = 'pickup' | 'delivery';
/** Where the customer's phone said it was, when they shared it: a Maps link for the rider. */
export interface DeliveryPin { lat: number; lng: number }

export interface OnlineOrder {
  id: string;
  createdAt: number;
  status: OnlineStatus;
  kind: OnlineKind;
  name: string;
  phone: string;
  /** Delivery only: where to take it, as the customer typed it, and their shared location if any. */
  address: string | null;
  pin: DeliveryPin | null;
  lines: OnlineLine[];
  note: string;
  /** Delivery only (0 for pickup); already in `total`. */
  deliveryFee: Cents;
  /** The items plus the delivery fee: what the customer pays. */
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
/** A delivery also needs the ride, so its choices start later. */
export const DELIVER_IN_MINUTES = [30, 45, 60, 90] as const;
export const DECLINE_REASONS = ['Too busy right now', 'Something on the order is sold out', 'Closing soon'] as const;
export const DELIVERY_DECLINE_REASONS = ['Too far to deliver', 'No rider right now', ...DECLINE_REASONS] as const;
/** A delivery still out after this long is worth a look (the owner's Today). */
export const OUT_TOO_LONG_MS = 60 * 60_000;

const LIMITS = { lines: 30, qty: 20, name: 40, note: 140, address: 200 };

/**
 * The cloud's DELIVERY_FEE setting, in whole rupees as the owner says it ("250") → cents, or null
 * when unset or not understood: then the shop does not deliver. "0" is free delivery.
 */
export const parseDeliveryFee = (text: string | undefined): Cents | null => {
  const t = (text ?? '').trim();
  if (!/^\d{1,4}$/.test(t)) return null;
  return Number(t) * 100;
};

/** A Maps link that opens the rider's navigation at the customer's shared location. */
export const pinLink = (pin: DeliveryPin): string => `https://www.google.com/maps/search/?api=1&query=${pin.lat},${pin.lng}`;

const checkPin = (raw: unknown): DeliveryPin | null | string => {
  if (raw === undefined || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const ok = (v: unknown, max: number) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max;
  if (typeof raw !== 'object' || !ok(r.lat, 90) || !ok(r.lng, 180)) return 'your location is not readable: type the address instead';
  // About 1 m is plenty for a rider, and keeps no more than that.
  const round = (v: number) => Math.round(v * 1e5) / 1e5;
  return { lat: round(r.lat as number), lng: round(r.lng as number) };
};

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
  const item = items.find((m) => m.id === r.itemId);
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

/** `items`: the shop's menu with its owner's changes (the cloud builds it per shop). */
export const onlineLineTotal = (l: OnlineLine, items: readonly MenuItem[] = menuItems()): Cents => {
  const item = items.find((m) => m.id === l.itemId);
  return item ? unitPrice(item, l) * l.qty : 0;
};
export const onlineTotal = (lines: OnlineLine[], items: readonly MenuItem[] = menuItems()): Cents =>
  lines.reduce((s, l) => s + onlineLineTotal(l, items), 0);

export interface CheckedOnlineOrder {
  kind: OnlineKind; name: string; phone: string; address: string | null; pin: DeliveryPin | null;
  lines: OnlineLine[]; note: string; deliveryFee: Cents; total: Cents;
}

/**
 * What the phone sent, checked and priced here, or the reason it cannot be taken (shown to the customer).
 * `deliveryFee`: the shop's fee (parseDeliveryFee), or null when it does not deliver. The fee always comes
 * from here, never from the phone.
 */
export const checkOnlineOrder = (
  body: unknown, items: readonly MenuItem[] = menuItems(), deliveryFee: Cents | null = null,
): CheckedOnlineOrder | { reason: string } => {
  if (typeof body !== 'object' || body === null) return { reason: 'the order is not readable' };
  const b = body as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim().replace(/\s+/g, ' ') : '';
  if (!name) return { reason: 'type your name' };
  if (name.length > LIMITS.name) return { reason: 'a shorter name, please' };
  const phone = typeof b.phone === 'string' ? normalisePhone(b.phone) : null;
  if (!phone) return { reason: 'type your phone number, like 077 123 4567' };
  const note = typeof b.note === 'string' ? b.note.trim() : '';
  if (note.length > LIMITS.note) return { reason: `a note of at most ${LIMITS.note} letters` };
  const kind: OnlineKind = b.kind === 'delivery' ? 'delivery' : 'pickup';
  let address: string | null = null;
  let pin: DeliveryPin | null = null;
  if (kind === 'delivery') {
    if (deliveryFee === null) return { reason: 'the shop is not delivering right now: choose pickup' };
    address = typeof b.address === 'string' ? b.address.trim().replace(/\s+/g, ' ') : '';
    if (!address) return { reason: 'type your address' };
    if (address.length > LIMITS.address) return { reason: `an address of at most ${LIMITS.address} letters` };
    const p = checkPin(b.pin);
    if (typeof p === 'string') return { reason: p };
    pin = p;
  }
  if (!Array.isArray(b.lines) || !b.lines.length) return { reason: 'the order is empty' };
  if (b.lines.length > LIMITS.lines) return { reason: 'that is a big order: please call the shop' };
  const lines: OnlineLine[] = [];
  for (const raw of b.lines) {
    const l = checkLine(raw, items);
    if (typeof l === 'string') return { reason: l };
    lines.push(l);
  }
  const fee = kind === 'delivery' ? deliveryFee! : 0;
  return { kind, name, phone, address, pin, lines, note, deliveryFee: fee, total: onlineTotal(lines, items) + fee };
};

/** The status the customer sees: an unanswered order runs out after ONLINE_ANSWER_MS. */
export const effectiveStatus = (o: Pick<OnlineOrder, 'status' | 'createdAt'>, now: number): OnlineStatus =>
  o.status === 'new' && now - o.createdAt > ONLINE_ANSWER_MS ? 'expired' : o.status;

/**
 * Which changes the counter may make, from which status (canBecome adds the kind). A payment
 * closes the order from wherever it is: collected for pickup, delivered for delivery.
 */
export const NEXT_STATUS: Record<OnlineStatus, OnlineStatus[]> = {
  new: ['accepted', 'declined'],
  accepted: ['ready', 'collected', 'out', 'delivered'],
  ready: ['collected', 'out', 'delivered'],
  out: ['delivered'],
  declined: [], collected: [], delivered: [], expired: [],
};

const DELIVERY_ONLY: OnlineStatus[] = ['out', 'delivered'];

/** Pickup orders are collected; delivery orders go out and are delivered. */
export const canBecome = (kind: OnlineKind, from: OnlineStatus, to: OnlineStatus): boolean =>
  NEXT_STATUS[from].includes(to) && (kind === 'delivery' ? to !== 'collected' : !DELIVERY_ONLY.includes(to));

/** The status a payment moves an online order to. */
export const paidStatus = (kind: OnlineKind): OnlineStatus => (kind === 'delivery' ? 'delivered' : 'collected');

/** Still in play at the counter (shown, polled). */
export const IN_PLAY: OnlineStatus[] = ['new', 'accepted', 'ready', 'out'];

/** The shop takes online orders: switched on at the counter, and its server was heard from lately. */
export const takingOrders = (shop: { open: boolean; seenAt: number | null }, now: number): boolean =>
  shop.open && shop.seenAt !== null && now - shop.seenAt < ONLINE_SEEN_MS;

// ----- Opening hours, for the ordering page's status pill -----

/** The shop's daily hours as minutes after midnight in Sri Lanka; `closes` may be past midnight (closes < opens). */
export interface OpeningHours { opens: number; closes: number }

/** "11:00-21:00" (the cloud's ORDER_HOURS setting) → hours, or null when unset or not understood. */
export const parseHours = (text: string | undefined): OpeningHours | null => {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(text ?? '');
  if (!m) return null;
  const [oh, om, ch, cm] = m.slice(1).map(Number);
  if (oh > 23 || ch > 23 || om > 59 || cm > 59) return null;
  const opens = oh * 60 + om;
  const closes = ch * 60 + cm;
  return opens === closes ? null : { opens, closes };
};

const COLOMBO_MS = 5.5 * 60 * 60_000; // Sri Lanka: UTC+5:30, no summer time
const minuteInColombo = (now: number) => Math.floor(((now + COLOMBO_MS) % 86_400_000) / 60_000);

/** 660 → "11 AM", 1290 → "9:30 PM". */
export const clockText = (minute: number): string => {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
};

/**
 * The pill's words. Open or closed is the shop's own switch (the server's answer); the hours only
 * add when that changes. Inside the hours but switched off, it says closed without promising a time.
 */
export const statusText = (open: boolean, hours: OpeningHours | null, now: number, delivers = false): string => {
  if (!hours) return open ? (delivers ? 'Open for pickup and delivery' : 'Open for pickup') : 'Closed';
  if (open) return `Open · Closes ${clockText(hours.closes)}`;
  const m = minuteInColombo(now);
  const inside = hours.opens < hours.closes ? m >= hours.opens && m < hours.closes : m >= hours.opens || m < hours.closes;
  return inside ? 'Closed for now' : `Closed · Opens ${clockText(hours.opens)}`;
};
