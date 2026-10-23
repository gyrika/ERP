import { useEffect, useMemo, useState } from 'react';
import { stockStatus } from '../domain/inventory.ts';
import type { Supplier } from '../domain/inventoryData.ts';
import { orderMessage, suggestOrder, whatsAppLink } from '../domain/ordering.ts';
import { DEFAULT_LEAD_DAYS, onOrder, type PurchaseOrder, type PurchaseState } from '../domain/purchaseOrders.ts';
import { formatQuantity } from './quantity.ts';
import { cancelOrder, placeOrder, type InventoryRow } from '../services/inventoryStore.ts';

/**
 * Purchase orders: the one way to order. Serves the manager deciding what to buy: the
 * drafts are already written, one per supplier, with what will run out before the next
 * delivery (suggestOrder: use, delivery time, what is already on order). They change a
 * number, Place order saves the PO, then WhatsApp opens with the message. The item
 * sheet's Order tab is the same card (SupplierDraft), started from that item.
 */
type Packs = Record<string, number>;
type Done = (message: string, undo: () => void) => void;

/** The supplier an item is ordered from: the one it last came from, else its first. */
const supplierOf = (row: InventoryRow, active: Set<string>, last: Map<string, string>): string | null => {
  const prev = last.get(row.id);
  if (prev && active.has(prev) && row.supplierIds.includes(prev)) return prev;
  return row.supplierIds.find((id) => active.has(id)) ?? null;
};

/** Items that need ordering now, packs suggested, grouped by supplier. */
export const draftsOf = (items: InventoryRow[], suppliers: Supplier[], purchases: PurchaseState): Map<string, Packs> => {
  const active = new Set(suppliers.map((s) => s.id));
  const coming = onOrder(purchases.open);
  const drafts = new Map<string, Packs>();
  for (const row of items) {
    const sup = supplierOf(row, active, purchases.lastSupplier);
    if (!sup) continue;
    const status = stockStatus(row);
    const n = suggestOrder({ ...row, low: status === 'low' || status === 'out' }, coming.get(row.id) ?? 0, purchases.leadDays.get(sup) ?? DEFAULT_LEAD_DAYS);
    if (n > 0) drafts.set(sup, { ...drafts.get(sup), [row.id]: n });
  }
  return drafts;
};

const nameOf = (suppliers: Supplier[], id: string) => suppliers.find((s) => s.id === id)?.name ?? 'Supplier';

/** One supplier's draft: packs per item, add another of its items, Place order. */
export function SupplierDraft({ supplierId, initial, items, suppliers, poCount, onPlaced }: {
  supplierId: string;
  initial: Packs;
  items: InventoryRow[];
  suppliers: Supplier[];
  poCount: number;
  onPlaced: (order: PurchaseOrder, undo: () => void) => void;
}) {
  const [packs, setPacks] = useState<Packs>(initial);
  const name = nameOf(suppliers, supplierId);
  const byId = new Map(items.map((i) => [i.id, i]));
  const extra = items.filter((i) => i.supplierIds.includes(supplierId) && !(i.id in packs));
  const set = (id: string, n: number) => setPacks({ ...packs, [id]: Math.max(0, n) });
  const lines = Object.entries(packs).filter(([, n]) => n > 0).map(([itemId, n]) => ({ itemId, packs: n }));

  const place = () => {
    if (lines.length === 0) return;
    const { order, undo } = placeOrder(supplierId, lines, poCount);
    onPlaced(order, undo);
  };

  return (
    <section className="po-card" aria-label={`Order from ${name}`}>
      <strong>{name}</strong>
      {Object.keys(packs).length > 0 && (
        <ul className="order__lines" aria-label={`To order from ${name}`}>
          {Object.entries(packs).map(([id, n]) => {
            const row = byId.get(id);
            if (!row) return null;
            return (
              <li key={id}>
                <span className="delivery__name">{row.name}<small>{formatQuantity(row.packQty, row.baseUnit)} a pack</small></span>
                <button type="button" className="chip" aria-label={`One pack less of ${row.name}`} onClick={() => set(id, n - 1)}>−</button>
                <strong className="num order__packs" aria-label={`Packs of ${row.name}`}>{n}</strong>
                <button type="button" className="chip" aria-label={`One pack more of ${row.name}`} onClick={() => set(id, n + 1)}>+</button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="order__send">
        {extra.length > 0 && (
          <select className="inv-modal__input po-card__add" aria-label={`Add an item from ${name}`} value=""
            onChange={(e) => { if (e.target.value) set(e.target.value, 1); }}>
            <option value="">+ Add item</option>
            {extra.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        )}
        <button type="button" className="insight__action" disabled={lines.length === 0} onClick={place}>Place order</button>
      </div>
    </section>
  );
}

/** A PO just placed: its message, to send on WhatsApp, call, or copy. */
export function PlacedOrder({ order, items, suppliers }: { order: PurchaseOrder; items: InventoryRow[]; suppliers: Supplier[] }) {
  const name = nameOf(suppliers, order.supplierId);
  const phone = suppliers.find((s) => s.id === order.supplierId)?.phone;
  const text = orderMessage(order.lines.flatMap((l) => {
    const row = items.find((i) => i.id === l.itemId);
    return row ? [{ name: row.name, packs: l.packs, packQty: row.packQty, baseUnit: row.baseUnit }] : [];
  }));
  return (
    <section className="po-card po-card--placed" aria-label={`${order.poNo} ${name}`}>
      <strong>{order.poNo} placed · {name}</strong>
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

/** Open POs, each with Cancel (Undo brings the same PO back). */
function OnOrder({ orders, items, suppliers, onDone }: { orders: PurchaseOrder[]; items: InventoryRow[]; suppliers: Supplier[]; onDone: Done }) {
  if (orders.length === 0) return null;
  return (
    <section aria-label="On order">
      <p className="delivery__hint">On order</p>
      <ul className="order__lines">
        {orders.map((o) => (
          <li key={o.id}>
            <span className="delivery__name">
              {o.poNo} · {nameOf(suppliers, o.supplierId)}
              <small>{o.lines.map((l) => `${l.packs} × ${items.find((i) => i.id === l.itemId)?.name ?? l.itemId}`).join(', ')}</small>
            </span>
            <button type="button" className="linkbtn" aria-label={`Cancel ${o.poNo}`} onClick={() => onDone(`${o.poNo} cancelled.`, cancelOrder(o.id))}>Cancel</button>
          </li>
        ))}
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
  const suggested = useMemo(() => draftsOf(items, suppliers, purchases), [items, suppliers, purchases]);
  /** The cards shown: the suggested ones, then any supplier added by hand. */
  const [cards, setCards] = useState<[string, Packs][]>(() => [...suggested]);
  /** Placed here, so the message can be sent. */
  const [placed, setPlaced] = useState<PurchaseOrder[]>([]);

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

        {placed.map((o) => <PlacedOrder key={o.id} order={o} items={items} suppliers={suppliers} />)}
        {cards.length === 0 && placed.length === 0 && <p className="delivery__hint">Nothing needs ordering now.</p>}
        {cards.map(([sup, packs]) => (
          <SupplierDraft key={sup} supplierId={sup} initial={packs} items={items} suppliers={suppliers} poCount={purchases.poCount}
            onPlaced={(order, undo) => {
              setCards(cards.filter(([id]) => id !== sup));
              setPlaced([...placed, order]);
              onDone(`${order.poNo} placed with ${nameOf(suppliers, sup)}.`, undo);
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
  const drafts = useMemo(() => draftsOf(items, suppliers, purchases), [items, suppliers, purchases]);
  const first = supplierOf(item, new Set(sources.map((s) => s.id)), purchases.lastSupplier);
  const [supplierId, setSupplierId] = useState(first);
  const [placed, setPlaced] = useState<PurchaseOrder | null>(null);
  const open = purchases.open.filter((o) => o.lines.some((l) => l.itemId === item.id));

  if (placed) return <PlacedOrder order={placed} items={items} suppliers={suppliers} />;
  if (open.length > 0) return <OnOrder orders={open} items={items} suppliers={suppliers} onDone={onDone} />;
  if (!supplierId) return <p className="order__nophone">No active supplier for {item.name}. Add one on <a href="#suppliers">Suppliers</a>.</p>;

  const draft = drafts.get(supplierId) ?? {};
  const initial = { [item.id]: Math.max(1, draft[item.id] ?? 0), ...Object.fromEntries(Object.entries(draft).filter(([id]) => id !== item.id)) };
  return (
    <>
      {sources.length > 1 && (
        <div className="chips" role="group" aria-label="Supplier">
          {sources.map((s) => (
            <button key={s.id} type="button" className="chip" aria-pressed={s.id === supplierId} onClick={() => setSupplierId(s.id)}>{s.name}</button>
          ))}
        </div>
      )}
      <SupplierDraft key={supplierId} supplierId={supplierId} initial={initial} items={items} suppliers={suppliers} poCount={purchases.poCount}
        onPlaced={(order, undo) => { setPlaced(order); onDone(`${order.poNo} placed with ${nameOf(suppliers, supplierId)}.`, undo); }} />
    </>
  );
}
