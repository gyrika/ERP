import { cookState, readySince, readyUrgency, type KitchenTicket, type Urgency } from '../domain/kitchen.ts';
import { unsentLines } from '../domain/order.ts';
import { platformLabel } from '../domain/platforms.ts';
import type { Order, PaidOrder } from '../domain/types.ts';

export type KitchenWord = 'Not sent' | 'More to send' | 'Waiting' | 'Cooking' | 'Ready' | 'Given';

/** One order on the list: how it stands with the kitchen, and with the money. */
export interface RailRow {
  order: Order;
  paid: boolean;
  kitchen: KitchenWord;
  /** Ready: how long it has waited ("Ready 6 min"), and how that looks (SCRUM-240). */
  ready?: { label: string; urgency: Urgency };
}

const COOK = { waiting: 'Waiting', cooking: 'Cooking', done: 'Ready' } as const;

/** Where an order is with the kitchen, in one word: made and waiting for the customer is Ready, handed over is Given. */
export const kitchenWord = (o: Order, tickets: KitchenTicket[]): KitchenWord => {
  if (o.givenAt !== undefined) return 'Given';
  if (o.held) return 'Not sent'; // paid first, Send not pressed yet
  if (unsentLines(o).length) return o.sentAt === undefined ? 'Not sent' : 'More to send';
  return COOK[cookState(tickets, o.number)];
};

/** "Ready 6 min" (or just "Ready" in its first minute, or once its Done is too old to know). */
export const readyFor = (o: Order, tickets: KitchenTicket[], now: number): RailRow['ready'] => {
  const since = readySince(tickets, o.number);
  const minutes = since === null ? 0 : Math.floor((now - since) / 60_000);
  return { label: minutes >= 1 ? `Ready ${minutes} min` : 'Ready', urgency: readyUrgency(since, now) };
};

/**
 * Every order still going (SCRUM-239), by number so a row never moves: the one on screen, every
 * order not paid (sent or not), and every order paid today that the customer does not have yet.
 * An order leaves once paid and given (SCRUM-240).
 */
export const railRows = (
  onScreen: Order, paidOnScreen: PaidOrder | null, open: Order[], paidToday: PaidOrder[], tickets: KitchenTicket[], now: number,
): RailRow[] => {
  const rows = new Map<number, RailRow>();
  const row = (order: Order, paid: boolean): RailRow => {
    const kitchen = kitchenWord(order, tickets);
    return { order, paid, kitchen, ...(kitchen === 'Ready' ? { ready: readyFor(order, tickets, now) } : {}) };
  };
  // Paid: listed until the customer has it (SCRUM-240).
  for (const p of paidToday) if (p.givenAt === undefined && !rows.has(p.number)) rows.set(p.number, row(p, true));
  for (const o of open) rows.set(o.number, row(o, false));
  if (!paidOnScreen && onScreen.lines.length) rows.set(onScreen.number, row(onScreen, false));
  return [...rows.values()].sort((a, b) => a.order.number - b.order.number);
};

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Where an order came from, when not the counter: a delivery app's code, or the website and its time. */
const fromWord = (o: Order): string | null => {
  if (o.platform) return platformLabel(o.platform);
  if (o.online) return `${o.online.delivery ? 'Delivery' : 'Online'} · ${clock(o.online.pickupBy)}`;
  return null;
};

/**
 * The left of the Register: + New order, then every order still going. A tap opens it on the
 * right while the menu stays. Colour is how long food has waited to be collected: amber, then red.
 * `selected`: the row manager mode's arrow keys are on.
 */
export function OrdersRail({ rows, current, selected, onNew, onOpen }: {
  rows: RailRow[];
  /** The number of the order on screen. */
  current: number | null;
  selected?: number | null;
  onNew: () => void;
  onOpen: (number: number) => void;
}) {
  // Sent and not paid: customers eating who still owe. The order being typed is not counted.
  const waiting = rows.filter((r) => !r.paid && r.order.sentAt !== undefined).length;
  return (
    <nav className="rail" aria-label="Orders">
      <button type="button" className="rail__new" onClick={onNew}>
        + New order <kbd>Esc</kbd>
      </button>
      {waiting > 0 && <p className="rail__count" aria-live="polite">{waiting} waiting to pay</p>}
      {rows.length === 0 && <p className="rail__none">Orders show here until they are made and paid.</p>}
      <ul className="rail__list">
        {rows.map((r, i) => {
          const wait = r.ready && r.ready.urgency !== 'ok' ? ` rail__row--${r.ready.urgency}` : '';
          const from = fromWord(r.order);
          return (
            <li key={r.order.number}>
              <button
                type="button"
                className={`rail__row${r.order.number === current ? ' rail__row--on' : ''}${wait}${selected === i ? ' rail__row--selected' : ''}`}
                aria-current={r.order.number === current || undefined}
                onClick={() => onOpen(r.order.number)}
              >
                <span className="rail__no num">{r.order.number}</span>
                <span className="rail__state">
                  <span className={r.ready ? 'rail__ready' : undefined}>{r.ready?.label ?? r.kitchen}</span>
                  <span className={r.paid ? 'rail__paid' : 'rail__unpaid'}>{r.paid ? 'Paid' : 'Not paid'}</span>
                  {r.order.customer?.name && <span className="rail__from">{r.order.customer.name}</span>}
                  {from && <span className="rail__from">{from}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
