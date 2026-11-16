import { useState, type ReactNode } from 'react';
import { NumberInput } from './NumberInput.tsx';
import type { Actor } from '../domain/auth.ts';
import { cookState, lineCookState, type KitchenTicket } from '../domain/kitchen.ts';
import { DISCOUNT_CHIPS } from '../domain/manager.ts';
import { itemById } from '../domain/menu.ts';
import { fmt } from '../domain/money.ts';
import { balanceDue, orderTotal, unsentLines } from '../domain/order.ts';
import { amountLeft, tenderParts, type Pick as UnitPick } from '../domain/split.ts';
import { discountLabel, lineAdjustment, lineNet, totals } from '../domain/totals.ts';
import type { Cents, Discount, Order, OrderLine, PaidOrder, Tender } from '../domain/types.ts';
import { platformLabel, platformName } from '../domain/platforms.ts';
import { leaveOutsOf, lineItemName, secondHalf } from '../domain/halves.ts';
import { boxesIn, opensBox } from '../domain/combos.ts';
import { PayPanel } from './PayPanel.tsx';
import { kitchenWord, readyFor } from './OrdersRail.tsx';

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

/** What an order is, in a few words ("2 Margherita L, Chicken Burger"): how the cashier tells orders apart in a list. */
export const orderSummary = (lines: readonly Pick<OrderLine, 'itemId' | 'qty' | 'size' | 'half'>[]): string =>
  lines.map((l) => `${l.qty > 1 ? `${l.qty} ` : ''}${lineItemName(l)}${l.size ? ` ${l.size}` : ''}`).join(', ');

/** The order's number, as a badge nothing else on screen looks like (never mistaken for a price). */
function OrderBadge({ number, quiet = false }: { number: number; quiet?: boolean }) {
  return (
    <span className={`obadge${quiet ? ' obadge--quiet' : ''}`}>
      <span className="obadge__label">Order</span>
      <span className="obadge__no num">{number}</span>
    </span>
  );
}

/** One row of a list of orders: number, whose and what, how it stands, and the total last and quiet. */
function OrderRow({ o, status, total, quiet = false }: { o: Order; status: ReactNode; total: Cents; quiet?: boolean }) {
  return (
    <>
      <span className={`waiting__no num${quiet ? ' waiting__no--quiet' : ''}`}>{o.number}</span>
      <span className="waiting__main">
        <span className="waiting__what">
          {o.customer?.name && <b>{o.customer.name} · </b>}
          {orderSummary(o.lines)}
        </span>
        <span className="waiting__meta">{status}</span>
      </span>
      <span className="waiting__total num">{fmt(total)}</span>
    </>
  );
}
const TENDER: Record<Tender, string> = { cash: 'Cash', transfer: 'Bank transfer', card: 'Card', qr: 'QR', comp: 'Free', uber: 'Uber Eats' };
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Void reasons for a sent line (owner rule: a reason is required). Keys 1-3 pick them. */
export const VOID_REASONS = ['Customer changed mind', 'Wrong item entered', 'Out of stock'];

/** "150" or "150.50" rupees -> cents, without floating point. null if not a valid amount. */
export const parseRupees = (raw: string): Cents | null => {
  const m = /^\s*(\d{1,6})(?:\.(\d{1,2}))?\s*$/.exec(raw);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
};

/** An order from cheesybeez.com, and when the customer comes for it (or the rider takes it); or from a delivery app, with its code there. */
function OnlineTag({ order, time = true }: { order: Order; time?: boolean }) {
  if (order.platform) return <span className="status status--online" title="Rider collects it; the app pays">{platformLabel(order.platform)}</span>;
  if (!order.online) return null;
  const label = order.online.delivery ? 'Delivery' : 'Online';
  return <span className="status status--online" title="Ordered on cheesybeez.com">{label}{time && ` · ${clock(order.online.pickupBy)}`}</span>;
}

const COOK_LABEL = { waiting: 'Waiting', cooking: 'Cooking', done: 'Done' } as const;

/** How a sent order stands, as one word with a dot: Waiting, Cooking, Done. */
function CookWord({ tickets, number }: { tickets: KitchenTicket[]; number: number }) {
  const state = cookState(tickets, number);
  return <span className={`cookword cookword--${state}`}>{COOK_LABEL[state]}</span>;
}

/** What one of the two buttons does now, or (no `run`) how that side stands. `short`: the words shown under its side's name. */
interface Side { label: string; short?: string; note?: string; run?: () => void; disabled?: boolean }

/**
 * The two buttons that never move (SCRUM-239): the kitchen on the left, the money on the right.
 * Each is the thing to do until it is done, then says how it stands, so the buttons are the
 * order's status. Either can be done first; the likelier next one is dark and takes Ctrl+Enter.
 */
function Twin({ kitchen, money, primary }: { kitchen: Side; money: Side; primary: 'kitchen' | 'money' | null }) {
  const side = (which: 'kitchen' | 'money', s: Side) => {
    const title = `${which === 'kitchen' ? 'Kitchen' : 'Money'}${s.note ? ` · ${s.note}` : ''}`;
    if (!s.run) {
      return (
        <div className={`twin__side twin__is twin__is--${which}`}>
          <small>{title}</small><strong>{s.label}</strong>
        </div>
      );
    }
    const main = primary === which;
    return (
      <button
        type="button"
        className={`twin__side${main ? ' twin__do' : ' twin__also'}`}
        aria-label={s.label}
        disabled={s.disabled}
        autoFocus={main && !s.disabled ? true : undefined}
        onClick={s.run}
      >
        <small aria-hidden="true">{title}</small>
        <strong aria-hidden="true">{s.short ?? s.label}{main && !s.disabled && <kbd>Ctrl Enter</kbd>}</strong>
      </button>
    );
  };
  return <div className="twin">{side('kitchen', kitchen)}{side('money', money)}</div>;
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
  /** Paid today, newest first. Read-only: nothing left to do on them. */
  paidToday: PaidOrder[];
  /** Live kitchen tickets, to show Cooking / Done beside Paid / Unpaid. */
  tickets: KitchenTicket[];
  paid: PaidOrder | null;
  /** `paid` was paid by the last step: its Undo is the payment's. */
  justPaid?: boolean;
  /** The customer has the food (SCRUM-240): offered on the Kitchen side once it is Ready. */
  onGive: () => void;
  /** For how long a ready order has waited. */
  now: number;
  /** Present while manager mode is on. */
  manage: ManagePanel | null;
  onEdit: (line: OrderLine) => void;
  /** − / + on the line just added (not sent, not in a box): one more, one fewer; below 1 it comes off, with Undo. */
  onStep?: (line: OrderLine, by: 1 | -1) => void;
  onSend: () => void;
  onCharge: () => void;
  /** A paid order changed so the customer gets money back (SCRUM-242): cash from the drawer, one tap. */
  onGiveBack?: (how?: Tender) => void;
  onCloseFree: () => void;
  /** Closes a delivery app's order (SCRUM-195): the app pays the shop, nothing is collected here. */
  onClosePlatform: () => void;
  /** Takes the delivery app's mark off an order not yet sent (keyed in by mistake). */
  onClearPlatform: () => void;
  onNext: () => void;
  onUndo: () => void;
  /** The receipt of the paid order on screen; null when this device does not print. */
  printState?: 'printing' | 'printed' | 'failed' | null;
  /** Prints a COPY, without opening the drawer. Absent when this device does not print. */
  onReprint?: () => void;
  /** The customer (CRM) on the order: put on, changed or taken off here. Absent while Customers is off. */
  customerBar?: ReactNode;
  /** Present while Charge is open: the panel becomes the payment, in place of a sheet. */
  paying?: {
    onPay: (tender: Tender, tendered: Cents, customerId?: string, unlinked?: boolean) => void;
    /** Split bill: one person's part (split.ts). */
    onPayPart?: (tender: Tender, tendered: Cents, pick: UnitPick, customerId?: string, unlinked?: boolean) => void;
    onClose: () => void;
    /** Customers (CRM) is on and reachable: the optional Mobile field. */
    customers?: boolean;
  } | null;
  /** Present while an item's extras are open (adding or changing a line): they take the panel, in place of a pop-up. */
  extras?: ReactNode;
}

/** The order while paying: one quiet line per item (a combo box as one), to check before the money changes hands. */
function PayLines({ order }: { order: Order }) {
  const t = totals(order);
  const discount = order.adjust?.discount;
  const boxes = boxesIn(order.lines);
  return (
    <ul className="paylines num" aria-label="Order">
      {order.lines.map((l, i) => {
        if (l.box) {
          if (!opensBox(order.lines, i)) return null;
          const box = boxes.get(l.box.id)!;
          return (
            <li key={`box-${box.id}`}>
              <span className="paylines__name">{box.name}<small>{box.lines.map(lineItemName).join(' · ')}</small></span>
              <span>{fmt(box.lines.reduce((n, x) => n + lineNet(order, x), 0))}</span>
            </li>
          );
        }
        return (
          <li key={l.id}>
            <span className="paylines__name">
              {l.qty > 1 ? `${l.qty} × ` : ''}{lineItemName(l)}
              {sub(l) && <small>{sub(l)}</small>}
            </span>
            <span>{fmt(lineNet(order, l))}</span>
          </li>
        );
      })}
      {t.orderDiscount > 0 && discount && (
        <li className="paylines__off"><span>{discountLabel(discount)}</span><span>−{fmt(t.orderDiscount)}</span></li>
      )}
      {t.deliveryFee > 0 && <li className="paylines__off"><span>Delivery</span><span>+{fmt(t.deliveryFee)}</span></li>}
    </ul>
  );
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
 * The bill. Cashier mode: Send to kitchen and Pay side by side, either first (SCRUM-239). Manager
 * mode: the same card lifted, every line selectable and changeable, discount chips under the
 * order. No dialogs, no banners.
 */
export function OrderPanel({
  order, paidToday, tickets, paid, justPaid = false, onGive, now, manage, onEdit, onStep, onSend, onCharge, onGiveBack, onCloseFree, onClosePlatform, onClearPlatform, onNext, onUndo, printState, onReprint, paying, extras, customerBar,
}: Props) {
  const panelClass = `panel${manage ? ' panel--managing' : ''}`;

  if (extras) {
    return <aside className={`${panelClass} panel--extras`} aria-label="Current order">{extras}</aside>;
  }

  // A paid order changed afterwards (SCRUM-242): Charge takes only the difference.
  const due = paid ? balanceDue(paid) : 0;
  if (paying && paid && due > 0) {
    return (
      <aside className={`${panelClass} panel--paying`} aria-label="Current order">
        <PayPanel
          number={paid.number}
          total={due}
          lines={<PayLines order={paid} />}
          onPay={paying.onPay}
          onClose={paying.onClose}
        />
      </aside>
    );
  }

  if (paying && !paid && order.lines.length > 0) {
    return (
      <aside className={`${panelClass} panel--paying`} aria-label="Current order">
        <PayPanel
          number={order.number}
          total={amountLeft(order)}
          lines={<PayLines order={order} />}
          order={order}
          onPayPart={paying.onPayPart}
          onPay={paying.onPay}
          onClose={paying.onClose}
          customers={paying.customers}
          customer={order.customer}
        />
      </aside>
    );
  }

  /** The Kitchen side once nothing is left to send: Given while it waits for the customer, else how it stands. */
  const kitchenSide = (o: Order): Side => {
    const word = kitchenWord(o, tickets);
    if (word !== 'Ready') return { label: word };
    return { label: 'Given', note: readyFor(o, tickets, now)?.label, run: onGive };
  };

  if (paid) {
    const changed = paid.settled !== undefined || due !== 0;
    const paidSoFar = paid.total + (paid.settled ?? 0);
    const cashChange = !changed && paid.tender === 'cash' && paid.change > 0;
    const held = Boolean(paid.held);
    const kitchen = held ? { label: 'Send to kitchen', short: 'Send', run: onSend } : kitchenSide(paid);
    return (
      <aside className={panelClass} aria-label="Current order">
        <div className="panel__no">
          <span className="panel__id"><OrderBadge number={paid.number} /><OnlineTag order={paid} time={false} />
            {paid.customer?.name && <span className="panel__cust">{paid.customer.name}</span>}</span>
          {/* Nothing left to do here: Enter starts the next order. Paid first: Send is the thing to do. */}
          {!kitchen.run && <button type="button" className="panel__back" autoFocus onClick={onNext}>Next order</button>}
        </div>
        <div className="paid" role="status">
          {changed ? (
            <>
              <span className="paid__label">Paid</span>
              <span className="paid__big num">{fmt(paidSoFar)}</span>
              <span className="paid__sub num">Changed after paying · total now {fmt(orderTotal(paid))}</span>
            </>
          ) : (
            <>
              <span className="paid__label">{cashChange ? 'Change' : paid.tender === 'comp' ? 'Closed · Free' : 'Paid'}</span>
              <span className="paid__big num">{fmt(cashChange ? paid.change : paid.total)}</span>
              <span className="paid__sub num">
                {paid.parts?.length
                  ? `Split · ${paid.parts.map((x) => `${TENDER[x.tender]} ${fmt(x.amount)}`).join(' + ')} · `
                  : paid.tender === 'cash' ? `Cash ${fmt(paid.tendered)} · ` : `${TENDER[paid.tender]} · `}
                Total {fmt(paid.total)}
              </span>
            </>
          )}
          <span className="paid__links">
            {justPaid && <button type="button" className="linkbtn" onClick={onUndo}>Undo payment</button>}
            {onReprint && <button type="button" className="linkbtn" onClick={onReprint}>Print again</button>}
            {/* Paid by transfer: the money can go back the same way, from the shop's bank. */}
            {due < 0 && tenderParts(paid).some((x) => x.tender === 'transfer') && (
              <button type="button" className="linkbtn" onClick={() => onGiveBack?.('transfer')}>Give back by bank</button>
            )}
          </span>
          {printState === 'failed' && <span className="paid__note">Receipt not printed</span>}
        </div>
        {/* The customer changed their mind (SCRUM-242): every item still taps to change it. */}
        <div className="panel__lines">
          {paid.lines.map((l) => {
            const cook = l.sent ? lineCookState(tickets, l.id) : 'waiting';
            return (
              <button key={l.id} type="button" className="line line--sent" onClick={() => onEdit(l)}>
                <span className="line__main">
                  <span className="line__name">{l.qty > 1 ? `${l.qty} × ` : ''}{lineItemName(l)}</span>
                  {sub(l) && <span className="line__sub">{sub(l)}</span>}
                </span>
                <span className="line__price num">{l.box ? '' : fmt(lineNet(paid, l))}</span>
                {cook !== 'waiting' && <span className={`status status--${cook} line__cook`}>{cook === 'done' ? 'Made' : 'Cooking'}</span>}
              </button>
            );
          })}
        </div>
        <div className="panel__foot">
          <Twin
            primary={due ? 'money' : kitchen.run ? 'kitchen' : null}
            kitchen={kitchen}
            money={due > 0
              ? { label: `Charge ${fmt(due)} more`, short: `Charge ${fmt(due)}`, note: 'changed', run: onCharge }
              : due < 0
                ? { label: `Give back ${fmt(-due)}`, note: 'cash from the drawer', run: onGiveBack && (() => onGiveBack()) }
                : { label: paid.tender === 'cash' ? 'Paid · Cash' : `Paid · ${TENDER[paid.tender]}` }}
          />
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
  // The picked line: the last one added that can still change freely. − / + sit on it.
  const picked = [...order.lines].reverse().find((l) => !l.sent && !l.box);

  return (
    <aside className={panelClass} aria-label="Current order">
      <div className="panel__no">
        <span className="panel__id">
          <OrderBadge number={order.number} quiet={!isOpen && listing} />
          <OnlineTag order={order} time={false} />
          {order.platform && !isOpen && (
            <button type="button" className="panel__unmark" onClick={onClearPlatform} aria-label={`Not from ${platformName(order.platform.id)}`}>×</button>
          )}
        </span>
      </div>
      {!manage && customerBar}
      {order.edited && (
        <div className="panel__stamp num">Edited by {order.edited.by}, {clock(order.edited.at)}</div>
      )}

      <div className="panel__lines">
        {listing && paidToday.length === 0 && (
          <div className="empty">
            <b>Tap a size to start</b>
            <span>or just start typing: “2L margherita, burger”</span>
          </div>
        )}

        {(() => {
          const renderLine = (l: OrderLine, i: number) => {
          const adj = lineAdjustment(order, l);
          const body = (
            <>
              <span className="line__main">
                <span className="line__name">{l.qty > 1 ? `${l.qty} × ` : ''}{lineItemName(l)}</span>
                {sub(l) && <span className="line__sub">{sub(l)}</span>}
                {adj > 0 && <span className="line__adj num">−{fmt(adj)} off this line</span>}
              </span>
              <span className="line__price num">
                {l.box ? (lineNet(order, l) !== l.box.share ? `${lineNet(order, l) > l.box.share ? '+' : '−'}${fmt(Math.abs(lineNet(order, l) - l.box.share))}` : '') : fmt(lineNet(order, l))}
              </span>
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
          // Cashier: every line opens to change it. A sent one says if the kitchen has made it,
          // so the cashier knows before telling the customer "no problem".
          if (!l.sent) {
            const row = <button key={l.id} type="button" className="line" onClick={() => onEdit(l)}>{body}</button>;
            if (!onStep || l !== picked) return row;
            const name = lineItemName(l);
            return (
              <div key={l.id} className="lstep">
                {row}
                <div className="lstep__keys" role="group" aria-label={`How many ${name}`}>
                  <button type="button" className="lstep__key" aria-label={l.qty > 1 ? `One fewer ${name}` : `Remove ${name}`} onClick={() => onStep(l, -1)}>−</button>
                  <span className="lstep__qty num" aria-live="polite">{l.qty}</span>
                  <button type="button" className="lstep__key" aria-label={`One more ${name}`} onClick={() => onStep(l, 1)}>+</button>
                </div>
              </div>
            );
          }
          const cook = lineCookState(tickets, l.id);
          return (
            <button key={l.id} type="button" className="line line--sent" onClick={() => onEdit(l)}>
              {body}
              {cook !== 'waiting' && <span className={`status status--${cook} line__cook`}>{cook === 'done' ? 'Made' : 'Cooking'}</span>}
            </button>
          );
          };
          // A combo box (SCRUM-231): its dishes together under its name and price; each dish still taps like any line.
          const boxes = boxesIn(order.lines);
          return order.lines.map((l, i) => {
            if (!l.box) return renderLine(l, i);
            if (!opensBox(order.lines, i)) return null;
            const box = boxes.get(l.box.id)!;
            return (
              <section key={`box-${box.id}`} className="box" aria-label={box.name}>
                <div className="box__head">
                  <div className="box__row num"><span>{box.name}</span><span>{fmt(box.price)}</span></div>
                  {box.saved > 0 && <span className="box__saved num">Saves Rs {fmt(box.saved)} on separate prices</span>}
                </div>
                {box.lines.map((x) => renderLine(x, order.lines.indexOf(x)))}
              </section>
            );
          });
        })()}

        {listing && paidToday.length > 0 && (
          <section className="waiting waiting--paid" aria-label="Paid today">
            <h2>Paid today · {paidToday.length}</h2>
            {paidToday.map((o) => (
              <div key={o.number} className="waiting__row">
                <OrderRow o={o} total={o.total} quiet status={<>
                  {/* Paid, food still coming: the customer is still waiting, so the kitchen state stays. */}
                  {cookState(tickets, o.number) !== 'done' && <CookWord tickets={tickets} number={o.number} />}
                  <span className="cookword cookword--paid">Paid · {TENDER[o.tender]}</span>
                  <OnlineTag order={o} />
                </>} />
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
        {(t.lineAdjust > 0 || t.orderDiscount > 0 || t.deliveryFee > 0) && (
          <div className="breakdown num">
            <span>{fmt(t.subtotal)}</span>
            {t.lineAdjust > 0 && <span>− {fmt(t.lineAdjust)} adjusted</span>}
            {t.orderDiscount > 0 && discount && <span>− {fmt(t.orderDiscount)} {discountLabel(discount)}</span>}
            {t.deliveryFee > 0 && <span>+ {fmt(t.deliveryFee)} delivery</span>}
          </div>
        )}
        <span className="total num">{fmt(total)}</span>
        <Twin
          primary={listing ? null : hasNew ? 'kitchen' : 'money'}
          kitchen={hasNew || !isOpen ? { label: 'Send to kitchen', short: 'Send', run: onSend, disabled: !hasNew } : kitchenSide(order)}
          money={comped
            ? { label: 'Close · Free', run: onCloseFree, disabled: listing }
            : order.platform
              ? { label: `Close · ${platformName(order.platform.id)}`, run: onClosePlatform, disabled: listing }
              : { label: 'Pay', run: onCharge, disabled: listing || total <= 0 }}
        />
      </div>
    </aside>
  );
}
