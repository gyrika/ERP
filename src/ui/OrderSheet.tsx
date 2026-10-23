import { useMemo, useState } from 'react';
import type { Supplier } from '../domain/inventoryData.ts';
import { isPending } from '../domain/docNumbers.ts';
import { parsePacks } from '../domain/inventory.ts';
import { draftsOf, orderMessage, whatsAppLink } from '../domain/ordering.ts';
import { fmt } from '../domain/money.ts';
import { CANCEL_REASONS, orderTotals, planOrder, type PurchaseOrder, type PurchaseState } from '../domain/purchaseOrders.ts';
import type { PoLine } from '../domain/sync.ts';
import { formatLasts, formatQuantity } from './quantity.ts';
import { BigStepper } from './flow/BigStepper.tsx';
import { ChoiceCard, InfoCard } from './flow/ChoiceCard.tsx';
import { FlowSheet } from './flow/FlowSheet.tsx';
import { RejectionNotices } from './Rejections.tsx';
import { addToOrder, cancelOrder, editOrder, placeOrder, type InventoryRow } from '../services/inventoryStore.ts';

/**
 * Purchase orders: the one way to order, one step at a time (src/ui/flow):
 *   0 On order, at the top: the open orders, to edit or cancel with a reason until goods come
 *   1 Who?   a big card per supplier with how many items need ordering ("Prima · 3 to order")
 *   2 What?  that supplier's items as a bill (item, qty, price, total), the suggested packs already
 *            in, "+ Add item" to add more, the total at the bottom, and one main button: Place order (or Add to PO-0003, which
 *            `planOrder` chooses so an item is never on two orders)
 *   3 Send   the message, WhatsApp as the big thing to do; then the next supplier, or Done
 * The item sheet's Order tab is the same step 2 (ItemOrder), started from that item.
 */
type Packs = Record<string, number>;
type Done = (message: string, undo: () => void) => void;
/** An order just made here, or lines just added to one (message: only the added lines). */
interface Placed { order: PurchaseOrder; added: boolean }

const nameOf = (suppliers: Supplier[], id: string) => suppliers.find((s) => s.id === id)?.name ?? 'Supplier';
const word = (n: number, one: string, many: string) => (n === 1 ? one : many);
const placedText = (p: Placed, suppliers: Supplier[]) => (p.added ? `Added to ${p.order.poNo}.` : `${p.order.poNo} placed with ${nameOf(suppliers, p.order.supplierId)}.`);

/**
 * One supplier's draft: packs per item (typed or stepped), items added or removed, what the
 * order comes to, and the one action that does everything the draft shows. Used by the
 * "What?" step and by the item sheet's Order tab.
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
  const set = (id: string, n: number) => { setPacks({ ...packs, [id]: Math.max(0, n) }); clearTyped(id); setError(''); };
  const setText = (id: string, text: string) => { setTyped({ ...typed, [id]: text }); setPacks({ ...packs, [id]: parsePacks(text) ?? 0 }); setError(''); };
  const remove = (id: string) => { const { [id]: _gone, ...rest } = packs; setPacks(rest); clearTyped(id); setError(''); };

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
    placed.forEach(({ p, undo }, i) => onPlaced(p, undo, i === placed.length - 1 && Object.keys(rest).length === 0));
  };

  return { packs, typed, error, setError, lines, plan, blocked, totals, mainLabel, canAct, set, setText, remove, act };
}
type Draft = ReturnType<typeof useDraft>;

const rs = (cents: number) => `Rs ${fmt(Math.round(cents))}`;

/**
 * The draft as a bill: one line per item (name, quantity, price of one pack, line total) and the
 * total at the bottom. "+ Add item" opens the supplier's other items; a tap puts one on the bill
 * at 1 pack (change the qty on its line), and the list stays open for the next.
 */
function DraftItems({ supplierId, draft, items, suppliers }: { supplierId: string; draft: Draft; items: InventoryRow[]; suppliers: Supplier[] }) {
  const { packs, typed, plan, blocked, totals } = draft;
  const name = nameOf(suppliers, supplierId);
  const byId = new Map(items.map((i) => [i.id, i]));
  const extra = items.filter((i) => i.supplierIds.includes(supplierId) && !(i.id in packs));
  /** The add-item list is open. It stays open, so several items go on one after another. */
  const [picking, setPicking] = useState(false);
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
            const why = row.suggestedPacks > 0 && row.usedPerDay > 0
              ? `${formatLasts(row.lastsDays) ? `${formatLasts(row.lastsDays)} · ` : ''}uses about ${formatQuantity(Math.round(row.usedPerDay), row.baseUnit)} a day` : '';
            return (
              <tr key={id}>
                <td>
                  <span className="bill__name">{row.name}</span>
                  <span className="bill__sub">{n} × {formatQuantity(row.packQty, row.baseUnit)} = {formatQuantity(n * row.packQty, row.baseUnit)}</span>
                  {why && <span className="bill__sub">{why}</span>}
                  {on && <span className="flow-card__tag">On order · {on}{blocked.has(id) ? ': partly received, wait for it or close it first' : ''}</span>}
                </td>
                <td className="bill__qty">
                  <span className="qty">
                    <button type="button" className="qty__btn" aria-label={`One pack less of ${row.name}`} onClick={() => draft.set(id, Math.max(1, n - 1))}>−</button>
                    <input className="qty__num num" inputMode="decimal" aria-label={`Packs of ${row.name}`} value={typed[id] ?? String(n)}
                      onChange={(e) => draft.setText(id, e.target.value)} onFocus={(e) => e.currentTarget.select()} />
                    <button type="button" className="qty__btn" aria-label={`One pack more of ${row.name}`} onClick={() => draft.set(id, n + 1)}>+</button>
                  </span>
                </td>
                <td className="bill__num num">{row.workingPriceCents > 0 ? rs(row.workingPriceCents) : '—'}</td>
                <td className="bill__num num" aria-label={`Total for ${row.name}`}>{row.workingPriceCents > 0 ? rs(n * row.workingPriceCents) : '—'}</td>
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
                            <button type="button" className="bill-add__item" onClick={() => draft.set(i.id, 1)}>
                              <span>{i.name}</span>
                              <span className="bill__sub num">{i.workingPriceCents > 0 ? `${rs(i.workingPriceCents)} a pack` : formatQuantity(i.packQty, i.baseUnit)}</span>
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
    </section>
  );
}

/** A PO just placed (or lines just added to one): its message, and WhatsApp as the big thing to do. */
export function PlacedOrder({ placed: { order, added }, items, suppliers }: { placed: Placed; items: InventoryRow[]; suppliers: Supplier[] }) {
  const name = nameOf(suppliers, order.supplierId);
  const phone = suppliers.find((s) => s.id === order.supplierId)?.phone;
  const text = orderMessage(order.lines.flatMap((l) => {
    const row = items.find((i) => i.id === l.itemId);
    return row ? [{ name: row.name, packs: l.packs, packQty: row.packQty, baseUnit: row.baseUnit }] : [];
  }), 'CheesyBeez', added ? `Hi, this is CheesyBeez. Please add to ${isPending(order.poNo) ? 'our order' : order.poNo}:` : undefined);
  return (
    <section className="flow__list" aria-label={`${order.poNo} ${name}`}>
      <InfoCard name={added ? `Added to ${order.poNo}` : `${order.poNo} placed`} line={name} tone="ok" />
      <pre className="order__message" aria-label="Message">{text}</pre>
      {phone ? (
        <>
          <a className="flow-card flow-card--tap flow-card--wa" href={whatsAppLink(phone, text)} target="_blank" rel="noreferrer">
            <span className="flow-card__text"><span className="flow-card__name">Send on WhatsApp</span><span className="flow-card__line">{phone}</span></span>
          </a>
          <a className="linkbtn" href={`tel:${phone}`}>Call {phone}</a>
        </>
      ) : (
        <p className="flow-hint">No phone saved for {name}. Add it on <a href="#suppliers">Suppliers</a>.</p>
      )}
      <button type="button" className="linkbtn" onClick={() => { void navigator.clipboard?.writeText(text).catch(() => {}); }}>Copy message</button>
    </section>
  );
}

const STATUS_WORDS = { open: 'Open', partly: 'Partly received', closed: 'Closed', cancelled: 'Cancelled' } as const;

/** One open order: its status and lines; Edit and Cancel (with a reason) until goods are received. */
function OnOrderRow({ order, items, suppliers, onDone }: { order: PurchaseOrder; items: InventoryRow[]; suppliers: Supplier[]; onDone: Done }) {
  const [editing, setEditing] = useState<Packs | null>(null);
  const [why, setWhy] = useState(false);
  const [error, setError] = useState('');
  const nameFor = (id: string) => items.find((i) => i.id === id)?.name ?? id;

  const save = () => {
    if (!editing) return;
    const result = editOrder(order, Object.entries(editing).map(([itemId, packs]) => ({ itemId, packs })));
    if (typeof result === 'string') return setError(result);
    setEditing(null);
    setError('');
    onDone(`${order.poNo} changed.`, result);
  };

  const actions = !order.editable ? null : editing ? null : why ? null : (
    <span className="po-card__actions">
      <button type="button" className="linkbtn" aria-label={`Edit ${order.poNo}`} onClick={() => setEditing(Object.fromEntries(order.lines.map((l) => [l.itemId, l.packs])))}>Edit</button>
      <button type="button" className="linkbtn" aria-label={`Cancel ${order.poNo}`} onClick={() => setWhy(true)}>Cancel</button>
    </span>
  );
  return (
    <li className={`row row--stack${order.status === 'partly' ? ' row--warn' : ''}`}>
      <div className="po-card">
        <span className="flow-card__text">
          <span className="row__name">{order.poNo} · {nameOf(suppliers, order.supplierId)} <span className="flow-card__tag">{STATUS_WORDS[order.status]}</span></span>
          {!editing && <span className="flow-card__line">{order.lines.map((l) => `${l.packs} × ${nameFor(l.itemId)}${l.received > 0 ? ` (${l.received} received)` : ''}`).join(', ')}</span>}
          {!order.editable && <span className="flow-card__line">Goods came: finish it with GRN.</span>}
        </span>
        {actions}
      </div>
      {editing && (
        <ul className="flow__list flow__plain" aria-label={`Change ${order.poNo}`}>
          {Object.entries(editing).map(([id, n]) => (
            <li key={id} className="flow-card flow-card--item">
              <span className="flow-card__text">
                <span className="flow-card__name">{nameFor(id)}</span>
                <button type="button" className="linkbtn" aria-label={`Remove ${nameFor(id)} from ${order.poNo}`}
                  onClick={() => { const { [id]: _gone, ...rest } = editing; setEditing(rest); }}>Remove</button>
              </span>
              <BigStepper compact value={String(n)} unit={word(n, 'pack', 'packs')} label={`Packs of ${nameFor(id)} on ${order.poNo}`}
                lessLabel={`One pack less of ${nameFor(id)} on ${order.poNo}`} moreLabel={`One pack more of ${nameFor(id)} on ${order.poNo}`}
                onText={(text) => setEditing({ ...editing, [id]: parsePacks(text) ?? 0 })} onBump={(by) => setEditing({ ...editing, [id]: Math.max(1, n + by) })} />
            </li>
          ))}
        </ul>
      )}
      {error && <p className="reason-msg" role="alert">{error}</p>}
      {editing && (
        <div className="flow__row">
          <button type="button" className="linkbtn" onClick={() => { setEditing(null); setError(''); }}>Keep as it was</button>
          <button type="button" className="chip chip--solid" aria-label={`Save ${order.poNo}`} onClick={save}>Save changes</button>
        </div>
      )}
      {why && !editing && (
        <div role="group" aria-label={`Why cancel ${order.poNo}`} className="po-why">
          {CANCEL_REASONS.map((r) => (
            <ChoiceCard key={r} name={r} onClick={() => onDone(`${order.poNo} cancelled.`, cancelOrder(order.id, r))} />
          ))}
          <button type="button" className="linkbtn" onClick={() => setWhy(false)}>Don't cancel</button>
        </div>
      )}
    </li>
  );
}

/** Open orders, awaiting goods. */
function OnOrder({ orders, items, suppliers, onDone }: { orders: PurchaseOrder[]; items: InventoryRow[]; suppliers: Supplier[]; onDone: Done }) {
  if (orders.length === 0) return null;
  return (
    <section aria-label="On order" className="flow__list">
      <p className="flow-hint">On order</p>
      <ul className="rows flow__plain">
        {orders.map((o) => <OnOrderRow key={o.id} order={o} items={items} suppliers={suppliers} onDone={onDone} />)}
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

export function OrderSheet({ items, suppliers, purchases, inline = false, onClose, onDone }: {
  items: InventoryRow[];
  suppliers: Supplier[];
  purchases: PurchaseState;
  /** In the Order page itself, not a sheet over it. */
  inline?: boolean;
  onClose: () => void;
  onDone: Done;
}) {
  const suggested = useMemo(() => draftsOf(items), [items]);
  const [step, setStep] = useState<Step>('who');
  /** The supplier being ordered from, and the draft the person starts from. */
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [start, setStart] = useState<Packs>({});
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
        onNext={() => { const next = waiting.find((s) => s.id !== supplierId); if (next) choose(next.id); else toWho(); }} />
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
          <p className="flow-hint">Needs ordering</p>
          <ul role="group" aria-label="Suppliers that need ordering" className="rows flow__plain">
            {waiting.map((s) => {
              const n = Object.keys(suggested.get(s.id) ?? {}).length;
              return <SupplierRow key={s.id} name={s.name} line={`${n} to order`} tone="warn" label={`Order from ${s.name}`} onAdd={() => choose(s.id)} />;
            })}
          </ul>
        </section>
      )}
      {others.length > 0 && (
        <section className="flow__list">
          <p className="flow-hint">{waiting.length > 0 ? 'Other suppliers' : 'Suppliers'}: + to choose the items yourself</p>
          <ul role="group" aria-label="Order from another supplier" className="rows flow__plain">
            {others.map((s) => <SupplierRow key={s.id} name={s.name} label={`+ ${s.name}`} onAdd={() => choose(s.id)} />)}
          </ul>
        </section>
      )}
    </FlowSheet>
  );
}

/** Steps 2 and 3 for one supplier: what to order, then sending it. */
function WhatStep({ inline, step, supplierId, start, items, suppliers, purchases, placed, moreSuppliers, onClose, onBack, onPlaced, onNext }: {
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
}) {
  const draft = useDraft(supplierId, start, items, purchases);
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
      <DraftItems supplierId={supplierId} draft={draft} items={items} suppliers={suppliers} />
    </FlowSheet>
  );
}

/**
 * The item sheet's Order tab: the same "what to order", started from this item (its suggested
 * packs, else one), with its supplier's other items that need ordering. Already on an open PO:
 * that PO is listed, with Edit and Cancel, and the draft adds to it, so it is never ordered twice.
 */
export function ItemOrder({ item, items, suppliers, purchases, onDone }: {
  item: InventoryRow;
  items: InventoryRow[];
  suppliers: Supplier[];
  purchases: PurchaseState;
  onDone: Done;
}) {
  const sources = suppliers.filter((s) => item.supplierIds.includes(s.id));
  const drafts = useMemo(() => draftsOf(items), [items]);
  const last = purchases.lastSupplier.get(item.id);
  const first = item.suggestedSupplierId ?? (sources.some((s) => s.id === last) ? last : sources[0]?.id) ?? null;
  const [supplierId, setSupplierId] = useState(first);
  const [placed, setPlaced] = useState<Placed[]>([]);
  const open = purchases.open.filter((o) => o.lines.some((l) => l.itemId === item.id));

  if (placed.length > 0) return <>{placed.map((p, i) => <PlacedOrder key={`${p.order.id}-${i}`} placed={p} items={items} suppliers={suppliers} />)}</>;
  if (!supplierId) return <p className="flow-hint">No active supplier for {item.name}. Add one on <a href="#suppliers">Suppliers</a>.</p>;

  const draft = drafts.get(supplierId) ?? {};
  const initial = { [item.id]: Math.max(1, draft[item.id] ?? 0), ...Object.fromEntries(Object.entries(draft).filter(([id]) => id !== item.id)) };
  return (
    <>
      <OnOrder orders={open} items={items} suppliers={suppliers} onDone={onDone} />
      {sources.length > 1 && (
        <div className="chips" role="group" aria-label="Supplier">
          {sources.map((s) => (
            <button key={s.id} type="button" className="chip" aria-pressed={s.id === supplierId} onClick={() => setSupplierId(s.id)}>{s.name}</button>
          ))}
        </div>
      )}
      <ItemDraft key={supplierId} supplierId={supplierId} initial={initial} items={items} suppliers={suppliers} purchases={purchases}
        onPlaced={(p, undo) => { setPlaced((all) => [...all, p]); onDone(placedText(p, suppliers), undo); }} />
    </>
  );
}

/** The draft with its own main button, for the item sheet. */
function ItemDraft({ supplierId, initial, items, suppliers, purchases, onPlaced }: {
  supplierId: string; initial: Packs; items: InventoryRow[]; suppliers: Supplier[]; purchases: PurchaseState;
  onPlaced: (p: Placed, undo: () => void) => void;
}) {
  const draft = useDraft(supplierId, initial, items, purchases);
  return (
    <>
      <DraftItems supplierId={supplierId} draft={draft} items={items} suppliers={suppliers} />
      {draft.error && <p className="reason-msg" role="alert">{draft.error}</p>}
      <button type="button" className="cta" disabled={!draft.canAct} onClick={() => draft.act((p, undo) => onPlaced(p, undo))}>{draft.mainLabel}</button>
    </>
  );
}
