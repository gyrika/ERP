import { cookState, type KitchenTicket } from '../domain/kitchen.ts';
import { fmt } from '../domain/money.ts';
import { orderTotal } from '../domain/order.ts';
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
export function BillHistory({ held, paidToday, tickets, kitchenOn, current, onOpen }: {
  held: RailRow[];
  paidToday: PaidOrder[];
  tickets: KitchenTicket[];
  /** The Kitchen view is on: held bills say how they stand with the kitchen. */
  kitchenOn: boolean;
  /** The bill on screen: its number, and its paid time when it is a paid bill. */
  current: { number: number; paidAt?: number };
  onOpen: (number: number) => void;
}) {
  return (
    <nav className="history" aria-label="Order history">
      <section className="history__part">
        <h2 className="history__head">{label('heldBills')} · <span className="num">{held.length}</span></h2>
        {held.length === 0 && <p className="history__none">{label('noHeld')}</p>}
        <ul className="history__list" aria-label={label('heldBills')}>
          {held.map((r) => (
            <li key={r.order.number}>
              <button type="button" className={`history__row${r.ready && r.ready.urgency !== 'ok' ? ` history__row--${r.ready.urgency}` : ''}`}
                data-rail-order={r.order.number} onClick={() => onOpen(r.order.number)}>
                <span className="history__top">
                  <span className="history__no num">{r.order.number}</span>
                  <span className="history__total num">{fmt(orderTotal(r.order))}</span>
                </span>
                <span className="history__what">{r.order.customer?.name && <b>{r.order.customer.name} · </b>}{orderSummary(r.order.lines)}</span>
                <span className="history__meta">
                  {/* No Kitchen view: "Not sent" would mean nothing to the cashier. */}
                  {(kitchenOn || r.order.sentAt !== undefined) && <span>{r.ready?.label ?? r.kitchen}</span>}
                  <span className={r.paid ? 'held__paid' : 'held__unpaid'}>{r.paid ? 'Paid' : 'Not paid'}</span>
                  {r.order.dineIn && <span>{label('dineIn')}</span>}
                  <OnlineTag order={r.order} />
                </span>
              </button>
            </li>
          ))}
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
                      <span className="history__total num">{fmt(o.total)}</span>
                    </span>
                    <span className="history__what">{orderSummary(o.lines)}</span>
                    <span className="history__meta">
                      {/* Paid, food still coming: the customer is still waiting, so the kitchen state stays. */}
                      {cook !== 'done' && <span className={`cookword cookword--${cook}`}>{COOK_LABEL[cook]}</span>}
                      <span className="cookword cookword--paid">Paid · {o.parts?.length ? 'Split' : TENDER[o.tender]}</span>
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
