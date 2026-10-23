import { useEffect, useMemo, useState } from 'react';
import type { Supplier } from '../domain/inventoryData.ts';
import { isPending } from '../domain/docNumbers.ts';
import { draftsOf, orderMessage, whatsAppLink } from '../domain/ordering.ts';
import { CANCEL_REASONS, planOrder, type PurchaseOrder, type PurchaseState } from '../domain/purchaseOrders.ts';
import type { PoLine } from '../domain/sync.ts';
import { formatQuantity } from './quantity.ts';
import { addToOrder, cancelOrder, editOrder, placeOrder, type InventoryRow } from '../services/inventoryStore.ts';

/**
 * Purchase orders: the one way to order. Serves the manager deciding what to buy: the
 * drafts are already written, one per supplier, with what will run out before the next
 * delivery (`suggestions` in ordering.ts: use, delivery time, what is already on order).
 * They change a number, Place order saves the PO, then WhatsApp opens with the message.
 * An item already on an open order is never ordered twice: the card says "On order · PO-0003"
 * and offers "Add to PO-0003" (`planOrder`). An order can be edited or cancelled, with a
 * reason, until goods are received against it. The item sheet's Order tab is the same
 * card (SupplierDraft), started from that item.
 */
type Packs = Record<string, number>;
type Done = (message: string, undo: () => void) => void;
/** An order just made here, or lines just added to one (message: only the added lines). */
interface Placed { order: PurchaseOrder; added: boolean }

const nameOf = (suppliers: Supplier[], id: string) => suppliers.find((s) => s.id === id)?.name ?? 'Supplier';

/** One supplier's draft: packs per item, add another of its items, Place order / Add to PO. */
export function SupplierDraft({ supplierId, initial, items, suppliers, purchases, onPlaced }: {
  supplierId: string;
  initial: Packs;
  items: InventoryRow[];
  suppliers: Supplier[];
  purchases: PurchaseState;
  /** done: nothing left on the card. */
  onPlaced: (placed: Placed, undo: () => void, done: boolean) => void;
}) {
  const [packs, setPacks] = useState<Packs>(initial);
  const [error, setError] = useState('');
  const name = nameOf(suppliers, supplierId);
  const byId = new Map(items.map((i) => [i.id, i]));
  const extra = items.filter((i) => i.supplierIds.includes(supplierId) && !(i.id in packs));
  const set = (id: string, n: number) => { setPacks({ ...packs, [id]: Math.max(0, n) }); setError(''); };
  const remove = (id: string) => { const { [id]: _gone, ...rest } = packs; setPacks(rest); setError(''); };
  const lines: PoLine[] = Object.entries(packs).filter(([, n]) => n > 0).map(([itemId, n]) => ({ itemId, packs: n }));
  const plan = planOrder(purchases.open, supplierId, lines);
  const blocked = new Map(plan.blocked.map((b) => [b.itemId, b.poNo]));

  const without = (done: PoLine[]) => {
    const gone = new Set(done.map((l) => l.itemId));
    const rest = Object.fromEntries(Object.entries(packs).filter(([id]) => !gone.has(id)));
    setPacks(rest);
    return Object.keys(rest).length === 0;
  };
  const create = () => {
    const { order, undo } = placeOrder(supplierId, plan.create);
    onPlaced({ order, added: false }, undo, without(plan.create));
  };
  const addTo = (a: (typeof plan.add)[number]) => {
    const undo = addToOrder(a.order, a.lines);
    if (typeof undo === 'string') return setError(undo);
    const order: PurchaseOrder = { ...a.order, lines: a.lines.map((l) => ({ itemId: l.itemId, packs: l.packs, stockQty: null, received: 0, remaining: l.packs })) };
    onPlaced({ order, added: true }, undo, without(a.lines));
  };

  return (
    <section className="po-card" aria-label={`Order from ${name}`}>
      <strong>{name}</strong>
      {Object.keys(packs).length > 0 && (
        <ul className="order__lines" aria-label={`To order from ${name}`}>
          {Object.entries(packs).map(([id, n]) => {
            const row = byId.get(id);
            if (!row) return null;
            const on = plan.onOrder.get(id);
            return (
              <li key={id}>
                <span className="delivery__name">
                  {row.name}
                  <small>{n} × {formatQuantity(row.packQty, row.baseUnit)} = {formatQuantity(n * row.packQty, row.baseUnit)}</small>
                  {on && <small className="po-tag">On order · {on}{blocked.has(id) ? ': partly received, wait for it or close it first' : ''}</small>}
                </span>
                <button type="button" className="chip" aria-label={`One pack less of ${row.name}`} onClick={() => set(id, n - 1)}>−</button>
                <strong className="num order__packs" aria-label={`Packs of ${row.name}`}>{n}</strong>
                <button type="button" className="chip" aria-label={`One pack more of ${row.name}`} onClick={() => set(id, n + 1)}>+</button>
                <button type="button" className="linkbtn" aria-label={`Remove ${row.name}`} onClick={() => remove(id)}>×</button>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="inv-modal__error" role="alert">{error}</p>}
      <div className="order__send">
        {extra.length > 0 && (
          <select className="inv-modal__input po-card__add" aria-label={`Add an item from ${name}`} value=""
            onChange={(e) => { if (e.target.value) set(e.target.value, 1); }}>
            <option value="">+ Add item</option>
            {extra.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        )}
        {plan.add.map((a) => (
          <button key={a.order.id} type="button" className="insight__action" onClick={() => addTo(a)}>Add to {a.order.poNo}</button>
        ))}
        {(plan.create.length > 0 || plan.add.length === 0) && (
          <button type="button" className="insight__action" disabled={plan.create.length === 0} onClick={create}>Place order</button>
        )}
      </div>
    </section>
  );
}

/** A PO just placed (or lines just added to one): its message, to send on WhatsApp, call, or copy. */
export function PlacedOrder({ placed: { order, added }, items, suppliers }: { placed: Placed; items: InventoryRow[]; suppliers: Supplier[] }) {
  const name = nameOf(suppliers, order.supplierId);
  const phone = suppliers.find((s) => s.id === order.supplierId)?.phone;
  const text = orderMessage(order.lines.flatMap((l) => {
    const row = items.find((i) => i.id === l.itemId);
    return row ? [{ name: row.name, packs: l.packs, packQty: row.packQty, baseUnit: row.baseUnit }] : [];
  }), 'CheesyBeez', added ? `Hi, this is CheesyBeez. Please add to ${isPending(order.poNo) ? 'our order' : order.poNo}:` : undefined);
  return (
    <section className="po-card po-card--placed" aria-label={`${order.poNo} ${name}`}>
      <strong>{added ? `Added to ${order.poNo}` : `${order.poNo} placed`} · {name}</strong>
      <pre className="order__message" aria-label="Message">{text}</pre>
      <div className="order__send">
        {phone ? (
          <>
            <a className="restock-action restock-action--wa" href={whatsAppLink(phone, text)} target="_blank" rel="noreferrer">WhatsApp</a>
            <a className="restock-action order__call" href={`tel:${phone}`}>Call {phone}</a>
          </>
        ) : (
          <p className="order__nophone">No phone saved for {name}. Add it on <a href="#suppliers">Suppliers</a>.</p>
        )}
        <button type="button" className="linkbtn" onClick={() => { void navigator.clipboard?.writeText(text).catch(() => {}); }}>Copy message</button>
      </div>
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

  return (
    <li className="po-open">
      <span className="delivery__name">
        {order.poNo} · {nameOf(suppliers, order.supplierId)}
        <small className="po-tag">{STATUS_WORDS[order.status]}</small>
        {!editing && (
          <small>{order.lines.map((l) => `${l.packs} × ${nameFor(l.itemId)}${l.received > 0 ? ` (${l.received} received)` : ''}`).join(', ')}</small>
        )}
      </span>
      {editing && (
        <ul className="order__lines" aria-label={`Change ${order.poNo}`}>
          {Object.entries(editing).map(([id, n]) => (
            <li key={id}>
              <span className="delivery__name">{nameFor(id)}</span>
              <button type="button" className="chip" aria-label={`One pack less of ${nameFor(id)} on ${order.poNo}`} onClick={() => setEditing({ ...editing, [id]: Math.max(1, n - 1) })}>−</button>
              <strong className="num order__packs" aria-label={`Packs of ${nameFor(id)} on ${order.poNo}`}>{n}</strong>
              <button type="button" className="chip" aria-label={`One pack more of ${nameFor(id)} on ${order.poNo}`} onClick={() => setEditing({ ...editing, [id]: n + 1 })}>+</button>
              <button type="button" className="linkbtn" aria-label={`Remove ${nameFor(id)} from ${order.poNo}`}
                onClick={() => { const { [id]: _gone, ...rest } = editing; setEditing(rest); }}>×</button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="inv-modal__error" role="alert">{error}</p>}
      {order.editable ? (
        editing ? (
          <span className="po-open__actions">
            <button type="button" className="linkbtn" onClick={() => { setEditing(null); setError(''); }}>Keep as it was</button>
            <button type="button" className="insight__action" aria-label={`Save ${order.poNo}`} onClick={save}>Save changes</button>
          </span>
        ) : why ? (
          <div className="chips" role="group" aria-label={`Why cancel ${order.poNo}`}>
            {CANCEL_REASONS.map((r) => (
              <button key={r} type="button" className="chip" onClick={() => onDone(`${order.poNo} cancelled.`, cancelOrder(order.id, r))}>{r}</button>
            ))}
          </div>
        ) : (
          <span className="po-open__actions">
            <button type="button" className="linkbtn" aria-label={`Edit ${order.poNo}`} onClick={() => setEditing(Object.fromEntries(order.lines.map((l) => [l.itemId, l.packs])))}>Edit</button>
            <button type="button" className="linkbtn" aria-label={`Cancel ${order.poNo}`} onClick={() => setWhy(true)}>Cancel</button>
          </span>
        )
      ) : (
        <small className="po-open__locked">Goods came: finish it with GRN.</small>
      )}
    </li>
  );
}

/** Open orders, awaiting goods. */
function OnOrder({ orders, items, suppliers, onDone }: { orders: PurchaseOrder[]; items: InventoryRow[]; suppliers: Supplier[]; onDone: Done }) {
  if (orders.length === 0) return null;
  return (
    <section aria-label="On order">
      <p className="delivery__hint">On order</p>
      <ul className="order__lines">
        {orders.map((o) => <OnOrderRow key={o.id} order={o} items={items} suppliers={suppliers} onDone={onDone} />)}
      </ul>
    </section>
  );
}

export function OrderSheet({ items, suppliers, purchases, onClose, onDone }: {
  items: InventoryRow[];
  suppliers: Supplier[];
  purchases: PurchaseState;
  onClose: () => void;
  onDone: Done;
}) {
  const suggested = useMemo(() => draftsOf(items), [items]);
  /** The cards shown: the suggested ones, then any supplier added by hand. */
  const [cards, setCards] = useState<[string, Packs][]>(() => [...suggested]);
  /** Placed here, so the message can be sent. */
  const [placed, setPlaced] = useState<Placed[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const others = suppliers.filter((s) => !cards.some(([id]) => id === s.id) && items.some((i) => i.supplierIds.includes(s.id)));

  return (
    <div className="inv-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="inv-modal order" role="dialog" aria-modal="true" aria-labelledby="po-title">
        <button type="button" className="count__close" aria-label="Close" onClick={onClose}>×</button>
        <h2 id="po-title">Purchase orders</h2>

        {placed.map((p, i) => <PlacedOrder key={`${p.order.id}-${i}`} placed={p} items={items} suppliers={suppliers} />)}
        {cards.length === 0 && placed.length === 0 && <p className="delivery__hint">Nothing needs ordering now.</p>}
        {cards.map(([sup, packs]) => (
          <SupplierDraft key={sup} supplierId={sup} initial={packs} items={items} suppliers={suppliers} purchases={purchases}
            onPlaced={(p, undo, done) => {
              if (done) setCards(cards.filter(([id]) => id !== sup));
              setPlaced([...placed, p]);
              onDone(p.added ? `Added to ${p.order.poNo}.` : `${p.order.poNo} placed with ${nameOf(suppliers, sup)}.`, undo);
            }} />
        ))}

        {others.length > 0 && (
          <div className="delivery__suppliers" role="group" aria-label="Order from another supplier">
            {others.map((s) => (
              <button key={s.id} type="button" className="chip" onClick={() => setCards([...cards, [s.id, {}]])}>+ {s.name}</button>
            ))}
          </div>
        )}

        <OnOrder orders={purchases.open} items={items} suppliers={suppliers} onDone={onDone} />
      </div>
    </div>
  );
}

/**
 * The item sheet's Order tab: the same draft, started from this item (its suggested
 * packs, else one), with its supplier's other items that need ordering. Already on an
 * open PO: that PO, with Cancel, so it is never ordered twice.
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
  const [placed, setPlaced] = useState<Placed | null>(null);
  const open = purchases.open.filter((o) => o.lines.some((l) => l.itemId === item.id));

  if (placed) return <PlacedOrder placed={placed} items={items} suppliers={suppliers} />;
  if (!supplierId) return <p className="order__nophone">No active supplier for {item.name}. Add one on <a href="#suppliers">Suppliers</a>.</p>;

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
      <SupplierDraft key={supplierId} supplierId={supplierId} initial={initial} items={items} suppliers={suppliers} purchases={purchases}
        onPlaced={(p, undo) => { setPlaced(p); onDone(p.added ? `Added to ${p.order.poNo}.` : `${p.order.poNo} placed with ${nameOf(suppliers, supplierId)}.`, undo); }} />
    </>
  );
}
