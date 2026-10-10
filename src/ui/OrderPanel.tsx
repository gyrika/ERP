import { itemById } from '../domain/menu.ts';
import { fmt, lineTotal } from '../domain/money.ts';
import { orderTotal, unsentLines } from '../domain/order.ts';
import type { Actor } from '../domain/auth.ts';
import { cookState, type KitchenTicket } from '../domain/kitchen.ts';
import type { Order, OrderLine, PaidOrder } from '../domain/types.ts';

const sub = (l: OrderLine): string => {
  const item = itemById(l.itemId);
  return [
    item.variants?.find((v) => v.id === l.size)?.label,
    ...l.adds.map((id) => item.adds.find((o) => o.id === id)?.label),
    ...l.outs.map((id) => item.leaveOut.find((o) => o.id === id)?.label),
    l.note,
  ].filter(Boolean).join(' · ');
};

const itemCount = (o: Order): number => o.lines.reduce((n, l) => n + l.qty, 0);
const items = (o: Order): string => `${itemCount(o)} ${itemCount(o) === 1 ? 'item' : 'items'}`;
const TENDER = { cash: 'Cash', card: 'Card', qr: 'QR' } as const;

function Cook({ tickets, number }: { tickets: KitchenTicket[]; number: number }) {
  return cookState(tickets, number) === 'cooking'
    ? <span className="status status--cooking">Cooking</span>
    : <span className="status status--done">Done</span>;
}

interface Props {
  order: Order;
  /** Sent to the kitchen, waiting to pay. */
  open: Order[];
  /** Paid today, newest first. Read-only: nothing left to do on them. */
  paidToday: PaidOrder[];
  /** Live kitchen tickets, to show Cooking / Done beside Paid / Unpaid. */
  tickets: KitchenTicket[];
  paid: PaidOrder | null;
  onEdit: (line: OrderLine) => void;
  /** Set while a manager has unlocked this order: sent lines become editable. */
  manager: Actor | null;
  onAskManager: () => void;
  onExitManager: () => void;
  onSend: () => void;
  onCharge: () => void;
  onOpen: (number: number) => void;
  onNext: () => void;
  onUndo: () => void;
}

/**
 * The bill. One primary action at a time: "Send to kitchen" while there are
 * new items, "Charge" once everything is sent (customers eat first, pay after).
 */
export function OrderPanel({
  order, open, paidToday, tickets, paid, manager, onEdit, onAskManager, onExitManager, onSend, onCharge, onOpen, onNext, onUndo,
}: Props) {
  if (paid) {
    const cashChange = paid.tender === 'cash' && paid.change > 0;
    return (
      <aside className="panel" aria-label="Current order">
        <div className="panel__no num">{paid.number}</div>
        <div className="paid" role="status">
          <span className="paid__label">{cashChange ? 'Change' : 'Paid'}</span>
          <span className="paid__big num">{fmt(cashChange ? paid.change : paid.total)}</span>
          <span className="paid__sub num">
            {paid.tender === 'cash' ? `Cash ${fmt(paid.tendered)} · ` : `${paid.tender === 'qr' ? 'QR' : 'Card'} · `}
            Total {fmt(paid.total)}
          </span>
          <button type="button" className="linkbtn" onClick={onUndo}>Undo payment</button>
        </div>
        <div className="panel__foot">
          <button type="button" className="cta" autoFocus onClick={onNext}>Next order</button>
        </div>
      </aside>
    );
  }

  const total = orderTotal(order);
  const hasNew = unsentLines(order).length > 0;
  const isOpen = order.sentAt !== undefined; // already in the kitchen, being added to or charged
  const hasSent = order.lines.some((l) => l.sent);

  return (
    <aside className="panel" aria-label="Current order">
      {manager ? (
        <div className="panel__no panel__no--manager" role="status">
          <span>{manager.name} · tap a sent item to change or cancel</span>
          <button type="button" className="panel__back" onClick={onExitManager}>Exit</button>
        </div>
      ) : (
        <div className="panel__no num">
          <span>
            {order.number}
            {isOpen && <Cook tickets={tickets} number={order.number} />}
            {isOpen && <span className="status status--unpaid">Unpaid</span>}
          </span>
          <span className="panel__keys">
            {hasSent && <button type="button" className="panel__back" onClick={onAskManager}>Ask manager</button>}
            {isOpen && !hasNew && <button type="button" className="panel__back" onClick={onNext}>New order</button>}
          </span>
        </div>
      )}
      <div className="panel__lines">
        {order.lines.length === 0 && open.length === 0 && paidToday.length === 0 && (
          <div className="empty">
            <b>Tap a size to start</b>
            <span>or just start typing: “2 L margherita, burger”</span>
          </div>
        )}
        {order.lines.map((l) => {
          const item = itemById(l.itemId);
          const body = (
            <>
              <span className="line__main">
                <span className="line__name">{l.qty > 1 ? `${l.qty} × ` : ''}{item.name.en}</span>
                {sub(l) && <span className="line__sub">{sub(l)}</span>}
              </span>
              <span className="line__price num">{fmt(lineTotal(item, l))}</span>
            </>
          );
          // Sent lines are locked (the kitchen may be cooking them) unless a manager unlocked the order.
          return l.sent && !manager
            ? <div key={l.id} className="line line--sent">{body}</div>
            : <button key={l.id} type="button" className="line" onClick={() => onEdit(l)}>{body}</button>;
        })}

        {order.lines.length === 0 && open.length > 0 && (
          <section className="waiting" aria-label="Waiting to pay">
            <h2>Waiting to pay · {open.length}</h2>
            {open.map((o) => (
              <button key={o.number} type="button" className="waiting__row" onClick={() => onOpen(o.number)}>
                <span className="waiting__no num">{o.number}</span>
                <span className="waiting__total num">{fmt(orderTotal(o))}</span>
                <span className="waiting__meta">
                  <span className="waiting__items">{items(o)}</span>
                  <Cook tickets={tickets} number={o.number} />
                  <span className="status status--unpaid">Unpaid</span>
                </span>
              </button>
            ))}
          </section>
        )}

        {order.lines.length === 0 && paidToday.length > 0 && (
          <section className="waiting waiting--paid" aria-label="Paid today">
            <h2>Paid today · {paidToday.length}</h2>
            {paidToday.map((o) => (
              <div key={o.number} className="waiting__row">
                <span className="waiting__no num">{o.number}</span>
                <span className="waiting__total num">{fmt(o.total)}</span>
                <span className="waiting__meta">
                  <span className="waiting__items">{items(o)}</span>
                  <Cook tickets={tickets} number={o.number} />
                  <span className="status status--paid">Paid · {TENDER[o.tender]}</span>
                </span>
              </div>
            ))}
          </section>
        )}
      </div>
      <div className="panel__foot">
        <span className="total num">{fmt(total)}</span>
        {hasNew || !isOpen
          ? <button type="button" className="cta" disabled={!hasNew} onClick={onSend}>Send to kitchen</button>
          : <button type="button" className="cta" onClick={onCharge}>Charge</button>}
      </div>
    </aside>
  );
}
