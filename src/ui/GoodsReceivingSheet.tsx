import { useEffect, useState, type FormEvent } from 'react';
import type { Actor } from '../domain/auth.ts';
import type { Supplier } from '../domain/inventoryData.ts';
import { parsePacks } from '../domain/inventory.ts';
import { receiveUnitOf, toPacks, unitName } from '../domain/counting.ts';
import { compareDelivery, type PurchaseOrder, type PurchaseState } from '../domain/purchaseOrders.ts';
import { receiveGoods, type InventoryRow } from '../services/inventoryStore.ts';
import { PinSheet } from './PinSheet.tsx';

/**
 * GRN, goods received (was "Delivery came"). Serves the manager with the supplier's
 * bill in hand: they pick the open purchase order, see only what was ordered (filled
 * in with the ordered amount), change what differs, and save once. A line short or over
 * shows as it is typed; then Save asks a manager's PIN, and the manager sees the
 * differences and chooses Approve or Don't approve. Approved, the GRN is saved (the
 * approver goes on the record, never on the screen) and the sheet goes back to the
 * list of open orders for the next one. Not approved, nothing is saved and the amounts
 * stay to be fixed. Undo takes the whole GRN back and the order is open again.
 */
const round = (n: number) => Math.round(n * 1000) / 1000;

export function GoodsReceivingSheet({ items, suppliers, purchases, onClose, onDone }: {
  items: InventoryRow[];
  suppliers: Supplier[];
  purchases: PurchaseState;
  onClose: () => void;
  onDone: (message: string, undo: () => void) => void;
}) {
  const open = purchases.open;
  const [orderId, setOrderId] = useState<string | null>(open.length === 1 ? open[0].id : null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [asking, setAsking] = useState(false);
  /** The manager whose PIN was accepted, deciding: Approve or Don't approve. */
  const [deciding, setDeciding] = useState<Actor | null>(null);
  /** The GRN just saved here, with its Undo, shown on the list of orders. */
  const [saved, setSaved] = useState<{ message: string; undo: () => void } | null>(null);

  useEffect(() => {
    // Escape while the manager decides is "not now": back to the amounts, nothing saved.
    const onKey = (e: KeyboardEvent) => { if (e.key !== 'Escape' || asking) return; if (deciding) setDeciding(null); else onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, asking, deciding]);

  const supplierName = (id: string) => suppliers.find((s) => s.id === id)?.name ?? 'Supplier';
  const order: PurchaseOrder | null = open.find((o) => o.id === orderId) ?? null;
  const lines = order ? order.lines.flatMap((l) => {
    const row = items.find((i) => i.id === l.itemId);
    if (!row) return [];
    const unit = receiveUnitOf(row);
    const orderedInUnit = round((l.packs * row.packQty) / unit.base);
    return [{ row, unit, ordered: l.packs, orderedInUnit }];
  }) : [];

  /** What came, line by line in packs; null when a number is not a number. */
  const received = () => {
    const out = [];
    for (const l of lines) {
      const raw = (amounts[l.row.id] ?? String(l.orderedInUnit)).trim();
      const n = raw === '' ? 0 : parsePacks(raw);
      if (n === null) { setError(`Type the amount of ${l.row.name} as a number, like 2 or 1.5.`); return null; }
      out.push({ itemId: l.row.id, ordered: l.ordered, received: round(toPacks(n, l.unit, l.row.packQty)) });
    }
    return out;
  };
  const check = (() => {
    const got = lines.map((l) => {
      const n = parsePacks((amounts[l.row.id] ?? String(l.orderedInUnit)).trim() || '0');
      return { itemId: l.row.id, ordered: l.ordered, received: n === null ? l.ordered : round(toPacks(n, l.unit, l.row.packQty)) };
    });
    return compareDelivery(got);
  })();

  /** Back to the list of open orders, fresh. */
  const toList = () => { setOrderId(null); setAmounts({}); setError(''); setDeciding(null); };

  const finish = (approvedBy: Actor | null) => {
    const got = received();
    if (!got || !order) return;
    const { grnNo, undo } = receiveGoods(order, items, got, approvedBy, purchases.grnCount);
    // One Undo, whether pressed here or on the inventory screen.
    let undone = false;
    const once = () => { if (!undone) { undone = true; undo(); setSaved(null); } };
    const message = `${grnNo} from ${supplierName(order.supplierId)} saved${approvedBy ? ', approved by a manager' : ''}.`;
    onDone(message, once);
    setSaved({ message, undo: once });
    toList();
  };

  const notApproved = () => {
    setDeciding(null);
    setError('Not approved: nothing was saved. Fix the amounts, or check the delivery with the supplier.');
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!received()) return;
    if (check.needsApproval) setAsking(true);
    else finish(null);
  };

  return (
    <div className="inv-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget && !asking) onClose(); }}>
      <form className="inv-modal delivery" role="dialog" aria-modal="true" aria-labelledby="grn-title" onSubmit={save}>
        <button type="button" className="count__close" aria-label="Close" onClick={onClose}>×</button>
        <h2 id="grn-title">{order ? `Goods from ${supplierName(order.supplierId)} · ${order.poNo}` : 'GRN'}</h2>

        {saved && !order && (
          <p className="count__saved" role="status">
            {saved.message}
            <button type="button" className="linkbtn" onClick={saved.undo}>Undo</button>
          </p>
        )}

        {deciding && order ? (
          <section className="grn__decide" aria-label="Manager decision">
            <p className="delivery__hint">This delivery differs from {order.poNo}:</p>
            <ul className="delivery__lines">
              {check.lines.filter((c) => c.match !== 'ok').map((c) => {
                const l = lines.find((x) => x.row.id === c.itemId)!;
                return (
                  <li key={c.itemId}>
                    <span className="delivery__name">{l.row.name}</span>
                    <span className={`grn__match grn__match--${c.match}`}>{c.match} {c.diff > 0 ? '+' : '−'}{round(Math.abs(c.diff) * l.row.packQty / l.unit.base)}</span>
                  </li>
                );
              })}
            </ul>
            <div className="inv-modal__actions">
              <button type="button" className="inv-modal__cancel" onClick={notApproved}>Don't approve</button>
              <button type="button" className="insight__action" onClick={() => finish(deciding)}>Approve</button>
            </div>
          </section>
        ) : !order ? (
          open.length === 0 ? (
            <p className="delivery__hint">Nothing on order. Place a purchase order first; goods are received against it.</p>
          ) : (
            <>
              <p className="delivery__hint">Which order came?</p>
              <div className="delivery__suppliers" role="group" aria-label="Open orders">
                {open.map((o) => (
                  <button key={o.id} type="button" className="chip" onClick={() => { setOrderId(o.id); setAmounts({}); setError(''); }}>
                    {supplierName(o.supplierId)} · {o.poNo}
                  </button>
                ))}
              </div>
            </>
          )
        ) : (
          <>
            {open.length > 1 && (
              <button type="button" className="linkbtn delivery__change" onClick={toList}>Another order</button>
            )}
            <ul className="delivery__lines" aria-label="What came">
              {lines.map((l, i) => {
                const name = unitName(l.unit);
                const c = check.lines[i];
                return (
                  <li key={l.row.id}>
                    <span className="delivery__name">
                      {l.row.name}
                      <small>ordered {l.orderedInUnit} {l.unit.id === 'pack' ? (l.orderedInUnit === 1 ? 'pack' : 'packs') : name}</small>
                    </span>
                    <span className={`grn__match grn__match--${c.match}`} aria-label={`${l.row.name}: ${c.match === 'ok' ? 'as ordered' : c.match}`}>
                      {c.match === 'ok' ? '✓' : `${c.match} ${c.diff > 0 ? '+' : '−'}${round(Math.abs(c.diff) * l.row.packQty / l.unit.base)}`}
                    </span>
                    <input
                      className="inv-modal__input num delivery__packs" inputMode="decimal" placeholder="0"
                      aria-label={l.unit.id === 'pack' ? `Packs of ${l.row.name}` : `${name} of ${l.row.name}`}
                      value={amounts[l.row.id] ?? String(l.orderedInUnit)}
                      onChange={(e) => { setAmounts({ ...amounts, [l.row.id]: e.target.value }); setError(''); }}
                    />
                  </li>
                );
              })}
            </ul>
            {error && <p className="inv-modal__error" role="alert">{error}</p>}
            <div className="inv-modal__actions">
              <button type="button" className="inv-modal__cancel" onClick={onClose}>Cancel</button>
              <button type="submit" className="insight__action">{check.needsApproval ? 'Manager approves' : 'Save GRN'}</button>
            </div>
          </>
        )}
      </form>
      {asking && (
        <PinSheet reason="The delivery differs from the order" onClose={() => setAsking(false)} onUnlock={(manager) => { setAsking(false); setDeciding(manager); }} />
      )}
    </div>
  );
}
