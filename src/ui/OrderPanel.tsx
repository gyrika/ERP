import { useState, type ReactNode } from 'react';
import { label } from './labels.ts';
import { NumberInput } from './NumberInput.tsx';
import type { Actor } from '../domain/auth.ts';
import { lineCookState, type KitchenTicket } from '../domain/kitchen.ts';
import { DISCOUNT_CHIPS } from '../domain/manager.ts';
import { itemById } from '../domain/menu.ts';
import { fmt } from '../domain/money.ts';
import { balanceDue, orderTotal, orderTypeOf, unsentLines } from '../domain/order.ts';
import { amountLeft, tenderParts, type Pick as UnitPick } from '../domain/split.ts';
import { discountLabel, lineAdjustment, lineGross, lineNet, totals } from '../domain/totals.ts';
import type { Cents, Discount, Order, OrderLine, PaidOrder, Tender } from '../domain/types.ts';
import type { OrderType } from '../domain/types.ts';
import { platformLabel, platformName } from '../domain/platforms.ts';
import { leaveOutsOf, lineItemName, secondHalf } from '../domain/halves.ts';
import { boxesIn, opensBox } from '../domain/combos.ts';
import { PayPanel } from './PayPanel.tsx';
import type { PaidEdit } from '../domain/paidEdits.ts';
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

/** The bill's number, as a badge nothing else on screen looks like (never mistaken for a price). */
function OrderBadge({ number, quiet = false }: { number: number; quiet?: boolean }) {
  return (
    <span className={`obadge${quiet ? ' obadge--quiet' : ''}`} data-fly-badge>
      <span className="obadge__label">{label('billNo')}</span>
      <span className="obadge__no num">{number}</span>
    </span>
  );
}

export const COOK_LABEL = { waiting: 'Waiting', cooking: 'Cooking', done: 'Done' } as const;
export const TENDER: Record<Tender, string> = { cash: 'Cash', transfer: 'Bank transfer', card: 'Card', qr: 'QR', comp: 'Free', uber: 'Uber Eats' };
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Void reasons for a sent line (owner rule: a reason is required). Keys 1-3 pick them. */
export const VOID_REASONS = ['Customer changed mind', 'Wrong item entered', 'Out of stock'];

/** "150" or "150.50" rupees -> cents, without floating point. null if not a valid amount. */
export const parseRupees = (raw: string): Cents | null => {
  const m = /^\s*(\d{1,6})(?:\.(\d{1,2}))?\s*$/.exec(raw);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
};

/** An order from cheesybeez.com, and when the customer comes for it (or the rider takes it); or from a delivery app, with its code there. */
export function OnlineTag({ order, time = true }: { order: Order; time?: boolean }) {
  if (order.platform) return <span className="status status--online" title="Rider collects it; the app pays">{platformLabel(order.platform)}</span>;
  if (!order.online) return null;
  const label = order.online.delivery ? 'Delivery' : 'Online';
  return <span className="status status--online" title="Ordered on cheesybeez.com">{label}{time && ` · ${clock(order.online.pickupBy)}`}</span>;
}

/** Manager mode state and actions, owned by App (which also maps the keys). The selected line is the panel's own `selected`. */
export interface ManagePanel {
  actor: Actor;
  pendingVoid: string | null;
  adjusting: string | null;
  onEditLine: (line: OrderLine) => void;
  onAskVoid: (line: OrderLine) => void;
  onVoid: (lineId: string, reason: string) => void;
  onAskAdjust: (line: OrderLine) => void;
  onAdjust: (lineId: string, cents: Cents) => void;
  onDiscount: (discount: Discount | null) => void;
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


interface Props {
  order: Order;
  /** Live kitchen tickets, to show Cooking / Made on sent lines. */
  tickets: KitchenTicket[];
  paid: PaidOrder | null;
  /** `paid` was paid by the last step: its Undo is the payment's. */
  justPaid?: boolean;
  /** The customer has the food (SCRUM-240): offered once the kitchen has made it. */
  onGive: () => void;
  now: number;
  /** Present while manager mode is on. */
  manage: ManagePanel | null;
  /** The highlighted line (index into the order's lines): arrows move it, VOID and +/- act on it. */
  selected: number;
  onSelect: (index: number) => void;
  /** Opens the line's extras to change it (the item's name). */
  onEdit: (line: OrderLine) => void;
  /** − / + on a line not yet sent: one more, one fewer; below 1 it comes off, with Undo. */
  onStep: (line: OrderLine, by: 1 | -1) => void;
  /** The row's ✕: the same as VOID ITEM (a sent line asks for a manager's PIN). */
  onRemove: (line: OrderLine) => void;
  /** Takes the delivery app's mark off an order not yet sent (keyed in by mistake). */
  onClearPlatform: () => void;
  onUndo: () => void;
  /** Money back by bank to a customer who paid by transfer (the bar's Give back is cash from the drawer). */
  onGiveBack?: (how: Tender) => void;
  /** Take away / Dine in / Delivery. */
  onOrderType: (type: OrderType) => void;
  /** The fee for a counter delivery, as the cashier types it (cents). */
  onDeliveryFee: (fee: Cents) => void;
  /** The receipt of the paid order on screen; null when this device does not print. */
  printState?: 'printing' | 'printed' | 'failed' | null;
  /** Prints a COPY, without opening the drawer. Absent when this device does not print. */
  onReprint?: () => void;
  /** The customer (CRM) on the order, by mobile. Absent while Customers is off. */
  customerBar?: ReactNode;
  /** Present while Pay is open: the panel becomes the payment, in place of a sheet. */
  paying?: {
    onPay: (tender: Tender, tendered: Cents, customerId?: string, unlinked?: boolean) => void;
    /** Split bill: one person's part (split.ts). */
    onPayPart?: (tender: Tender, tendered: Cents, pick: UnitPick, customerId?: string, unlinked?: boolean) => void;
    onClose: () => void;
    customers?: boolean;
  } | null;
  /** Present while an item's extras are open (adding or changing a line): they take the panel, in place of a pop-up. */
  extras?: ReactNode;
  /** A paid order on screen: what was changed after paying (paidEdits.ts), marked on its lines (SCRUM-253). */
  edits?: PaidEdit[];
}

const signed = (c: Cents) => `${c >= 0 ? '+' : '−'}${fmt(Math.abs(c))}`;

/** Under a line changed after paying: what, when, and the money, amber until it is paid. */
function EditMark({ edit }: { edit: PaidEdit }) {
  const when = edit.at === undefined ? 'now' : clock(edit.at);
  const words = edit.kind === 'added' ? `Added ${when}` : edit.kind === 'removed' ? `Removed ${when}` : `${edit.what.join(', ') || 'Changed'} · ${when}`;
  return (
    <span className={`line__edit${edit.settled ? '' : ' line__edit--due'} num`}>
      {words}{edit.amount ? ` · ${signed(edit.amount)}` : ''}
    </span>
  );
}

const dateTime = (at: number) => new Date(at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/**
 * The bill, in the layout staff know from their old POS: a header (Bill No, date and time, Take
 * away | Dine in, the customer's mobile), a table of lines (Item, Qty − +, Price,
 * Total, ✕) with the selected line highlighted, and the totals with NET AMOUNT large. The actions
 * live in the bar along the bottom (ActionBar). Manager mode: the same table, with the selected
 * line's Edit / Adjust price / Void and the discount chips. No dialogs.
 */
export function OrderPanel({
  order, tickets, paid, justPaid = false, onGive, now, manage, selected, onSelect, onEdit, onStep, onRemove, onClearPlatform,
  onUndo, onGiveBack, onOrderType, onDeliveryFee, printState, onReprint, paying, extras, customerBar, edits = [],
}: Props) {
  const editOf = new Map(edits.map((e) => [e.lineId, e]));
  const panelClass = `panel${manage ? ' panel--managing' : ''}`;

  if (extras) {
    return <aside className={`${panelClass} panel--extras`} aria-label="Current order">{extras}</aside>;
  }

  // A paid order changed afterwards (SCRUM-242): Pay takes only the difference.
  const due = paid ? balanceDue(paid) : 0;
  if (paying && paid && due > 0) {
    return (
      <aside className={`${panelClass} panel--paying`} aria-label="Current order">
        <PayPanel number={paid.number} total={due} lines={<PayLines order={paid} />} onPay={paying.onPay} onClose={paying.onClose} />
      </aside>
    );
  }
  if (paying && !paid && order.lines.length > 0) {
    return (
      <aside className={`${panelClass} panel--paying`} aria-label="Current order">
        <PayPanel number={order.number} total={amountLeft(order)} lines={<PayLines order={order} />} order={order} onPayPart={paying.onPayPart} onPay={paying.onPay}
          onClose={paying.onClose} customers={paying.customers} customer={order.customer} />
      </aside>
    );
  }

  const shown: Order = paid ?? order;
  const isOpen = shown.sentAt !== undefined;
  const empty = shown.lines.length === 0;
  const word = !empty && isOpen && !unsentLines(shown).length ? kitchenWord(shown, tickets) : null;
  const ready = word === 'Ready' ? readyFor(shown, tickets, now) : undefined;

  const header = (
    <div className="bill__head">
      <div className="bill__row">
        <span className="panel__id">
          <OrderBadge number={shown.number} quiet={!isOpen && empty && !paid} />
          <OnlineTag order={shown} time={false} />
          {order.platform && !isOpen && !paid && (
            <button type="button" className="panel__unmark" onClick={onClearPlatform} aria-label={`Not from ${platformName(order.platform.id)}`}>×</button>
          )}
          {shown.customer?.name && paid && <span className="panel__cust">{shown.customer.name}</span>}
        </span>
        <span className="bill__when num">{dateTime(paid?.paidAt ?? now)}</span>
      </div>
      <div className="bill__row">
        <div className="seg" role="radiogroup" aria-label={label('orderType')}>
          {(['takeAway', 'dineIn', 'delivery'] as const).map((type) => (
            <button key={type} type="button" role="radio" className="seg__opt" aria-checked={orderTypeOf(shown) === type}
              disabled={Boolean(paid)} onClick={() => onOrderType(type)}>
              {label(type)}
            </button>
          ))}
        </div>
        {word && word !== 'Given' && (
          ready
            ? <button type="button" className="bill__give" aria-label={label('given')} onClick={onGive}>{label('given')}<small>{ready.label}</small></button>
            : <span className="cookword">{word}</span>
        )}
      </div>
    </div>
  );

  const t = totals(shown);
  const discount = shown.adjust?.discount;
  const off = t.lineAdjust + t.orderDiscount;
  const boxes = boxesIn(shown.lines);
  const sel = Math.min(selected, shown.lines.length - 1);

  /** One line of the table. `inBox`: a combo's dish, priced with its box. */
  const row = (l: OrderLine, i: number, inBox: boolean) => {
    const name = lineItemName(l);
    const adj = lineAdjustment(shown, l);
    const isSel = i === sel;
    // A line added to a paid order and not yet settled (SCRUM-253) is still unsent: − / + and ✕ work on it.
    const canStep = !l.sent && !inBox && !manage;
    const edit = editOf.get(l.id);
    const cook = l.sent ? lineCookState(tickets, l.id) : 'waiting';
    const extra = inBox && l.box ? lineNet(shown, l) - l.box.share : 0;
    return [
      <tr key={l.id} className={`bill__line${isSel ? ' bill__line--on' : ''}${l.sent ? ' bill__line--sent' : ''}${inBox ? ' bill__line--dish' : ''}`}
        // A paid bill (SCRUM-251): a tap anywhere on the row opens the item to change, not only its name.
        aria-selected={isSel} onClick={() => { onSelect(i); if (paid && !manage) onEdit(l); }}>
        <td className="bill__item">
          <button type="button" className="bill__name" onClick={(e) => { e.stopPropagation(); onSelect(i); if (manage) manage.onEditLine(l); else onEdit(l); }}>
            <span className="line__name">{name}</span>
            {sub(l) && <span className="line__sub">{sub(l)}</span>}
            {adj > 0 && <span className="line__adj num">−{fmt(adj)} off this line</span>}
            {cook !== 'waiting' && <span className={`status status--${cook}`}>{cook === 'done' ? 'Made' : 'Cooking'}</span>}
            {edit && <EditMark edit={edit} />}
          </button>
        </td>
        <td className="bill__qty">
          {inBox ? <span className="num">{l.qty}</span> : (
            <span className="qty" role="group" aria-label={`How many ${name}`}>
              <button type="button" className="qty__key" disabled={!canStep} aria-label={l.qty > 1 ? `One fewer ${name}` : `Remove ${name}`}
                onClick={(e) => { e.stopPropagation(); onStep(l, -1); }}>−</button>
              <span className="qty__n num">{l.qty}</span>
              <button type="button" className="qty__key" disabled={!canStep} aria-label={`One more ${name}`}
                onClick={(e) => { e.stopPropagation(); onStep(l, 1); }}>+</button>
            </span>
          )}
        </td>
        <td className="bill__price num">{inBox ? '' : fmt(lineGross(l) / l.qty)}</td>
        <td className="bill__total num">{inBox ? (extra ? `${extra > 0 ? '+' : '−'}${fmt(Math.abs(extra))}` : '') : fmt(lineNet(shown, l))}</td>
        <td className="bill__x">
          {/* ✕ takes the item off, a paid bill's too (Give back follows); a tap on the row changes it (SCRUM-251). */}
          {!inBox && (
            <button type="button" className="bill__remove" aria-label={`${label('void')} ${name}`}
              onClick={(e) => { e.stopPropagation(); onSelect(i); onRemove(l); }}>✕</button>
          )}
        </td>
      </tr>,
      manage && isSel && (
        <tr key={`${l.id}-manage`} className="bill__manage"><td colSpan={5}>
          {manage.pendingVoid === l.id ? <VoidReasons lineId={l.id} onVoid={manage.onVoid} />
            : manage.adjusting === l.id ? <AdjustField line={l} order={shown} onAdjust={manage.onAdjust} />
              : (
                <div className="mline__actions">
                  <button type="button" className="chip chip--solid" onClick={() => manage.onEditLine(l)}><kbd>Enter</kbd>Edit</button>
                  <button type="button" className="chip chip--solid" onClick={() => manage.onAskAdjust(l)}><kbd>P</kbd>Adjust price</button>
                  <button type="button" className="chip chip--solid chip--danger" onClick={() => manage.onAskVoid(l)}><kbd>Del</kbd>Void</button>
                </div>
              )}
        </td></tr>
      ),
    ];
  };

  return (
    <aside className={panelClass} aria-label="Current order">
      {header}
      {!manage && !paid && customerBar}
      {shown.edited && !paid && <div className="panel__stamp num">Edited by {shown.edited.by}, {clock(shown.edited.at)}</div>}

      {paid && (() => {
        const changed = paid.settled !== undefined || due !== 0;
        const cashChange = !changed && paid.tender === 'cash' && paid.change > 0;
        return (
          <div className={`paid paid--bar${changed ? ' paid--changed' : ''}`} role="status">
            {changed ? (
              // Changed after paying (SCRUM-253): one quiet line; the money is in the totals (Paid before, To pay now).
              <span className="paid__sub num"><b>Changed after paying</b> · first paid {fmt(paid.total)} at {clock(paid.paidAt)}</span>
            ) : (
              <>
                <span className="paid__label">{cashChange ? 'Change' : paid.tender === 'comp' ? 'Closed · Free' : 'Paid'}</span>
                <span className="paid__big num">{fmt(cashChange ? paid.change : paid.total)}</span>
                <span className="paid__sub num">{paid.parts?.length
                  ? `Split · ${paid.parts.map((x) => `${TENDER[x.tender]} ${fmt(x.amount)}`).join(' + ')} · `
                  : paid.tender === 'cash' ? `Cash ${fmt(paid.tendered)} · ` : `${TENDER[paid.tender]} · `}Total {fmt(paid.total)}</span>
              </>
            )}
            <span className="paid__links">
              {justPaid && <button type="button" className="linkbtn" onClick={onUndo}>Undo payment</button>}
              {onReprint && <button type="button" className="linkbtn" onClick={onReprint}>Print again</button>}
              {/* Paid by transfer: the money can go back the same way, from the shop's bank. */}
              {due < 0 && onGiveBack && tenderParts(paid).some((x) => x.tender === 'transfer') && (
                <button type="button" className="linkbtn" onClick={() => onGiveBack('transfer')}>Give back by bank</button>
              )}
            </span>
            {printState === 'failed' && <span className="paid__note">Receipt not printed</span>}
          </div>
        );
      })()}

      <div className="panel__lines bill__lines">
        {empty ? <div className="empty"><b>{label('emptyBill')}</b><span>or type it: “2 L margherita, burger”</span></div> : (
          <table className={`bill${paid ? " bill--paid" : ""}`}>
            <thead>
              <tr>
                <th scope="col">{label('item')}</th>
                <th scope="col" className="bill__qty">{label('qty')}</th>
                <th scope="col" className="num">{label('price')}</th>
                <th scope="col" className="num">{label('total')}</th>
                <th scope="col"><span className="sr-only">{label('remove')}</span></th>
              </tr>
            </thead>
            {(() => {
              const groups: ReactNode[] = [];
              let loose: ReactNode[] = [];
              const flush = () => { if (loose.length) { groups.push(<tbody key={`g${groups.length}`}>{loose}</tbody>); loose = []; } };
              shown.lines.forEach((l, i) => {
                if (!l.box) { loose.push(row(l, i, false)); return; }
                if (!opensBox(shown.lines, i)) return;
                flush();
                const box = boxes.get(l.box.id)!;
                groups.push(
                  <tbody key={`box-${box.id}`} className="bill__box" aria-label={box.name}>
                    <tr className="bill__boxhead">
                      <td className="bill__item"><span className="line__name">{box.name}</span>
                        {box.saved > 0 && <span className="line__sub num">Saves Rs {fmt(box.saved)} on separate prices</span>}</td>
                      <td className="bill__qty"><span className="num">1</span></td>
                      <td className="bill__price num">{fmt(box.price)}</td>
                      <td className="bill__total num">{fmt(box.lines.reduce((n, x) => n + lineNet(shown, x), 0))}</td>
                      <td className="bill__x">
                        {!paid && (
                          <button type="button" className="bill__remove" aria-label={`${label('void')} ${box.name}`}
                            onClick={() => { onSelect(i); onRemove(l); }}>✕</button>
                        )}
                      </td>
                    </tr>
                    {box.lines.map((x) => row(x, shown.lines.indexOf(x), true))}
                  </tbody>,
                );
              });
              flush();
              // Taken off after paying (SCRUM-253): still on the bill, struck through, so the money makes sense.
              const gone = edits.filter((e) => e.kind === 'removed' && e.before);
              if (gone.length) {
                groups.push(
                  <tbody key="gone" aria-label="Taken off after paying">
                    {gone.map((e) => (
                      <tr key={`gone-${e.lineId}`} className="bill__line bill__line--gone">
                        <td className="bill__item"><span className="bill__name">
                          <span className="line__name">{lineItemName(e.before!)}</span>
                          <EditMark edit={e} />
                        </span></td>
                        <td className="bill__qty"><span className="num">{e.before!.qty}</span></td>
                        <td className="bill__price num">{fmt(lineGross(e.before!) / e.before!.qty)}</td>
                        <td className="bill__total num">{fmt(lineGross(e.before!))}</td>
                        <td className="bill__x" />
                      </tr>
                    ))}
                  </tbody>,
                );
              }
              return groups;
            })()}
          </table>
        )}
      </div>

      {manage && !empty && !paid && (
        <div className="discounts" role="group" aria-label="Order discount">
          {DISCOUNT_CHIPS.map((c) => {
            const on = JSON.stringify(discount ?? null) === JSON.stringify(c.discount);
            return (
              <button key={c.key} type="button" className={`chip${c.discount.kind === 'comp' ? ' chip--free' : ''}`} aria-pressed={on}
                aria-label={c.discount.kind === 'comp' ? 'Free (comp the whole order)' : `${c.label} off`}
                onClick={() => manage.onDiscount(on ? null : c.discount)}>
                <kbd>{c.key}</kbd>{c.label}
              </button>
            );
          })}
        </div>
      )}

      <dl className="sums num">
        <div><dt>{label('subtotal')}</dt><dd>{fmt(t.subtotal)}</dd></div>
        <div><dt>{label('discount')}{discount && t.orderDiscount > 0 ? ` · ${discountLabel(discount)}` : ''}</dt><dd>{off > 0 ? `−${fmt(off)}` : fmt(0)}</dd></div>
        {order.delivery && !paid
          ? (
            <div className="sums__fee">
              <dt><label htmlFor="delivery-fee">{label('deliveryFee')}</label></dt>
              <dd>
                <input id="delivery-fee" className="sums__feein num" inputMode="numeric" autoComplete="off" placeholder="0"
                  value={order.delivery.fee ? String(order.delivery.fee / 100) : ''}
                  onChange={(e) => onDeliveryFee(Number(e.target.value.replace(/\D/g, '').slice(0, 6) || 0) * 100)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur(); }} />
              </dd>
            </div>
          )
          : t.deliveryFee > 0 && <div><dt>{label('delivery')}</dt><dd>+{fmt(t.deliveryFee)}</dd></div>}
        <div className="sums__net"><dt>{label('netAmount')}</dt><dd className="total">{fmt(orderTotal(shown))}</dd></div>
        {/* Changed after paying (SCRUM-253): what was paid, and what is left either way. */}
        {paid && (due !== 0 || paid.settled !== undefined) && (
          <>
            <div className="sums__before"><dt>{due !== 0 ? 'Paid before' : 'Paid'}</dt><dd>{fmt(paid.total + (paid.settled ?? 0))}</dd></div>
            {due !== 0 && <div className="sums__due"><dt>{due > 0 ? 'To pay now' : 'To give back'}</dt><dd>{fmt(Math.abs(due))}</dd></div>}
          </>
        )}
      </dl>
    </aside>
  );
}
