import { itemById } from './menu.ts';
import type { PlatformMark } from './platforms.ts';
import type { SyncEvent } from './sync.ts';
import type { Category, OnlineMark, OrderLine } from './types.ts';
import { leaveOutsOf, lineItemName, secondHalf } from './halves.ts';

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
  /** Thrown away and being made again (the kitchen's Remake, SCRUM-177): how many times. */
  remade?: number;
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
  /** An online order: the customer comes to collect it by `pickupBy`. */
  online?: OnlineMark;
  /** A delivery app's order (SCRUM-195): its rider collects it; the code to match him by. */
  platform?: PlatformMark;
  /** A manager changed or cancelled something on it. */
  changed?: boolean;
  /** Last arrival or change. The ticket flashes until `seenAt` catches up. */
  alertAt: number;
  seenAt?: number;
  /** The cook tapped Start: from here to `doneAt` is the cooking time. */
  startedAt?: number;
  doneAt?: number;
  /**
   * A prep ticket (SCRUM-136): a semi-processed item to make, sent from low stock, not a
   * customer's order (number 0, no lines). Done is the batch made (inventory.ts).
   */
  prep?: { prepId: string; name: string; qty: number; unit: string };
}

export type NewTicket = Pick<KitchenTicket, 'id' | 'shopId' | 'number' | 'lines' | 'firedAt' | 'addOn' | 'online' | 'platform' | 'prep'>;

export type Urgency = 'ok' | 'warn' | 'bad';

/** How long each kind of item takes, from order to ready (the owner, 2026-10-12). */
export const COOK_MINUTES: Record<Category, number> = { pizza: 10, burger: 3, pasta: 20 };
/** Late = past the cook time; very late = past one and a half times it. */
export const VERY_LATE = 1.5;
/** Done tickets are kept this long so a mistaken "Done" can be undone, then dropped. */
export const KEEP_DONE_MS = 60 * 60_000;

/** A ticket should be ready after its slowest item (a cancelled line no longer counts). */
export const cookTimeMs = (t: Pick<KitchenTicket, 'lines'>): number => {
  const live = t.lines.filter((l) => !l.cancelled);
  return Math.max(0, ...live.map((l) => COOK_MINUTES[itemById(l.itemId).category])) * 60_000 || COOK_MINUTES.pizza * 60_000;
};

/** Amber once a ticket passes its cook time, red at one and a half times it. */
export const urgency = (elapsedMs: number, cookMs: number): Urgency =>
  elapsedMs >= cookMs * VERY_LATE ? 'bad' : elapsedMs >= cookMs ? 'warn' : 'ok';

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

/** Start also counts as seen. Starting twice keeps the first time. */
export const start = (tickets: KitchenTicket[], id: string, at: number): KitchenTicket[] =>
  tickets.map((t) => (t.id === id && t.startedAt === undefined ? { ...t, startedAt: at, seenAt: Math.max(at, t.alertAt) } : t));

export const unstart = (tickets: KitchenTicket[], id: string): KitchenTicket[] =>
  tickets.map((t) => {
    if (t.id !== id) return t;
    const { startedAt: _started, ...waiting } = t;
    return waiting;
  });

/** Done also counts as seen. */
export const bump = (tickets: KitchenTicket[], id: string, at: number): KitchenTicket[] =>
  tickets.map((t) => (t.id === id && t.doneAt === undefined ? { ...t, doneAt: at, seenAt: Math.max(at, t.alertAt) } : t));

export const unbump = (tickets: KitchenTicket[], id: string): KitchenTicket[] =>
  tickets.map((t) => {
    if (t.id !== id) return t;
    const { doneAt: _done, ...open } = t;
    return open;
  });

/** What to make next: open tickets, oldest first; customers' orders before prep. */
export const queue = (tickets: KitchenTicket[]): KitchenTicket[] =>
  tickets
    .filter((t) => t.doneAt === undefined)
    .sort((a, b) => Number(Boolean(a.prep)) - Number(Boolean(b.prep)) || a.firedAt - b.firedAt || a.number - b.number);

/**
 * Kitchen state of a sent order, for the register: waiting until the cook taps
 * Start, cooking once any of its open tickets is started, done once all are
 * bumped. (Done tickets are pruned after an hour, so "no open ticket" also means done.)
 */
export type CookState = 'waiting' | 'cooking' | 'done';
export const cookState = (tickets: KitchenTicket[], number: number): CookState => {
  const open = tickets.filter((t) => t.number === number && t.doneAt === undefined);
  if (open.length === 0) return 'done';
  return open.some((t) => t.startedAt !== undefined) ? 'cooking' : 'waiting';
};

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
  /** Remade this many times (SCRUM-177). */
  remade?: number;
}

const view = (l: OrderLine): LineView => {
  const item = itemById(l.itemId);
  const outs = leaveOutsOf(item, secondHalf(l));
  return {
    qty: l.qty,
    name: lineItemName(l),
    detail: [
      item.variants?.find((v) => v.id === l.size)?.label,
      ...l.adds.map((id) => item.adds.find((o) => o.id === id)?.label),
    ].filter(Boolean).join(' · '),
    outs: l.outs.map((id) => outs.find((o) => o.id === id)?.label ?? id),
    note: l.note,
  };
};

export const ticketLines = (t: KitchenTicket): TicketLine[] =>
  t.lines.map((l) => ({
    key: l.id,
    ...view(l),
    status: l.cancelled ? 'cancelled' : l.was ? 'changed' : 'ok',
    ...(l.was && !l.cancelled ? { was: view(l.was) } : {}),
    ...(l.remade ? { remade: l.remade } : {}),
  }));

/** Events older than this cannot hold a ticket worth showing; skipping them keeps the fold cheap. */
export const TICKET_HORIZON_MS = 24 * 60 * 60_000;

/**
 * The kitchen screen, built from events alone (docs/sync-contract.md): every
 * device folds the same events in the same order and gets the same tickets,
 * so nothing ever has to be merged. A manager Undo restores the line exactly
 * as the kitchen had it before the change it undoes.
 */
export const ticketsFromEvents = (events: readonly SyncEvent[], now: number): KitchenTicket[] =>
  prune(foldTickets(events.filter((e) => now - e.at <= TICKET_HORIZON_MS)), now);

/** A dish as the bin and the kitchen count it: item and size. */
export const dishKey = (itemId: string, size?: string): string => `${itemId}:${size ?? ''}`;

/**
 * Dishes the kitchen has made since `since` (SCRUM-183): lines on customers' tickets it
 * started or finished, cancelled lines left out. Pizzas are made to order, so only these exist.
 */
export const dishesMade = (events: readonly SyncEvent[], since: number): Map<string, number> => {
  const made = new Map<string, number>();
  for (const t of foldTickets(events.filter((e) => e.at >= since))) {
    if (t.prep || (t.startedAt === undefined && t.doneAt === undefined)) continue;
    for (const l of t.lines) if (!l.cancelled) made.set(dishKey(l.itemId, l.size), (made.get(dishKey(l.itemId, l.size)) ?? 0) + l.qty);
  }
  return made;
};

/** Every ticket the events describe, done or not, however old. */
const foldTickets = (events: readonly SyncEvent[]): KitchenTicket[] => {
  let t: KitchenTicket[] = [];
  const before = new Map<string, KitchenLine>(); // change event id → the kitchen's line before it
  const recalled = new Set<string>(); // prep tickets taken back
  const remakes = new Map<string, { ticketId: string; lineId: string }>(); // waste id → the line remade
  /** A line's remake count, up or down (an Undo). */
  const remake = (ticketId: string, lineId: string, by: number) => {
    t = t.map((x) => (x.id !== ticketId ? x : {
      ...x, lines: x.lines.map((l) => (l.id !== lineId ? l : { ...l, remade: Math.max(0, (l.remade ?? 0) + by) })),
    }));
  };
  for (const e of events) {
    switch (e.type) {
      case 'order.sent':
        t = fire(t, { id: e.ticketId, shopId: e.shopId, number: e.orderNumber, lines: e.lines, firedAt: e.at, addOn: e.addOn, ...(e.online ? { online: e.online } : {}), ...(e.platform ? { platform: e.platform } : {}) });
        break;
      case 'order.send_undone': t = recall(t, e.ticketId); break;
      // A batch held for what it is made from reaches the kitchen when it is released (production.ts).
      case 'prep.ordered':
        if (e.waitFor?.length) break;
        t = fire(t, { id: e.ticketId, shopId: e.shopId, number: 0, lines: [], firedAt: e.at, prep: { prepId: e.prepId, name: e.name, qty: e.qty, unit: e.unit } });
        break;
      case 'prep.released':
        // Once, and never for a batch taken back before it went.
        if (recalled.has(e.ticketId) || t.some((x) => x.id === e.ticketId)) break;
        t = fire(t, { id: e.ticketId, shopId: e.shopId, number: 0, lines: [], firedAt: e.at, prep: { prepId: e.prepId, name: e.name, qty: e.qty, unit: e.unit } });
        break;
      case 'prep.order_undone': recalled.add(e.ticketId); t = recall(t, e.ticketId); break;
      case 'order.item_changed':
      case 'order.item_cancelled': {
        const was = kitchenLine(t, e.lineId);
        if (!was) break; // not sent: the kitchen never saw it
        before.set(e.id, was);
        t = amendLine(t, e.lineId, e.type === 'order.item_changed' ? e.after : null, e.at);
        break;
      }
      case 'order.change_undone': {
        const was = before.get(e.undoneEventId);
        if (was) t = restoreLine(t, was, e.at);
        break;
      }
      case 'kitchen.seen': t = ack(t, e.ticketId, e.at); break;
      case 'kitchen.started': t = start(t, e.ticketId, e.at); break;
      case 'kitchen.unstarted': t = unstart(t, e.ticketId); break;
      case 'kitchen.bumped': t = bump(t, e.ticketId, e.at); break;
      case 'kitchen.unbumped': t = unbump(t, e.ticketId); break;
      // The kitchen's Remake (SCRUM-177): the line stays to make again, marked so.
      case 'stock.wasted':
        if (e.ticketId && e.lineId) { remakes.set(e.id, { ticketId: e.ticketId, lineId: e.lineId }); remake(e.ticketId, e.lineId, 1); }
        break;
      case 'stock.waste_undone': {
        const r = remakes.get(e.wasteId);
        if (r) { remakes.delete(e.wasteId); remake(r.ticketId, r.lineId, -1); }
        break;
      }
      default: break; // payments and price changes do not concern the kitchen
    }
  }
  return t;
};

/**
 * One cooked ticket, for later analysis (cook times per item, per hour, per cook load).
 * waitMs: sent → Start (queue time); cookMs: Start → Done; totalMs: sent → Done.
 * A ticket marked Done without Start has no start or cook time.
 */
export interface CookRecord {
  ticketId: string;
  orderNumber: number;
  sentAt: number;
  startedAt: number | null;
  doneAt: number;
  waitMs: number | null;
  cookMs: number | null;
  totalMs: number;
  /** What was cooked (cancelled lines left out), so times can be split by item and category. */
  items: { itemId: string; category: Category; size?: string; qty: number }[];
}

/**
 * Every finished ticket's cooking times, folded from the event log like the tickets
 * themselves, so Undo (unstarted / unbumped) and recalled sends are already applied.
 * Not limited to a day: pass the history to analyse.
 */
export const cookLog = (events: readonly SyncEvent[]): CookRecord[] =>
  foldTickets(events)
    .filter((t) => t.doneAt !== undefined && !t.prep)
    .map((t): CookRecord => {
      const doneAt = t.doneAt as number;
      const startedAt = t.startedAt !== undefined && t.startedAt <= doneAt ? t.startedAt : null;
      return {
        ticketId: t.id,
        orderNumber: t.number,
        sentAt: t.firedAt,
        startedAt,
        doneAt,
        waitMs: startedAt === null ? null : startedAt - t.firedAt,
        cookMs: startedAt === null ? null : doneAt - startedAt,
        totalMs: doneAt - t.firedAt,
        items: t.lines.filter((l) => !l.cancelled).map((l) => ({
          itemId: l.itemId, category: itemById(l.itemId).category, ...(l.size ? { size: l.size } : {}), qty: l.qty,
        })),
      };
    })
    .sort((a, b) => a.doneAt - b.doneAt);
