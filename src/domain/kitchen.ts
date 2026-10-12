import { itemById } from './menu.ts';
import type { OrderLine } from './types.ts';

/**
 * The kitchen works from the screen only: there is no printed kitchen ticket.
 * So every arrival, change and cancellation must be impossible to miss: the
 * ticket raises an alert (sound + flash) that stays until the kitchen taps it.
 */

/** A line as the kitchen sees it. A manager change keeps the old version so the cook sees both. */
export interface KitchenLine extends OrderLine {
  /** What this line was before the latest manager change. */
  was?: OrderLine;
  cancelled?: boolean;
}

/**
 * One trip to the kitchen. An order sends its first ticket before payment
 * (customers eat first); anything ordered later goes as an add-on ticket with
 * the same order number. Lines are a copy taken at sending.
 */
export interface KitchenTicket {
  id: string;
  shopId: string;
  number: number;
  lines: KitchenLine[];
  firedAt: number;
  /** A later round for an order the kitchen has already seen. */
  addOn?: boolean;
  /** A manager changed or cancelled something on it. */
  changed?: boolean;
  /** Last arrival or change. The ticket flashes until `seenAt` catches up. */
  alertAt: number;
  seenAt?: number;
  doneAt?: number;
}

export type NewTicket = Pick<KitchenTicket, 'id' | 'shopId' | 'number' | 'lines' | 'firedAt' | 'addOn'>;

export type Urgency = 'ok' | 'warn' | 'bad';

/** Placeholders until the owner supplies real cook times (see ARCHITECTURE.md). */
export const WARN_AFTER_MS = 10 * 60_000;
export const BAD_AFTER_MS = 15 * 60_000;
/** Done tickets are kept this long so a mistaken "Done" can be undone, then dropped. */
export const KEEP_DONE_MS = 60 * 60_000;

export const urgency = (elapsedMs: number): Urgency =>
  elapsedMs >= BAD_AFTER_MS ? 'bad' : elapsedMs >= WARN_AFTER_MS ? 'warn' : 'ok';

/** "04:07". Minutes keep counting past 59 rather than hiding a very late ticket. */
export const elapsedLabel = (elapsedMs: number): string => {
  const s = Math.max(0, Math.floor(elapsedMs / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** Adds a ticket, alerting the kitchen. Re-firing the same id replaces it (idempotent). */
export const fire = (tickets: KitchenTicket[], ticket: NewTicket): KitchenTicket[] => [
  ...tickets.filter((t) => t.id !== ticket.id),
  { ...ticket, lines: ticket.lines.map((l) => ({ ...l })), alertAt: ticket.firedAt },
];

/** Removes a ticket entirely, e.g. the cashier undid the send straight away. */
export const recall = (tickets: KitchenTicket[], id: string): KitchenTicket[] =>
  tickets.filter((t) => t.id !== id);

/**
 * A manager changed (`after`) or cancelled (`after` = null) a sent line.
 * The ticket holding it is reopened even if already done, marked Changed, and
 * alerts again: the screen is the kitchen's only channel.
 */
export const amendLine = (
  tickets: KitchenTicket[], lineId: string, after: OrderLine | null, at: number,
): KitchenTicket[] =>
  tickets.map((t) => {
    if (!t.lines.some((l) => l.id === lineId)) return t;
    const { doneAt: _done, ...open } = t;
    return {
      ...open,
      changed: true,
      alertAt: at,
      lines: t.lines.map((l): KitchenLine => {
        if (l.id !== lineId) return l;
        const { was: _was, cancelled: _cancelled, ...current } = l;
        return after ? { ...after, id: lineId, was: current } : { ...current, cancelled: true };
      }),
    };
  });

/** The kitchen's current view of a line (to restore it exactly on a manager Undo). */
export const kitchenLine = (tickets: KitchenTicket[], lineId: string): KitchenLine | undefined =>
  tickets.flatMap((t) => t.lines).find((l) => l.id === lineId);

/**
 * Manager Undo: put a line back exactly as the kitchen had it. The ticket
 * reopens and alerts again, because the cook last saw it changed or cancelled.
 */
export const restoreLine = (tickets: KitchenTicket[], line: KitchenLine, at: number): KitchenTicket[] =>
  tickets.map((t) => {
    if (!t.lines.some((l) => l.id === line.id)) return t;
    const { doneAt: _done, ...open } = t;
    return { ...open, changed: true, alertAt: at, lines: t.lines.map((l) => (l.id === line.id ? { ...line } : l)) };
  });

/** The kitchen tapped the ticket: stop flashing. */
export const ack = (tickets: KitchenTicket[], id: string, at: number): KitchenTicket[] =>
  tickets.map((t) => (t.id === id ? { ...t, seenAt: Math.max(at, t.alertAt) } : t));

export const needsAttention = (t: KitchenTicket): boolean => t.seenAt === undefined || t.seenAt < t.alertAt;

/** Done also counts as seen. */
export const bump = (tickets: KitchenTicket[], id: string, at: number): KitchenTicket[] =>
  tickets.map((t) => (t.id === id && t.doneAt === undefined ? { ...t, doneAt: at, seenAt: Math.max(at, t.alertAt) } : t));

export const unbump = (tickets: KitchenTicket[], id: string): KitchenTicket[] =>
  tickets.map((t) => {
    if (t.id !== id) return t;
    const { doneAt: _done, ...open } = t;
    return open;
  });

/** What to make next: open tickets, oldest first. */
export const queue = (tickets: KitchenTicket[]): KitchenTicket[] =>
  tickets
    .filter((t) => t.doneAt === undefined)
    .sort((a, b) => a.firedAt - b.firedAt || a.number - b.number);

/**
 * Kitchen state of a sent order, for the register: cooking while any of its
 * tickets is still on the kitchen screen, done once all are bumped. (Done
 * tickets are pruned after an hour, so "no open ticket" also means done.)
 */
export type CookState = 'cooking' | 'done';
export const cookState = (tickets: KitchenTicket[], number: number): CookState =>
  tickets.some((t) => t.number === number && t.doneAt === undefined) ? 'cooking' : 'done';

export const prune = (tickets: KitchenTicket[], now: number): KitchenTicket[] =>
  tickets.filter((t) => t.doneAt === undefined || now - t.doneAt < KEEP_DONE_MS);

export interface LineView {
  qty: number;
  name: string;
  /** Size and paid extras: "Large · Full cheese". */
  detail: string;
  /** Leave-outs are what cooks miss, so the screen shows them apart, in colour. */
  outs: string[];
  note?: string;
}

export interface TicketLine extends LineView {
  key: string;
  status: 'ok' | 'changed' | 'cancelled';
  /** For a changed line: the old version, shown struck through beside the new one. */
  was?: LineView;
}

const view = (l: OrderLine): LineView => {
  const item = itemById(l.itemId);
  return {
    qty: l.qty,
    name: item.name.en,
    detail: [
      item.variants?.find((v) => v.id === l.size)?.label,
      ...l.adds.map((id) => item.adds.find((o) => o.id === id)?.label),
    ].filter(Boolean).join(' · '),
    outs: l.outs.map((id) => item.leaveOut.find((o) => o.id === id)?.label ?? id),
    note: l.note,
  };
};

export const ticketLines = (t: KitchenTicket): TicketLine[] =>
  t.lines.map((l) => ({
    key: l.id,
    ...view(l),
    status: l.cancelled ? 'cancelled' : l.was ? 'changed' : 'ok',
    ...(l.was && !l.cancelled ? { was: view(l.was) } : {}),
  }));
