import { cookState, type KitchenTicket } from '../domain/kitchen.ts';
import { fmt } from '../domain/money.ts';
import { balanceDue, orderTotal } from '../domain/order.ts';
import type { PaidOrder } from '../domain/types.ts';
import { label } from './labels.ts';
import { COOK_LABEL, OnlineTag, TENDER, orderSummary } from './OrderPanel.tsx';
import type { RailRow } from './OrdersRail.tsx';

/**
 * The left of the counter: every bill of the day in sight, the way the old POS showed them.
 * Held bills first (every other bill still going: not paid, or paid and not yet given), then Paid
 * today, newest first. A tap opens the bill on the right; the one on screen is marked.
 * `paidToday` is empty for a cashier who does not see the takings.
 */
/** What today's paid bills come to, changes after paying included (SCRUM-247). */
export const salesToday = (paid: PaidOrder[]): number => paid.reduce((sum, o) => sum + o.total + (o.settled ?? 0), 0);

export function BillHistory({ held, paidToday, sales, tickets, kitchenOn, current, onOpen, onGive }: {
  held: RailRow[];
  paidToday: PaidOrder[];
  /** Today's takings in cents, shown to everyone at the counter. */
  sales: number;
  tickets: KitchenTicket[];
  /** The Kitchen view is on: held bills say how they stand with the kitchen. */
  kitchenOn: boolean;
  /** The bill on screen: its number, and its paid time when it is a paid bill. */
  current: { number: number; paidAt?: number };
  onOpen: (number: number) => void;
  /** The tick: the customer has taken the order. */
  onGive: (number: number) => void;
}) {
  return (
    <nav className="history" aria-label="Order history">
      <p className="history__sales"><span>Sales today</span> <b className="num">{fmt(sales)}</b></p>
      <section className="history__part">
        <h2 className="history__head">{label('heldBills')} · <span className="num">{held.filter((r) => r.kitchen !== 'Given').length}</span></h2>
        {held.length === 0 && <p className="history__none">{label('noHeld')}</p>}
        <ul className="history__list" aria-label={label('heldBills')}>
          {held.map((r) => {
            const done = r.kitchen === 'Given';
            const on = current.number === r.order.number && (current.paidAt === undefined || (r.paid && (r.order as PaidOrder).paidAt === current.paidAt));
            return (
            <li key={r.order.number} className={`history__held${done ? ' history__held--done' : ''}`}>
              <button type="button" className={`history__row${on ? ' history__row--on' : ''}${r.ready && r.ready.urgency !== 'ok' ? ` history__row--${r.ready.urgency}` : ''}`}
                aria-current={on || undefined} data-rail-order={r.order.number} onClick={() => onOpen(r.order.number)}>
                <span className="history__top">
                  <span className="history__no num">{r.order.number}</span>
                  <span className="history__total num">{fmt(orderTotal(r.order))}</span>
                </span>
                <span className="history__what">{r.order.customer?.name && <b>{r.order.customer.name} · </b>}{orderSummary(r.order.lines)}</span>
                <span className="history__meta">
                  {/* No Kitchen view: its words would mean nothing to the cashier; ticked: the tick says it. */}
                  {kitchenOn && !done && <span>{r.ready?.label ?? r.kitchen}</span>}
                  <span className={r.paid ? 'held__paid' : 'held__unpaid'}>{r.paid ? 'Paid' : 'Not paid'}</span>
                  {r.order.dineIn && <span>{label('dineIn')}</span>}
                  {r.order.delivery && <span>{label('delivery')}</span>}
                  <OnlineTag order={r.order} />
                </span>
              </button>
              {/* Inside the bill's box, on its left: tap when the customer takes it. A paid bill then leaves; an unpaid one stays, ticked, still owing. */}
              {(r.paid || r.order.sentAt !== undefined) && (
                <button type="button" className="history__tick" aria-label={`Order ${r.order.number} taken`} aria-pressed={done}
                  disabled={done} onClick={() => onGive(r.order.number)}>
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              )}
            </li>
            );
          })}
        </ul>
      </section>
      {paidToday.length > 0 && (
        <section className="history__part" aria-label="Paid today">
          <h2 className="history__head">Paid today · <span className="num">{paidToday.length}</span></h2>
          <ul className="history__list">
            {paidToday.map((o) => {
              const on = current.number === o.number && current.paidAt === o.paidAt;
              // No Kitchen view: nobody marks it made, so "Waiting" would never change.
              const cook = kitchenOn && o.sentAt !== undefined ? cookState(tickets, o.number) : 'done';
              return (
                <li key={`${o.number}-${o.paidAt}`}>
                  <button type="button" className={`history__row history__row--paid${on ? ' history__row--on' : ''}`}
                    aria-current={on || undefined} data-rail-order={o.number} onClick={() => onOpen(o.number)}>
                    <span className="history__top">
                      <span className="history__no num">{o.number}</span>
                      {/* Changed after paying (SCRUM-247): what it comes to now. */}
                      <span className="history__total num">{fmt(o.settled ? o.total + o.settled : o.total)}</span>
                    </span>
                    <span className="history__what">{orderSummary(o.lines)}</span>
                    <span className="history__meta">
                      {/* Paid, food still coming: the customer is still waiting, so the kitchen state stays. */}
                      {cook !== 'done' && <span className={`cookword cookword--${cook}`}>{COOK_LABEL[cook]}</span>}
                      <span className="cookword cookword--paid">Paid · {o.parts?.length ? 'Split' : TENDER[o.tender]}</span>
                      {o.settled ? <span className="cookword num">{o.settled < 0 ? `Gave back ${fmt(-o.settled)}` : `Paid ${fmt(o.settled)} more`}</span> : null}
                      {/* Changed after paying, money not yet taken or given (SCRUM-253). */}
                      {balanceDue(o) !== 0 && <span className="cookword cookword--due num">{balanceDue(o) > 0 ? `To pay ${fmt(balanceDue(o))}` : `To give back ${fmt(-balanceDue(o))}`}</span>}
                      <OnlineTag order={o} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </nav>
  );
}
