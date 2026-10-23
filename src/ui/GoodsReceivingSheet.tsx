import { useEffect, useState, type FormEvent } from 'react';
import type { Actor } from '../domain/auth.ts';
import type { Supplier } from '../domain/inventoryData.ts';
import { parsePacks } from '../domain/inventory.ts';
import { receiveUnitOf, toPacks, unitName } from '../domain/counting.ts';
import {
  compareDelivery, expectedBy, undoCheck, UNDO_REASONS, type GrnDecisions, type PurchaseGrn, type PurchaseOrder, type PurchaseState,
} from '../domain/purchaseOrders.ts';
import type { StockSettings } from '../domain/stockSettings.ts';
import { receiveGoods, undoGrn, type InventoryRow } from '../services/inventoryStore.ts';
import { PinSheet } from './PinSheet.tsx';

/**
 * GRN, goods received. Serves the person at the door with the supplier's bill in hand:
 * the list shows only orders still awaiting goods (Open, Partly received), newest first,
 * with the day they are expected. Pick one: its lines come filled in with what is still
 * owed ("Received everything" fills them all); change what differs, and save once. A
 * line short or over shows as it is typed; then Save asks a manager's PIN, and the
 * manager sees the differences and chooses what happens to the short lines (wait for
 * the rest, or close the order) and the extra (accept it, or return it), then Approve
 * or Don't approve. The approver goes on the record, never on the screen. Saved, the
 * sheet goes back to the list for the next one. Undo: only the latest GRN of an order,
 * within the allowed hours, with a manager's PIN and a reason; the GRN stays listed,
 * marked Undone.
 */
const round = (n: number) => Math.round(n * 1000) / 1000;
const day = (at: number) => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

const SHORT_CHOICES = [['wait', 'Wait for the rest'], ['close', 'Close order']] as const;
const OVER_CHOICES = [['accept', 'Accept extra'], ['return', 'Return extra']] as const;

export function GoodsReceivingSheet({ items, suppliers, purchases, settings, onClose, onDone }: {
  items: InventoryRow[];
  suppliers: Supplier[];
  purchases: PurchaseState;
  settings: Pick<StockSettings, 'defaultLeadDays' | 'grnUndoHours'>;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  // Newest first: the delivery that just arrived is the one at the top.
  const open = [...purchases.open].reverse();
  const [orderId, setOrderId] = useState<string | null>(open.length === 1 ? open[0].id : null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [asking, setAsking] = useState(false);
  /** The manager whose PIN was accepted, deciding: choices, then Approve or Don't approve. */
  const [deciding, setDeciding] = useState<Actor | null>(null);
  const [decisions, setDecisions] = useState<GrnDecisions>({ short: null, over: null });
  /** The GRN just saved here, shown on the list with its Undo. */
  const [saved, setSaved] = useState<{ message: string; grnId: string } | null>(null);
  /** Undoing a GRN: first the manager's PIN, then why. */
  const [undoing, setUndoing] = useState<{ grn: PurchaseGrn; manager: Actor | null } | null>(null);

  useEffect(() => {
    // Escape is "not now": one step back, nothing saved.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || asking || (undoing && !undoing.manager)) return;
      if (undoing) setUndoing(null); else if (deciding) setDeciding(null); else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, asking, deciding, undoing]);

  const supplierName = (id: string) => suppliers.find((s) => s.id === id)?.name ?? 'Supplier';
  const order: PurchaseOrder | null = open.find((o) => o.id === orderId) ?? null;
  /** Only what is still owed. */
  const lines = order ? order.lines.filter((l) => l.remaining > 0).flatMap((l) => {
    const row = items.find((i) => i.id === l.itemId);
    if (!row) return [];
    const unit = receiveUnitOf(row);
    return [{ row, unit, expected: l.remaining, expectedInUnit: round((l.remaining * row.packQty) / unit.base) }];
  }) : [];

  const typed = (l: (typeof lines)[number]) => (amounts[l.row.id] ?? String(l.expectedInUnit)).trim();
  /** What came, line by line in packs; null when a number is not a number. */
  const received = () => {
    const out = [];
    for (const l of lines) {
      const n = typed(l) === '' ? 0 : parsePacks(typed(l));
      if (n === null) { setError(`Type the amount of ${l.row.name} as a number, like 2 or 1.5.`); return null; }
      out.push({ itemId: l.row.id, ordered: l.expected, received: round(toPacks(n, l.unit, l.row.packQty)) });
    }
    return out;
  };
  const check = compareDelivery(lines.map((l) => {
    const n = parsePacks(typed(l) || '0');
    return { itemId: l.row.id, ordered: l.expected, received: n === null ? l.expected : round(toPacks(n, l.unit, l.row.packQty)) };
  }));

  /** Back to the list of orders, fresh. */
  const toList = () => { setOrderId(null); setAmounts({}); setError(''); setDeciding(null); setDecisions({ short: null, over: null }); };

  const finish = (approvedBy: Actor | null) => {
    const got = received();
    if (!got || !order) return;
    const result = receiveGoods(order, got, decisions, approvedBy);
    if (typeof result === 'string') { setDeciding(null); setError(result); return; }
    const message = `${result.grnNo} from ${supplierName(order.supplierId)} saved${approvedBy ? ', approved by a manager' : ''}.`;
    onDone(message);
    setSaved({ message, grnId: result.id });
    toList();
  };

  const notApproved = () => {
    setDeciding(null);
    setDecisions({ short: null, over: null });
    setError('Not approved: nothing was saved. Fix the amounts, or check the delivery with the supplier.');
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!received()) return;
    if (check.needsApproval) setAsking(true);
    else finish(null);
  };

  /** Starts an undo, saying at once why it cannot be done when it cannot. */
  const startUndo = (grn: PurchaseGrn) => {
    const why = undoCheck(purchases, grn.id, Date.now(), settings.grnUndoHours);
    if (why) { setError(why); return; }
    setError('');
    setUndoing({ grn, manager: null });
  };
  const undo = (reason: string) => {
    if (!undoing?.manager) return;
    const why = undoGrn(purchases, undoing.grn.id, reason, undoing.manager, settings.grnUndoHours);
    if (why) { setError(why); setUndoing(null); return; }
    onDone(`${undoing.grn.grnNo} undone.`);
    setSaved(null);
    setError('');
    setUndoing(null);
  };

  const choiceReady = (!check.hasShort || decisions.short !== null) && (!check.hasOver || decisions.over !== null);
  const recent = purchases.grns.slice(0, 5);

  return (
    <div className="inv-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget && !asking && !undoing) onClose(); }}>
      <form className="inv-modal delivery" role="dialog" aria-modal="true" aria-labelledby="grn-title" onSubmit={save}>
        <button type="button" className="count__close" aria-label="Close" onClick={onClose}>×</button>
        <h2 id="grn-title">{order ? `Goods from ${supplierName(order.supplierId)} · ${order.poNo}` : 'GRN'}</h2>

        {saved && !order && (
          <p className="count__saved" role="status">
            {saved.message}
            <button type="button" className="linkbtn" onClick={() => { const g = purchases.grns.find((x) => x.id === saved.grnId); if (g) startUndo(g); }}>Undo</button>
          </p>
        )}

        {undoing?.manager ? (
          <section className="grn__decide" aria-label="Why undo">
            <p className="delivery__hint">Why is {undoing.grn.grnNo} being undone?</p>
            <div className="chips" role="group" aria-label="Reason">
              {UNDO_REASONS.map((r) => <button key={r} type="button" className="chip" onClick={() => undo(r)}>{r}</button>)}
            </div>
            <button type="button" className="linkbtn" onClick={() => setUndoing(null)}>Keep {undoing.grn.grnNo}</button>
          </section>
        ) : deciding && order ? (
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
            {check.hasShort && (
              <div className="chips" role="group" aria-label="Short lines">
                {SHORT_CHOICES.map(([id, label]) => (
                  <button key={id} type="button" className="chip" aria-pressed={decisions.short === id} onClick={() => setDecisions({ ...decisions, short: id })}>{label}</button>
                ))}
              </div>
            )}
            {check.hasOver && (
              <div className="chips" role="group" aria-label="Extra lines">
                {OVER_CHOICES.map(([id, label]) => (
                  <button key={id} type="button" className="chip" aria-pressed={decisions.over === id} onClick={() => setDecisions({ ...decisions, over: id })}>{label}</button>
                ))}
              </div>
            )}
            <div className="inv-modal__actions">
              <button type="button" className="inv-modal__cancel" onClick={notApproved}>Don't approve</button>
              <button type="button" className="insight__action" disabled={!choiceReady} onClick={() => finish(deciding)}>Approve</button>
            </div>
          </section>
        ) : !order ? (
          <>
            {open.length === 0 ? (
              <p className="delivery__hint">Nothing on order. Place a purchase order first; goods are received against it.</p>
            ) : (
              <>
                <p className="delivery__hint">Which order came?</p>
                <div className="delivery__suppliers" role="group" aria-label="Open orders">
                  {open.map((o) => (
                    <button key={o.id} type="button" className="chip" onClick={() => { setOrderId(o.id); setAmounts({}); setError(''); setSaved(null); }}>
                      {supplierName(o.supplierId)} · {o.poNo} · expected {day(expectedBy(o, purchases.leadDays, settings.defaultLeadDays))}{o.status === 'partly' ? ' · partly received' : ''}
                    </button>
                  ))}
                </div>
              </>
            )}
            {error && <p className="inv-modal__error" role="alert">{error}</p>}
            {recent.length > 0 && (
              <section aria-label="Recent GRNs">
                <p className="delivery__hint">Recent GRNs</p>
                <ul className="order__lines">
                  {recent.map((g) => (
                    <li key={g.id} className={g.undone ? 'grn__undone' : undefined}>
                      <span className="delivery__name">
                        {g.grnNo} · {supplierName(g.supplierId)} · {g.poNo}
                        <small>{day(g.at)}{g.undone ? ` · Undone: ${g.undone.reason}` : ''}</small>
                      </span>
                      {!g.undone && undoCheck(purchases, g.id, Date.now(), settings.grnUndoHours) === null && (
                        <button type="button" className="linkbtn" aria-label={`Undo ${g.grnNo}`} onClick={() => startUndo(g)}>Undo</button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        ) : (
          <>
            <button type="button" className="linkbtn delivery__change" onClick={toList}>{open.length > 1 ? 'Another order' : 'Recent GRNs'}</button>
            <ul className="delivery__lines" aria-label="What came">
              {lines.map((l, i) => {
                const name = unitName(l.unit);
                const c = check.lines[i];
                return (
                  <li key={l.row.id}>
                    <span className="delivery__name">
                      {l.row.name}
                      <small>expected {l.expectedInUnit} {l.unit.id === 'pack' ? (l.expectedInUnit === 1 ? 'pack' : 'packs') : name}</small>
                    </span>
                    <span className={`grn__match grn__match--${c.match}`} aria-label={`${l.row.name}: ${c.match === 'ok' ? 'as ordered' : c.match}`}>
                      {c.match === 'ok' ? '✓' : `${c.match} ${c.diff > 0 ? '+' : '−'}${round(Math.abs(c.diff) * l.row.packQty / l.unit.base)}`}
                    </span>
                    <input
                      className="inv-modal__input num delivery__packs" inputMode="decimal" placeholder="0"
                      aria-label={l.unit.id === 'pack' ? `Packs of ${l.row.name}` : `${name} of ${l.row.name}`}
                      value={typed(l)}
                      onChange={(e) => { setAmounts({ ...amounts, [l.row.id]: e.target.value }); setError(''); }}
                    />
                  </li>
                );
              })}
            </ul>
            <button type="button" className="linkbtn delivery__change" onClick={() => { setAmounts({}); setError(''); }}>Received everything</button>
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
      {undoing && !undoing.manager && (
        <PinSheet reason={`To undo ${undoing.grn.grnNo}`} onClose={() => setUndoing(null)} onUnlock={(manager) => setUndoing({ ...undoing, manager })} />
      )}
    </div>
  );
}
