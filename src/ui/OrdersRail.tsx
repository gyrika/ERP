import { cookState, type KitchenTicket } from '../domain/kitchen.ts';
import { unsentLines } from '../domain/order.ts';
import { platformLabel } from '../domain/platforms.ts';
import type { Order, PaidOrder } from '../domain/types.ts';

/** One order on the list: how it stands with the kitchen, and with the money. */
export interface RailRow {
  order: Order;
  paid: boolean;
  kitchen: 'Not sent' | 'More to send' | 'Waiting' | 'Cooking' | 'Made';
}

const COOK = { waiting: 'Waiting', cooking: 'Cooking', done: 'Made' } as const;

/** Where an order is with the kitchen, in one word. */
export const kitchenWord = (o: Order, tickets: KitchenTicket[]): RailRow['kitchen'] => {
  if (o.held) return 'Not sent'; // paid first, Send not pressed yet
  if (unsentLines(o).length) return o.sentAt === undefined ? 'Not sent' : 'More to send';
  return COOK[cookState(tickets, o.number)];
};

/**
 * Every order still going (SCRUM-239), by number so a row never moves: the one on screen, every
 * order not paid (sent or not), and every order paid today that the kitchen has not made yet. A
 * made and paid order leaves by itself.
 */
export const railRows = (
  onScreen: Order, paidOnScreen: PaidOrder | null, open: Order[], paidToday: PaidOrder[], tickets: KitchenTicket[],
): RailRow[] => {
  const rows = new Map<number, RailRow>();
  for (const p of paidToday) {
    const kitchen = kitchenWord(p, tickets);
    if (kitchen !== 'Made' && !rows.has(p.number)) rows.set(p.number, { order: p, paid: true, kitchen });
  }
  for (const o of open) rows.set(o.number, { order: o, paid: false, kitchen: kitchenWord(o, tickets) });
  if (!paidOnScreen && onScreen.lines.length) rows.set(onScreen.number, { order: onScreen, paid: false, kitchen: kitchenWord(onScreen, tickets) });
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
 * right while the menu stays; made and not paid is the one in red (food out, money not in).
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
  return (
    <nav className="rail" aria-label="Orders">
      <button type="button" className="rail__new" onClick={onNew}>
        + New order <kbd>Esc</kbd>
      </button>
      {rows.length === 0 && <p className="rail__none">Orders show here until they are made and paid.</p>}
      <ul className="rail__list">
        {rows.map((r, i) => {
          const late = r.kitchen === 'Made' && !r.paid;
          const from = fromWord(r.order);
          return (
            <li key={r.order.number}>
              <button
                type="button"
                className={`rail__row${r.order.number === current ? ' rail__row--on' : ''}${late ? ' rail__row--late' : ''}${selected === i ? ' rail__row--selected' : ''}`}
                aria-current={r.order.number === current || undefined}
                onClick={() => onOpen(r.order.number)}
              >
                <span className="rail__no num">{r.order.number}</span>
                <span className="rail__state">
                  <span>{r.kitchen}</span>
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
