import { useMemo, useState } from 'react';
import type { Supplier } from '../domain/inventoryData.ts';
import { isPending } from '../domain/docNumbers.ts';
import { parsePacks } from '../domain/inventory.ts';
import { receiveUnitOf } from '../domain/counting.ts';
import { cartOf, cartsOf, draftsOf, orderMessage, whatsAppLink } from '../domain/ordering.ts';
import { fmt, parseLKR } from '../domain/money.ts';
import { CANCEL_REASONS, orderTotals, planOrder, type PurchaseOrder, type PurchaseState } from '../domain/purchaseOrders.ts';
import type { PoLine } from '../domain/sync.ts';
import { daysAgo } from '../domain/itemStory.ts';
import { formatLasts, formatQuantity } from './quantity.ts';
import { BigStepper } from './flow/BigStepper.tsx';
import { ChoiceCard, InfoCard } from './flow/ChoiceCard.tsx';
import { FlowSheet } from './flow/FlowSheet.tsx';
import { RejectionNotices } from './Rejections.tsx';
import { AddSupplierModal } from './AddSupplierModal.tsx';
import { addToDraft, addToOrder, cancelOrder, editOrder, editSupplier, moveToCart, placeOrder, setDraft, setWorkingPrice, type InventoryRow } from '../services/inventoryStore.ts';
import { NumberInput } from './NumberInput.tsx';

/**
 * Purchase orders: the one way to order, one step at a time (src/ui/flow):
 *   0 On order, at the top: the open orders, to edit or cancel with a reason until goods come
 *   1 Who?   a big card per supplier with how many items need ordering ("Prima · 3 to order")
 *   2 What?  that supplier's items as a bill (item, qty, price, total), the suggested packs already
 *            in, "+ Add item" to add more, the total at the bottom, and one main button: Place order (or Add to PO-0003, which
 *            `planOrder` chooses so an item is never on two orders)
 *   3 Send   the message, WhatsApp as the big thing to do; then the next supplier, or Done
 * Each supplier's bill is its cart (a draft underneath), saved as it changes: what runs low is in
 * it by itself (`cartsOf`), a line moves to another supplier of the item, and the bill is changed
 * freely before it is placed. The item sheet's Order tab (ItemOrder) only adds the item to a cart.
 */
type Packs = Record<string, number>;
type Done = (message: string, undo: () => void) => void;
/** An order just made here, or lines just added to one (message: only the added lines). */
interface Placed { order: PurchaseOrder; added: boolean }

const nameOf = (suppliers: Supplier[], id: string) => suppliers.find((s) => s.id === id)?.name ?? 'Supplier';
const word = (n: number, one: string, many: string) => (n === 1 ? one : many);
/** What every supplier's cart holds now: saved carts, else what runs low. */
const cartsNow = (items: InventoryRow[], purchases: PurchaseState) => cartsOf(draftsOf(items), purchases.drafts);
const placedText = (p: Placed, suppliers: Supplier[]) => (p.added ? `Added to ${p.order.poNo}.` : `${p.order.poNo} placed with ${nameOf(suppliers, p.order.supplierId)}.`);

/**
 * One supplier's draft: packs per item (typed or stepped), items added or removed, what the
 * order comes to, and the one action that does everything the draft shows. Every change is
 * saved as the supplier's draft at once (a typed number when its box is left), so it is there
 * next time, for everyone; placing keeps only what was not placed.
 */
function useDraft(supplierId: string, initial: Packs, items: InventoryRow[], purchases: PurchaseState) {
  const [packs, setPacks] = useState<Packs>(initial);
  /** What is in each box while it is being typed (so "1." and an empty box are allowed). */
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const lines: PoLine[] = Object.entries(packs).filter(([, n]) => n > 0).map(([itemId, n]) => ({ itemId, packs: n }));
  const plan = planOrder(purchases.open, supplierId, lines);
  const blocked = new Map(plan.blocked.map((b) => [b.itemId, b.poNo]));
  const totals = orderTotals(lines, new Map(items.map((i) => [i.id, i.workingPriceCents])));
  const mainLabel = plan.create.length > 0
    ? (plan.add.length > 0 ? `Place order and add to ${plan.add.map((a) => a.order.poNo).join(', ')}` : 'Place order')
    : plan.add.length > 0 ? `Add to ${plan.add.map((a) => a.order.poNo).join(', ')}` : 'Place order';
  const canAct = plan.add.length > 0 || plan.create.length > 0;

  const clearTyped = (id: string) => setTyped(({ [id]: _gone, ...rest }) => rest);
  const save = (next: Packs) => { setPacks(next); setDraft(supplierId, next); };
  const set = (id: string, n: number) => { save({ ...packs, [id]: Math.max(0, n) }); clearTyped(id); setError(''); };
  const setText = (id: string, text: string) => { setTyped({ ...typed, [id]: text }); setPacks({ ...packs, [id]: parsePacks(text) ?? 0 }); setError(''); };
  /** A typed number is saved when its box is left, not on every key. */
  const commit = (id: string) => { if (id in typed) setDraft(supplierId, packs); };
  const remove = (id: string) => { const { [id]: _gone, ...rest } = packs; save(rest); clearTyped(id); setError(''); };
  /** Moves a line to another supplier's cart (which starts from its suggestions); the Undo brings it back here. */
  const move = (id: string, to: string, toStart: Packs) => {
    const before = packs;
    const { cart, undo } = moveToCart(id, supplierId, to, packs, toStart);
    setPacks(cart); clearTyped(id); setError('');
    return () => { undo(); setPacks(before); };
  };

  /** Adds to the orders that already have the item and places the rest; tells the caller what was made. */
  const act = (onPlaced: (placed: Placed, undo: () => void, done: boolean) => void) => {
    const placed: { p: Placed; undo: () => void }[] = [];
    const handled = new Set<string>();
    for (const a of plan.add) {
      const undo = addToOrder(a.order, a.lines);
      if (typeof undo === 'string') { setError(undo); break; }
      const order: PurchaseOrder = { ...a.order, lines: a.lines.map((l) => ({ itemId: l.itemId, packs: l.packs, stockQty: null, received: 0, remaining: l.packs })) };
      placed.push({ p: { order, added: true }, undo });
      a.lines.forEach((l) => handled.add(l.itemId));
    }
    if (plan.create.length > 0 && placed.length === plan.add.length) {
      const { order, undo } = placeOrder(supplierId, plan.create);
      placed.push({ p: { order, added: false }, undo });
      plan.create.forEach((l) => handled.add(l.itemId));
    }
    const rest = Object.fromEntries(Object.entries(packs).filter(([id]) => !handled.has(id)));
    setPacks(rest);
    // What was placed leaves the draft; Undo takes the order back and puts the draft back too.
    const restore = setDraft(supplierId, rest);
    placed.forEach(({ p, undo }, i) => onPlaced(p, () => { undo(); restore(); }, i === placed.length - 1 && Object.keys(rest).length === 0));
  };

  return { packs, typed, error, setError, lines, plan, blocked, totals, mainLabel, canAct, set, setText, commit, remove, move, act };
}
type Draft = ReturnType<typeof useDraft>;

const rs = (cents: number) => `Rs ${fmt(Math.round(cents))}`;

/**
 * The price of one pack on a bill line, typed over in place. Enter or leaving the box saves it as
 * the supplier's new price (audited, the same as the item's Order tab); Esc puts it back.
 */
function PriceCell({ row, onTyped, onSaved }: { row: InventoryRow; onTyped: (cents: number | null) => void; onSaved: (message: string, undo: () => void) => void }) {
  const shown = row.workingPriceCents > 0 ? fmt(row.workingPriceCents) : '';
  const [text, setText] = useState<string | null>(null);
  const reset = () => { setText(null); onTyped(null); };
  const save = () => {
    if (text === null) return;
    const cents = parseLKR(text);
    reset();
    if (cents === null || cents <= 0 || cents === row.workingPriceCents) return;
    const before = row.workingPriceCents;
    setWorkingPrice(row.id, cents);
    onSaved(`${row.name}: price now ${rs(cents)} a pack.`, () => setWorkingPrice(row.id, before));
  };
  return (
    <span className="price">
      <span className="price__rs" aria-hidden="true">Rs</span>
      <NumberInput decimals={2} className="price__num" aria-label={`Price of one pack of ${row.name}`} placeholder="0" value={text ?? shown}
        onText={(typed) => { setText(typed); const c = parseLKR(typed); onTyped(c !== null && c > 0 ? c : null); }}
        onFocus={(e) => e.currentTarget.select()} onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
          if (e.key === 'Escape') { e.preventDefault(); reset(); }
        }} />
    </span>
  );
}

/**
 * The draft as a bill: one line per item (name, quantity, price of one pack, line total) and the
 * total at the bottom. "+ Add item" opens the supplier's other items; a tap puts one on the bill
 * at 1 pack (change the qty on its line), and the list stays open for the next.
 */
function DraftItems({ supplierId, draft, items, suppliers, carts, onMoved }: {
  supplierId: string; draft: Draft; items: InventoryRow[]; suppliers: Supplier[];
  /** Every supplier's cart, for where a moved line lands. */
  carts: Map<string, Packs>;
  onMoved: (to: string) => void;
}) {
  const { packs, typed, plan, blocked, totals } = draft;
  const name = nameOf(suppliers, supplierId);
  const byId = new Map(items.map((i) => [i.id, i]));
  // What runs low first (at its suggested packs), then the rest of what this supplier sells.
  const low = (i: InventoryRow) => i.suggestedPacks > 0 && i.suggestedSupplierId === supplierId;
  const extra = items.filter((i) => i.supplierIds.includes(supplierId) && !(i.id in packs))
    .sort((a, b) => Number(low(b)) - Number(low(a)));
  /** The line whose other suppliers are being shown, to move it to one of their carts. */
  const [moving, setMoving] = useState<string | null>(null);
  const otherSuppliers = (row: InventoryRow) => suppliers.filter((s) => s.id !== supplierId && row.supplierIds.includes(s.id));
  const moveTo = (id: string, to: string) => {
    const undo = draft.move(id, to, carts.get(to) ?? {});
    setMoving(null);
    setPriced({ message: `${byId.get(id)?.name ?? 'It'}: moved to ${nameOf(suppliers, to)}'s cart.`, undo });
    onMoved(to);
  };
  /** The add-item list is open. It stays open, so several items go on one after another. */
  const [picking, setPicking] = useState(false);
  /** A price being typed (the line total follows it), and the last price saved, with Undo. */
  const [typing, setTyping] = useState<{ id: string; cents: number } | null>(null);
  const [priced, setPriced] = useState<{ message: string; undo: () => void } | null>(null);
  const priceOf = (row: InventoryRow) => (typing?.id === row.id ? typing.cents : row.workingPriceCents);
  const lines = Object.entries(packs).flatMap(([id, n]) => { const row = byId.get(id); return row ? [{ id, n, row }] : []; });

  return (
    <section className="flow__list" aria-label={`Order from ${name}`}>
      <table className="bill" aria-label={`To order from ${name}`}>
        <thead>
          <tr><th scope="col">Item</th><th scope="col" className="bill__qty">Qty</th><th scope="col" className="bill__num">Price</th><th scope="col" className="bill__num">Total</th><th scope="col"><span className="sr-only">Remove</span></th></tr>
        </thead>
        <tbody>
          {lines.length === 0 && (
            <tr><td colSpan={5} className="bill__empty">Nothing on it yet. Add what you need from {name}.</td></tr>
          )}
          {lines.map(({ id, n, row }) => {
            const on = plan.onOrder.get(id);
            const others = otherSuppliers(row);
            const why = row.suggestedPacks > 0 && row.usedPerDay > 0
              ? `${formatLasts(row.lastsDays) ? `${formatLasts(row.lastsDays)} · ` : ''}uses about ${formatQuantity(Math.round(row.usedPerDay), row.baseUnit)} a day` : '';
            return (
              <tr key={id}>
                <td>
                  <span className="bill__name">{row.name}</span>
                  <span className="bill__sub">{n} × {formatQuantity(row.packQty, row.baseUnit)} = {formatQuantity(n * row.packQty, row.baseUnit)}</span>
                  {why && <span className="bill__sub">{why}</span>}
                  {on && <span className="flow-card__tag">On order · {on}{blocked.has(id) ? ': partly received, wait for it or close it first' : ''}</span>}
                  {others.length === 1 && (
                    <button type="button" className="linkbtn bill__move" onClick={() => moveTo(id, others[0].id)}>Move to {others[0].name}'s cart</button>
                  )}
                  {others.length > 1 && (moving === id ? (
                    <span className="chips chips--tight" role="group" aria-label={`Move ${row.name} to`}>
                      {others.map((o) => <button key={o.id} type="button" className="chip" onClick={() => moveTo(id, o.id)}>{o.name}</button>)}
                    </span>
                  ) : (
                    <button type="button" className="linkbtn bill__move" onClick={() => setMoving(id)}>Move to another cart</button>
                  ))}
                </td>
                <td className="bill__qty">
                  <span className="qty">
                    <button type="button" className="qty__btn" aria-label={`One pack less of ${row.name}`} onClick={() => draft.set(id, Math.max(1, n - 1))}>−</button>
                    <NumberInput className="qty__num" aria-label={`Packs of ${row.name}`} value={typed[id] ?? String(n)}
                      onText={(text) => draft.setText(id, text)} onBlur={() => draft.commit(id)} onFocus={(e) => e.currentTarget.select()} />
                    <button type="button" className="qty__btn" aria-label={`One pack more of ${row.name}`} onClick={() => draft.set(id, n + 1)}>+</button>
                  </span>
                </td>
                <td className="bill__num">
                  <PriceCell row={row} onTyped={(cents) => setTyping(cents === null ? null : { id, cents })} onSaved={(message, undo) => setPriced({ message, undo })} />
                </td>
                <td className="bill__num num" aria-label={`Total for ${row.name}`}>{priceOf(row) > 0 ? rs(n * priceOf(row)) : '—'}</td>
                <td className="bill__x"><button type="button" className="qty__btn qty__btn--x" aria-label={`Remove ${row.name}`} onClick={() => draft.remove(id)}>×</button></td>
              </tr>
            );
          })}
          {/* Add the next line right under the last one; the list opens in place, so nothing covers the total. */}
          {(extra.length > 0 || lines.length > 0) && (
            <tr className="bill__addrow">
              <td colSpan={5}>
                {extra.length === 0 ? <span className="bill__sub">Everything {name} sells is on it.</span> : (
                  <div className="bill-add" onKeyDown={(e) => { if (e.key === 'Escape' && picking) { e.preventDefault(); setPicking(false); } }}>
                    <button type="button" className="bill-add__btn" aria-expanded={picking} aria-label={`Add an item from ${name}`} onClick={() => setPicking(!picking)}>+ Add item</button>
                    {picking && (
                      <ul className="bill-add__menu" aria-label={`Items from ${name}`}>
                        {extra.map((i) => (
                          <li key={i.id}>
                            <button type="button" className="bill-add__item" onClick={() => draft.set(i.id, low(i) ? i.suggestedPacks : 1)}>
                              <span>{i.name}</span>
                              <span className="bill__sub num">
                                {low(i) ? `Low · ${i.suggestedPacks} suggested` : i.workingPriceCents > 0 ? `${rs(i.workingPriceCents)} a pack` : formatQuantity(i.packQty, i.baseUnit)}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={3} className="bill__sum">{totals.items} {word(totals.items, 'item', 'items')} · {totals.packs} {word(totals.packs, 'pack', 'packs')}</th>
            <td colSpan={2} className="bill__num bill__grand num" aria-label="Order total">{rs(totals.cents)}</td>
          </tr>
        </tfoot>
      </table>
      {priced && (
        <p className="bill__said" role="status">
          {priced.message}
          <button type="button" className="linkbtn" onClick={() => { priced.undo(); setPriced(null); }}>Undo</button>
        </p>
      )}
    </section>
  );
}

/**
 * A PO just placed (or lines just added to one): its message in a box, ready and editable
 * ("deliver before 10"), and WhatsApp as the one thing to do: it sends what is in the box.
 * The edit is only for sending, never saved.
 */
export function PlacedOrder({ placed: { order, added }, items, suppliers }: { placed: Placed; items: InventoryRow[]; suppliers: Supplier[] }) {
  const name = nameOf(suppliers, order.supplierId);
  const supplier = suppliers.find((s) => s.id === order.supplierId);
  const phone = supplier?.phone;
  /** No number yet: the supplier's own Edit, here, so the message waits while it is added. */
  const [addingPhone, setAddingPhone] = useState(false);
  const generated = orderMessage(order.lines.flatMap((l) => {
    const row = items.find((i) => i.id === l.itemId);
    return row ? [{ name: row.name, packs: l.packs, packQty: row.packQty, baseUnit: row.baseUnit, unit: receiveUnitOf(row) }] : [];
  }), 'CheesyBeez', added ? `Hi, this is CheesyBeez. Please add to ${isPending(order.poNo) ? 'our order' : order.poNo}:` : undefined);
  const [text, setText] = useState(generated);

  return (
    <section className="flow__list" aria-label={`${order.poNo} ${name}`}>
      <InfoCard name={added ? `Added to ${order.poNo}` : `${order.poNo} placed`} line={name} tone="ok" />
      <textarea className="order__message" aria-label="Message" rows={text.split('\n').length + 1} value={text}
        onChange={(e) => setText(e.target.value)} />
      {phone ? (
        <a className="flow-card flow-card--tap flow-card--wa" href={whatsAppLink(phone, text)} target="_blank" rel="noreferrer">
          <span className="flow-card__text"><span className="flow-card__name">Send on WhatsApp</span><span className="flow-card__line">{phone}</span></span>
        </a>
      ) : (
        <p className="flow-hint">
          No phone saved for {name}.
          {supplier && <> <button type="button" className="linkbtn" onClick={() => setAddingPhone(true)}>Add phone</button></>}
        </p>
      )}
      {addingPhone && supplier && (
        <AddSupplierModal supplier={supplier} focus="phone" onClose={() => setAddingPhone(false)} onSave={editSupplier} />
      )}
      {text !== generated && <button type="button" className="linkbtn" onClick={() => setText(generated)}>Reset</button>}
    </section>
  );
}

const STATUS_WORDS = { open: 'Open', partly: 'Partly received', closed: 'Closed', cancelled: 'Cancelled' } as const;

/**
 * One open order: a short row (number, supplier, status, when) that opens in place. Open, it is
 * the whole order as a bill (agreed price, what came so far, the total); until goods come the
 * quantities change right there, Save appears once something changed, and Cancel takes a reason.
 */
function OnOrderRow({ order, items, suppliers, open, onToggle, onDone }: {
  order: PurchaseOrder; items: InventoryRow[]; suppliers: Supplier[]; open: boolean; onToggle: () => void; onDone: Done;
}) {
  /** The changed quantities; null while nothing changed. */
  const [editing, setEditing] = useState<Packs | null>(null);
  const [why, setWhy] = useState(false);
  const [error, setError] = useState('');
  const byId = new Map(items.map((i) => [i.id, i]));
  const nameFor = (id: string) => byId.get(id)?.name ?? id;
  const packs: Packs = editing ?? Object.fromEntries(order.lines.map((l) => [l.itemId, l.packs]));
  const lineOf = new Map(order.lines.map((l) => [l.itemId, l]));
  const priceOf = (id: string) => lineOf.get(id)?.unitPriceCents ?? byId.get(id)?.workingPriceCents ?? 0;
  const total = Object.entries(packs).reduce((sum, [id, n]) => sum + n * priceOf(id), 0);
  const count = Object.keys(packs).length;
  const panel = `po-${order.id}`;
  const change = (next: Packs) => { setEditing(next); setError(''); };
  const reset = () => { setEditing(null); setWhy(false); setError(''); };

  const save = () => {
    if (!editing) return;
    const result = editOrder(order, Object.entries(editing).map(([itemId, n]) => ({ itemId, packs: n })));
    if (typeof result === 'string') return setError(result);
    reset();
    onDone(`${order.poNo} changed.`, result);
  };

  return (
    <li className={`row row--stack po${open ? ' po--open' : ''}${order.status === 'partly' ? ' row--warn' : ''}`}
      onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); reset(); onToggle(); } }}>
      <button type="button" className="po__head" aria-expanded={open} aria-controls={panel} onClick={() => { if (open) reset(); onToggle(); }}>
        <span className="flow-card__text">
          <span className="row__name">{order.poNo} · {nameOf(suppliers, order.supplierId)} <span className="flow-card__tag">{STATUS_WORDS[order.status]}</span></span>
          <span className="flow-card__line">Placed {daysAgo(order.at, Date.now())}{open ? ` by ${order.actor.name}` : ''}</span>
        </span>
        <span className="po__chev" aria-hidden="true">›</span>
      </button>
      {open && (
        <div id={panel} className="po__body">
          <table className="bill" aria-label={`Lines of ${order.poNo}`}>
            <thead>
              <tr><th scope="col">Item</th><th scope="col" className="bill__qty">Qty</th><th scope="col" className="bill__num">Price</th><th scope="col" className="bill__num">Total</th>{order.editable && <th scope="col"><span className="sr-only">Remove</span></th>}</tr>
            </thead>
            <tbody>
              {Object.entries(packs).map(([id, n]) => {
                const received = lineOf.get(id)?.received ?? 0;
                return (
                  <tr key={id}>
                    <td>
                      <span className="bill__name">{nameFor(id)}</span>
                      {received > 0 && <span className="bill__sub">{received} of {n} received</span>}
                    </td>
                    <td className="bill__qty">
                      {order.editable ? (
                        <span className="qty">
                          <button type="button" className="qty__btn" aria-label={`One pack less of ${nameFor(id)} on ${order.poNo}`} onClick={() => change({ ...packs, [id]: Math.max(1, n - 1) })}>−</button>
                          <NumberInput className="qty__num" aria-label={`Packs of ${nameFor(id)} on ${order.poNo}`} value={String(n)}
                            onText={(text) => change({ ...packs, [id]: parsePacks(text) ?? 0 })} onFocus={(e) => e.currentTarget.select()} />
                          <button type="button" className="qty__btn" aria-label={`One pack more of ${nameFor(id)} on ${order.poNo}`} onClick={() => change({ ...packs, [id]: n + 1 })}>+</button>
                        </span>
                      ) : <span className="num">{n}</span>}
                    </td>
                    <td className="bill__num num">{priceOf(id) > 0 ? rs(priceOf(id)) : '—'}</td>
                    <td className="bill__num num">{priceOf(id) > 0 ? rs(n * priceOf(id)) : '—'}</td>
                    {order.editable && (
                      <td className="bill__x">
                        <button type="button" className="qty__btn qty__btn--x" aria-label={`Remove ${nameFor(id)} from ${order.poNo}`}
                          onClick={() => { const { [id]: _gone, ...rest } = packs; change(rest); }}>×</button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={2} className="bill__sum">{count} {word(count, 'item', 'items')}</th>
                <td colSpan={order.editable ? 3 : 2} className="bill__num bill__grand num" aria-label={`${order.poNo} total`}>{rs(total)}</td>
              </tr>
            </tfoot>
          </table>
          {error && <p className="reason-msg" role="alert">{error}</p>}
          {!order.editable && <p className="flow-hint">Goods came: finish it with <a href="#receive">GRN</a>.</p>}
          {order.editable && editing && (
            <div className="flow__row">
              <button type="button" className="linkbtn" onClick={() => { setEditing(null); setError(''); }}>Keep as it was</button>
              <button type="button" className="chip chip--solid" aria-label={`Save ${order.poNo}`} onClick={save}>Save changes</button>
            </div>
          )}
          {order.editable && !editing && !why && (
            <button type="button" className="linkbtn po__cancel" aria-label={`Cancel ${order.poNo}`} onClick={() => setWhy(true)}>Cancel order</button>
          )}
          {order.editable && why && !editing && (
            <div role="group" aria-label={`Why cancel ${order.poNo}`} className="po-why">
              {CANCEL_REASONS.map((r) => (
                <ChoiceCard key={r} name={r} onClick={() => onDone(`${order.poNo} cancelled.`, cancelOrder(order.id, r))} />
              ))}
              <button type="button" className="linkbtn" onClick={() => setWhy(false)}>Don't cancel</button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** Open orders, awaiting goods: one open at a time. */
function OnOrder({ orders, items, suppliers, onDone }: { orders: PurchaseOrder[]; items: InventoryRow[]; suppliers: Supplier[]; onDone: Done }) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (orders.length === 0) return null;
  return (
    <section aria-label="On order" className="flow__list">
      <p className="flow-hint">On order</p>
      <ul className="rows flow__plain">
        {orders.map((o) => (
          <OnOrderRow key={o.id} order={o} items={items} suppliers={suppliers} open={openId === o.id}
            onToggle={() => setOpenId(openId === o.id ? null : o.id)} onDone={onDone} />
        ))}
      </ul>
    </section>
  );
}

/** A supplier in a list: the + at the end starts an order with them; the row itself is only text. */
function SupplierRow({ name, line, tone, label, onAdd }: { name: string; line?: string; tone?: 'warn'; label: string; onAdd: () => void }) {
  return (
    <li className={`row${tone ? ` row--${tone}` : ''}`}>
      <span className="flow-card__text row__text">
        <span className="row__name">{name}</span>
        {line && <span className="flow-card__line">{line}</span>}
      </span>
      <button type="button" className="row__add" aria-label={label} onClick={onAdd}>+</button>
    </li>
  );
}

type Step = 'who' | 'what' | 'send';

export function OrderSheet({ items, suppliers, purchases, inline = false, initialSupplier, onClose, onDone }: {
  items: InventoryRow[];
  suppliers: Supplier[];
  purchases: PurchaseState;
  /** In the Order page itself, not a sheet over it. */
  inline?: boolean;
  /** Opens straight on this supplier's cart (#order/<supplier id>). */
  initialSupplier?: string;
  onClose: () => void;
  onDone: Done;
}) {
  const suggested = useMemo(() => cartsNow(items, purchases), [items, purchases]);
  const opening = initialSupplier && suppliers.some((s) => s.id === initialSupplier) ? initialSupplier : null;
  const [step, setStep] = useState<Step>(opening ? 'what' : 'who');
  /** The supplier being ordered from, and the cart the person starts from. */
  const [supplierId, setSupplierId] = useState<string | null>(opening);
  const [start, setStart] = useState<Packs>(() => (opening ? suggested.get(opening) ?? {} : {}));
  /** Suppliers already ordered from in this visit, and what was placed (for the Send step). */
  const [finished, setFinished] = useState<string[]>([]);
  const [placed, setPlaced] = useState<Placed[]>([]);

  const withItems = suppliers.filter((s) => items.some((i) => i.supplierIds.includes(s.id)));
  const waiting = withItems.filter((s) => suggested.has(s.id) && !finished.includes(s.id));
  const others = withItems.filter((s) => !suggested.has(s.id) || finished.includes(s.id));
  const choose = (id: string) => { setSupplierId(id); setStart(suggested.get(id) ?? {}); setPlaced([]); setStep('what'); };
  const toWho = () => { setStep('who'); setSupplierId(null); setPlaced([]); };

  const total = waiting.length + finished.filter((id) => suggested.has(id)).length;

  if ((step === 'what' || step === 'send') && supplierId) {
    return (
      <WhatStep key={supplierId} inline={inline} step={step} supplierId={supplierId} start={start} items={items} suppliers={suppliers} purchases={purchases}
        placed={placed} moreSuppliers={waiting.filter((s) => s.id !== supplierId).length} onClose={onClose} onBack={toWho}
        onPlaced={(p, undo, done) => {
          setPlaced((all) => [...all, p]);
          onDone(placedText(p, suppliers), undo);
          if (done) setFinished((f) => [...f, supplierId]);
          setStep('send'); // the message is to be sent either way
        }}
        onNext={() => { const next = waiting.find((s) => s.id !== supplierId); if (next) choose(next.id); else toWho(); }}
        onOpen={choose} />
    );
  }

  return (
    <FlowSheet title="Purchase orders" inline={inline} onClose={onClose}
      step={total > 1 ? { index: 1, of: 3, label: `${finished.filter((id) => suggested.has(id)).length} of ${total} suppliers done` } : { index: 1, of: 3, label: 'Who?' }}
      >
      <RejectionNotices />
      {/* What is already on order comes first: the person sees it before ordering more. */}
      <OnOrder orders={purchases.open} items={items} suppliers={suppliers} onDone={onDone} />
      {waiting.length === 0 && <p className="flow-hint">{finished.length > 0 ? 'All done. Everything that needed ordering has been ordered.' : 'Nothing needs ordering now.'}</p>}
      {waiting.length > 0 && (
        <section className="flow__list">
          <p className="flow-hint">Carts</p>
          <ul role="group" aria-label="Suppliers that need ordering" className="rows flow__plain">
            {waiting.map((s) => {
              const n = Object.keys(suggested.get(s.id) ?? {}).length;
              const line = purchases.drafts.has(s.id) ? `Cart · ${n} ${word(n, 'item', 'items')}` : `${n} low ${word(n, 'item', 'items')}`;
              return <SupplierRow key={s.id} name={s.name} line={line} tone="warn" label={`Order from ${s.name}`} onAdd={() => choose(s.id)} />;
            })}
          </ul>
        </section>
      )}
      {others.length > 0 && (
        <section className="flow__list">
          <p className="flow-hint">{waiting.length > 0 ? 'Other suppliers' : 'Suppliers'}: + to start a cart</p>
          <ul role="group" aria-label="Order from another supplier" className="rows flow__plain">
            {others.map((s) => <SupplierRow key={s.id} name={s.name} label={`+ ${s.name}`} onAdd={() => choose(s.id)} />)}
          </ul>
        </section>
      )}
    </FlowSheet>
  );
}

/** Steps 2 and 3 for one supplier: what to order, then sending it. */
function WhatStep({ inline, step, supplierId, start, items, suppliers, purchases, placed, moreSuppliers, onClose, onBack, onPlaced, onNext, onOpen }: {
  inline: boolean;
  step: 'what' | 'send';
  supplierId: string;
  start: Packs;
  items: InventoryRow[];
  suppliers: Supplier[];
  purchases: PurchaseState;
  placed: Placed[];
  moreSuppliers: number;
  onClose: () => void;
  onBack: () => void;
  onPlaced: (p: Placed, undo: () => void, done: boolean) => void;
  onNext: () => void;
  /** Opens another supplier's cart (after a line was moved there). */
  onOpen: (supplierId: string) => void;
}) {
  const draft = useDraft(supplierId, start, items, purchases);
  const carts = cartsNow(items, purchases);
  const [movedTo, setMovedTo] = useState<string | null>(null);
  const name = nameOf(suppliers, supplierId);

  if (step === 'send') {
    return (
      <FlowSheet title="Purchase orders" sub={name} inline={inline} step={{ index: 3, of: 3, label: 'Send' }} onClose={onClose}
        primary={{ label: moreSuppliers > 0 ? 'Next supplier' : 'Done', onClick: moreSuppliers > 0 ? onNext : onClose }}>
        <RejectionNotices />
        {placed.map((p, i) => <PlacedOrder key={`${p.order.id}-${i}`} placed={p} items={items} suppliers={suppliers} />)}
      </FlowSheet>
    );
  }
  return (
    <FlowSheet title="Purchase orders" sub={name} inline={inline} step={{ index: 2, of: 3, label: 'What to order' }} onClose={onClose} onBack={onBack} error={draft.error}
      primary={{ label: draft.mainLabel, onClick: () => draft.act(onPlaced), disabled: !draft.canAct }}>
      <RejectionNotices />
      <DraftItems supplierId={supplierId} draft={draft} items={items} suppliers={suppliers} carts={carts} onMoved={setMovedTo} />
      {movedTo && (
        <button type="button" className="linkbtn" onClick={() => onOpen(movedTo)}>Open {nameOf(suppliers, movedTo)}'s cart</button>
      )}
    </FlowSheet>
  );
}

/**
 * The item sheet's Order tab: only puts the item in a supplier's cart. What it is on order with
 * and which cart it is in are said in one line each; changing them is on the Order page.
 */
export function ItemOrder({ item, items, suppliers, purchases }: {
  item: InventoryRow;
  items: InventoryRow[];
  suppliers: Supplier[];
  purchases: PurchaseState;
}) {
  const sources = suppliers.filter((s) => item.supplierIds.includes(s.id));
  const last = purchases.lastSupplier.get(item.id);
  const first = item.suggestedSupplierId ?? (sources.some((s) => s.id === last) ? last : sources[0]?.id) ?? null;
  const [supplierId, setSupplierId] = useState(first);
  const [said, setSaid] = useState<{ message: string; to: string; undo: () => void } | null>(null);
  const open = purchases.open.filter((o) => o.lines.some((l) => l.itemId === item.id));
  const carts = cartsNow(items, purchases);
  const inCart = cartOf(carts, item.id);

  if (!supplierId) return <p className="flow-hint">No active supplier for {item.name}. Add one on <a href="#suppliers">Suppliers</a>.</p>;
  return (
    <section className="flow__list item-order" aria-label={`Order ${item.name}`}>
      {open.map((o) => {
        const packs = o.lines.filter((l) => l.itemId === item.id).reduce((n, l) => n + l.remaining, 0);
        return (
          <p key={o.id} className="item-order__line">
            On order: {packs} {word(packs, 'pack', 'packs')} · {o.poNo} · {nameOf(suppliers, o.supplierId)}
          </p>
        );
      })}
      {said ? (
        <p className="bill__said" role="status">
          {said.message}
          <button type="button" className="linkbtn" onClick={() => { said.undo(); setSaid(null); }}>Undo</button>
          <a className="linkbtn" href={`#order/${said.to}`}>Open cart</a>
        </p>
      ) : inCart ? (
        <p className="item-order__line">
          In {nameOf(suppliers, inCart)}'s cart · {carts.get(inCart)![item.id]} {word(carts.get(inCart)![item.id], 'pack', 'packs')}
          {' '}<a className="linkbtn" href={`#order/${inCart}`}>Open cart</a>
        </p>
      ) : (
        <>
          {sources.length > 1 && (
            <div className="chips" role="group" aria-label="Supplier">
              {sources.map((s) => (
                <button key={s.id} type="button" className="chip" aria-pressed={s.id === supplierId} onClick={() => setSupplierId(s.id)}>{s.name}</button>
              ))}
            </div>
          )}
          <AddToCart key={supplierId} item={item} supplierId={supplierId} name={nameOf(suppliers, supplierId)} start={carts.get(supplierId) ?? {}}
            onAdded={(message, undo) => setSaid({ message, to: supplierId, undo })} />
        </>
      )}
    </section>
  );
}

/** This item's packs and "Add to cart", on one row. */
function AddToCart({ item, supplierId, name, start, onAdded }: {
  item: InventoryRow; supplierId: string; name: string; start: Packs; onAdded: (message: string, undo: () => void) => void;
}) {
  const [text, setText] = useState(String(Math.max(1, item.suggestedSupplierId === supplierId ? item.suggestedPacks : 0)));
  const n = parsePacks(text) ?? 0;
  const add = () => {
    const { draft, undo } = addToDraft(supplierId, item.id, n, start);
    const count = Object.keys(draft).length;
    onAdded(`Added to ${name}'s cart · ${count} ${word(count, 'item', 'items')}.`, undo);
  };
  return (
    <div className="item-order__add">
      <BigStepper compact value={text} unit={word(n, 'pack', 'packs')} label={`Packs of ${item.name}`}
        lessLabel={`One pack less of ${item.name}`} moreLabel={`One pack more of ${item.name}`}
        onText={setText} onBump={(by) => setText(String(Math.max(1, n + by)))} />
      <button type="button" className="cta" disabled={!(n > 0)} onClick={add}>Add to cart</button>
    </div>
  );
}
