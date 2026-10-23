import { useState } from 'react';
import { NumberInput } from './NumberInput.tsx';
import type { Actor } from '../domain/auth.ts';
import { cookState, type KitchenTicket } from '../domain/kitchen.ts';
import { DISCOUNT_CHIPS } from '../domain/manager.ts';
import { itemById } from '../domain/menu.ts';
import { fmt } from '../domain/money.ts';
import { orderTotal, unsentLines } from '../domain/order.ts';
import { discountLabel, lineAdjustment, lineNet, totals } from '../domain/totals.ts';
import type { Cents, Discount, Order, OrderLine, PaidOrder } from '../domain/types.ts';
import { leaveOutsOf, lineItemName, secondHalf } from '../domain/halves.ts';

const sub = (l: OrderLine): string => {
  const item = itemById(l.itemId);
  const outs = leaveOutsOf(item, secondHalf(l));
  return [
    item.variants?.find((v) => v.id === l.size)?.label,
    ...l.adds.map((id) => item.adds.find((o) => o.id === id)?.label),
    ...l.outs.map((id) => outs.find((o) => o.id === id)?.label),
    l.note,
  ].filter(Boolean).join(' · ');
};

const itemCount = (o: Order): number => o.lines.reduce((n, l) => n + l.qty, 0);
const items = (o: Order): string => `${itemCount(o)} ${itemCount(o) === 1 ? 'item' : 'items'}`;
const TENDER = { cash: 'Cash', transfer: 'Bank transfer', card: 'Card', qr: 'QR', comp: 'Free' } as const;
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Void reasons for a sent line (owner rule: a reason is required). Keys 1-3 pick them. */
export const VOID_REASONS = ['Customer changed mind', 'Wrong item entered', 'Out of stock'];

/** "150" or "150.50" rupees -> cents, without floating point. null if not a valid amount. */
export const parseRupees = (raw: string): Cents | null => {
  const m = /^\s*(\d{1,6})(?:\.(\d{1,2}))?\s*$/.exec(raw);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
};

/** An order from cheesybeez.com, and when the customer comes for it. */
function OnlineTag({ order, time = true }: { order: Order; time?: boolean }) {
  return order.online
    ? <span className="status status--online" title="Ordered on cheesybeez.com">Online{time && ` · ${clock(order.online.pickupBy)}`}</span>
    : null;
}

const COOK_LABEL = { waiting: 'Waiting', cooking: 'Cooking', done: 'Done' } as const;

function Cook({ tickets, number }: { tickets: KitchenTicket[]; number: number }) {
  const state = cookState(tickets, number);
  return <span className={`status status--${state === 'waiting' ? 'queued' : state}`}>{COOK_LABEL[state]}</span>;
}

/** Manager mode state and actions, owned by App (which also maps the keys). */
export interface ManagePanel {
  actor: Actor;
  /** Selected line index, or selected waiting order when no order is on screen. */
  selected: number;
  pendingVoid: string | null;
  adjusting: string | null;
  onSelect: (index: number) => void;
  onEditLine: (line: OrderLine) => void;
  onAskVoid: (line: OrderLine) => void;
  onVoid: (lineId: string, reason: string) => void;
  onAskAdjust: (line: OrderLine) => void;
  onAdjust: (lineId: string, cents: Cents) => void;
  onDiscount: (discount: Discount | null) => void;
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
  /** Present while manager mode is on. */
  manage: ManagePanel | null;
  onEdit: (line: OrderLine) => void;
  onSend: () => void;
  onCharge: () => void;
  onCloseFree: () => void;
  onOpen: (number: number) => void;
  onNext: () => void;
  onUndo: () => void;
  /** The receipt of the paid order on screen; null when this device does not print. */
  printState?: 'printing' | 'printed' | 'failed' | null;
  /** Prints a COPY, without opening the drawer. Absent when this device does not print. */
  onReprint?: () => void;
}

function VoidReasons({ lineId, onVoid }: { lineId: string; onVoid: ManagePanel['onVoid'] }) {
  const [other, setOther] = useState<string | null>(null);
  return (
    <div className="inline" role="group" aria-label="Why void this item?">
      <span className="inline__label">Why void it?</span>
      <div className="chips chips--tight">
        {VOID_REASONS.map((r, i) => (
          <button key={r} type="button" className="chip chip--solid" onClick={() => onVoid(lineId, r)}>
            <kbd>{i + 1}</kbd>{r}
          </button>
        ))}
        <button type="button" className="chip" aria-pressed={other !== null} onClick={() => setOther('')}>Other</button>
      </div>
      {other !== null && (
        <input
          className="note"
          value={other}
          onChange={(e) => setOther(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && other.trim()) onVoid(lineId, other.trim()); }}
          placeholder="Short reason, then Enter"
          aria-label="Other reason"
          maxLength={80}
          autoFocus
        />
      )}
    </div>
  );
}

function AdjustField({ line, order, onAdjust }: { line: OrderLine; order: Order; onAdjust: ManagePanel['onAdjust'] }) {
  const current = lineAdjustment(order, line);
  const [raw, setRaw] = useState(current ? String(current / 100) : '');
  const cents = parseRupees(raw);
  // Taking it off again is its own button, never "type 0" (SCRUM-137).
  return (
    <div className="inline">
      <label className="inline__label" htmlFor={`adj-${line.id}`}>Take off this line</label>
      <NumberInput
        id={`adj-${line.id}`}
        className="note"
        decimals={2}
        unit="Rs"
        value={raw}
        onText={setRaw}
        onKeyDown={(e) => { if (e.key === 'Enter' && cents !== null && cents > 0) onAdjust(line.id, cents); }}
        placeholder="e.g. 150, then Enter"
        aria-invalid={raw !== '' && !(cents !== null && cents > 0)}
        autoFocus
      />
      {current > 0 && <button type="button" className="linkbtn" onClick={() => onAdjust(line.id, 0)}>Remove the Rs {fmt(current)} off</button>}
    </div>
  );
}

/**
 * The bill. Cashier mode: one primary action at a time ("Send to kitchen",
 * then "Charge"). Manager mode: the same card lifted, every line selectable
 * and changeable, discount chips under the order. No dialogs, no banners.
 */
export function OrderPanel({
  order, open, paidToday, tickets, paid, manage, onEdit, onSend, onCharge, onCloseFree, onOpen, onNext, onUndo, printState, onReprint,
}: Props) {
  const panelClass = `panel${manage ? ' panel--managing' : ''}`;

  if (paid) {
    const cashChange = paid.tender === 'cash' && paid.change > 0;
    return (
      <aside className={panelClass} aria-label="Current order">
        <div className="panel__no num"><span>{paid.number}<OnlineTag order={paid} time={false} /></span></div>
        <div className="paid" role="status">
          <span className="paid__label">{cashChange ? 'Change' : paid.tender === 'comp' ? 'Closed · Free' : 'Paid'}</span>
          <span className="paid__big num">{fmt(cashChange ? paid.change : paid.total)}</span>
          <span className="paid__sub num">
            {paid.tender === 'cash' ? `Cash ${fmt(paid.tendered)} · ` : `${TENDER[paid.tender]} · `}
            Total {fmt(paid.total)}
          </span>
          <span className="paid__links">
            <button type="button" className="linkbtn" onClick={onUndo}>Undo payment</button>
            {onReprint && <button type="button" className="linkbtn" onClick={onReprint}>Print again</button>}
          </span>
          {printState === 'failed' && <span className="paid__note">Receipt not printed</span>}
        </div>
        <div className="panel__foot">
          <button type="button" className="cta" autoFocus onClick={onNext}>Next order</button>
        </div>
      </aside>
    );
  }

  const t = totals(order);
  const total = orderTotal(order);
  const hasNew = unsentLines(order).length > 0;
  const isOpen = order.sentAt !== undefined; // already in the kitchen, being added to or charged
  const discount = order.adjust?.discount;
  const comped = discount?.kind === 'comp';
  const listing = order.lines.length === 0;

  return (
    <aside className={panelClass} aria-label="Current order">
      <div className="panel__no num">
        <span>
          {order.number}
          <OnlineTag order={order} time={false} />
          {isOpen && <Cook tickets={tickets} number={order.number} />}
          {isOpen && <span className="status status--unpaid">Unpaid</span>}
        </span>
        {!manage && isOpen && !hasNew && (
          <button type="button" className="panel__back" onClick={onNext}>New order</button>
        )}
      </div>
      {order.edited && (
        <div className="panel__stamp num">Edited by {order.edited.by}, {clock(order.edited.at)}</div>
      )}

      <div className="panel__lines">
        {listing && open.length === 0 && paidToday.length === 0 && (
          <div className="empty">
            <b>Tap a size to start</b>
            <span>or just start typing: “2 L margherita, burger”</span>
          </div>
        )}

        {order.lines.map((l, i) => {
          const adj = lineAdjustment(order, l);
          const body = (
            <>
              <span className="line__main">
                <span className="line__name">{l.qty > 1 ? `${l.qty} × ` : ''}{lineItemName(l)}</span>
                {sub(l) && <span className="line__sub">{sub(l)}</span>}
                {adj > 0 && <span className="line__adj num">−{fmt(adj)} off this line</span>}
              </span>
              <span className="line__price num">{fmt(lineNet(order, l))}</span>
            </>
          );
          if (manage) {
            const selected = manage.selected === i;
            return (
              <div key={l.id} className={`mline${selected ? ' mline--selected' : ''}`}>
                <button
                  type="button"
                  className={`line${l.sent ? ' line--sent' : ''}`}
                  aria-current={selected || undefined}
                  onClick={() => manage.onSelect(i)}
                >
                  {body}
                </button>
                {selected && manage.pendingVoid !== l.id && manage.adjusting !== l.id && (
                  <div className="mline__actions">
                    <button type="button" className="chip chip--solid" onClick={() => manage.onEditLine(l)}><kbd>Enter</kbd>Edit</button>
                    <button type="button" className="chip chip--solid" onClick={() => manage.onAskAdjust(l)}><kbd>P</kbd>Adjust price</button>
                    <button type="button" className="chip chip--solid chip--danger" onClick={() => manage.onAskVoid(l)}><kbd>Del</kbd>Void</button>
                  </div>
                )}
                {manage.pendingVoid === l.id && <VoidReasons lineId={l.id} onVoid={manage.onVoid} />}
                {manage.adjusting === l.id && <AdjustField line={l} order={order} onAdjust={manage.onAdjust} />}
              </div>
            );
          }
          // Cashier: sent lines are locked (the kitchen may be cooking them).
          return l.sent
            ? <div key={l.id} className="line line--sent">{body}</div>
            : <button key={l.id} type="button" className="line" onClick={() => onEdit(l)}>{body}</button>;
        })}

        {listing && open.length > 0 && (
          <section className="waiting" aria-label="Waiting to pay">
            <h2>Waiting to pay · {open.length}</h2>
            {open.map((o, i) => (
              <button
                key={o.number}
                type="button"
                className={`waiting__row${manage?.selected === i ? ' waiting__row--selected' : ''}`}
                aria-current={manage?.selected === i || undefined}
                onClick={() => onOpen(o.number)}
              >
                <span className="waiting__no num">{o.number}</span>
                <span className="waiting__total num">{fmt(orderTotal(o))}</span>
                <span className="waiting__meta">
                  <span className="waiting__items">{items(o)}</span>
                  <OnlineTag order={o} />
                  <Cook tickets={tickets} number={o.number} />
                  {o.adjust?.discount && <span className="status status--discount">{discountLabel(o.adjust.discount)}</span>}
                  <span className="status status--unpaid">Unpaid</span>
                </span>
              </button>
            ))}
          </section>
        )}

        {listing && paidToday.length > 0 && (
          <section className="waiting waiting--paid" aria-label="Paid today">
            <h2>Paid today · {paidToday.length}</h2>
            {paidToday.map((o) => (
              <div key={o.number} className="waiting__row">
                <span className="waiting__no num">{o.number}</span>
                <span className="waiting__total num">{fmt(o.total)}</span>
                <span className="waiting__meta">
                  <span className="waiting__items">{items(o)}</span>
                  <OnlineTag order={o} />
                  <Cook tickets={tickets} number={o.number} />
                  <span className="status status--paid">Paid · {TENDER[o.tender]}</span>
                </span>
              </div>
            ))}
          </section>
        )}
      </div>

      {manage && !listing && (
        <div className="discounts" role="group" aria-label="Order discount">
          {DISCOUNT_CHIPS.map((c) => {
            const on = JSON.stringify(discount ?? null) === JSON.stringify(c.discount);
            return (
              <button
                key={c.key}
                type="button"
                className={`chip${c.discount.kind === 'comp' ? ' chip--free' : ''}`}
                aria-pressed={on}
                aria-label={c.discount.kind === 'comp' ? 'Free (comp the whole order)' : `${c.label} off`}
                onClick={() => manage.onDiscount(on ? null : c.discount)}
              >
                <kbd>{c.key}</kbd>{c.label}
              </button>
            );
          })}
        </div>
      )}

      <div className="panel__foot">
        {(t.lineAdjust > 0 || t.orderDiscount > 0) && (
          <div className="breakdown num">
            <span>{fmt(t.subtotal)}</span>
            {t.lineAdjust > 0 && <span>− {fmt(t.lineAdjust)} adjusted</span>}
            {t.orderDiscount > 0 && discount && <span>− {fmt(t.orderDiscount)} {discountLabel(discount)}</span>}
          </div>
        )}
        <span className="total num">{fmt(total)}</span>
        {hasNew || !isOpen
          ? <button type="button" className="cta" disabled={!hasNew} onClick={onSend}>Send to kitchen</button>
          : comped
            ? <button type="button" className="cta" onClick={onCloseFree}>Close · Free</button>
            : <button type="button" className="cta" onClick={onCharge}>Charge</button>}
      </div>
    </aside>
  );
}
