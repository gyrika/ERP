import { useMemo, useState } from 'react';
import {
  addInventoryItem,
  archiveInventoryItem,
  restoreInventoryItem,
  useInventory,
  type StockStatus,
} from '../services/inventoryStore.ts';
import { stockStatus } from '../domain/inventory.ts';
import { fmt } from '../domain/money.ts';
import { AddIngredientModal } from './AddIngredientModal.tsx';
import { OwnerNav } from './OwnerNav.tsx';
import { formatLasts, formatQuantity } from './quantity.ts';
import { StockSheet } from './StockSheet.tsx';
import { CountFlow } from './CountFlow.tsx';
import { countsDue, tiersOf, type DueCount } from '../domain/counting.ts';

const STATUS_LABELS: Record<StockStatus, string> = {
  out: 'Out of stock',
  low: 'Low stock',
  unsure: 'Check shelf',
  ok: 'In stock',
  unknown: 'Not counted yet',
};

/** Why a row says "Check shelf": what it has not been able to take off. */
const missedText = (n: number) => `${n} sold since the last count not taken off`;


export function InventoryView({
  onFindSupplier,
  onRegister,
}: {
  onFindSupplier?: (id: string) => void;
  onRegister?: () => void;
} = {}) {
  const [showAdd, setShowAdd] = useState(false);
  const [archived, setArchived] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [updating, setUpdating] = useState<string | null>(null);
  /** The last stock change, with its Undo (instant action, visible Undo: no confirmations). */
  const [done, setDone] = useState<{ message: string; undo: () => void } | null>(null);
  const { items, suppliers, untrackedSold } = useInventory();
  const supplierNames = useMemo(() => new Map(suppliers.map((supplier) => [supplier.id, supplier.name])), [suppliers]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => [item.name, item.category, ...item.supplierIds.map((id) => supplierNames.get(id) ?? '')]
      .some((text) => text.toLowerCase().includes(q)));
  }, [items, query, supplierNames]);
  const updatingItem = items.find((item) => item.id === updating) ?? null;
  // Today's count: what the money says to count, and since when.
  const tiers = useMemo(() => tiersOf(items), [items]);
  const due = useMemo(() => countsDue(items, tiers, Date.now()), [items, tiers]);
  const dueIds = useMemo(() => new Set(due.filter((d) => d.state !== 'never').map((d) => d.id)), [due]);
  const [counting, setCounting] = useState<DueCount[] | null>(null);

  const removeItem = (id: string, name: string) => {
    try {
      archiveInventoryItem(id);
      setArchived({ id, name });
      setDone(null);
      setError('');
    } catch (cause) {
      if (!(cause instanceof Error)) throw cause;
      setError(cause.message);
    }
  };

  const undoArchive = () => {
    if (!archived) return;
    try {
      restoreInventoryItem(archived.id);
      setArchived(null);
      setError('');
    } catch (cause) {
      if (!(cause instanceof Error)) throw cause;
      setError(cause.message);
    }
  };

  return (
    <div className="inv-page">
      <OwnerNav current="inventory" onRegister={onRegister} />
      <div className="inv-page__head">
         <h1 className="supplier-heading">Inventory Dashboard</h1>
         <button type="button" className="insight__action" onClick={() => setShowAdd(true)}>+ Add Ingredient</button>
      </div>

      {(archived || error) && (
        <div className={`inv-notice${error ? ' inv-notice--error' : ''}`} role={error ? 'alert' : 'status'}>
          {error || `${archived?.name} removed from inventory.`}
          {archived && !error && <button type="button" onClick={undoArchive}>Undo</button>}
        </div>
      )}
      {done && !archived && !error && (
        <div className="inv-notice" role="status">
          {done.message}
          <button type="button" onClick={() => { done.undo(); setDone(null); }}>Undo</button>
        </div>
      )}

      {due.length > 0 && (
        <div className="count-due" role="region" aria-label="Today's count">
          <div>
            <strong className="count-due__title">Today's count · {due.length} {due.length === 1 ? 'item' : 'items'}</strong>
            <span className="count-due__sub">
              {[
                due.some((d) => d.state === 'overdue') && `${due.filter((d) => d.state === 'overdue').length} overdue`,
                due.some((d) => d.state === 'never') && `${due.filter((d) => d.state === 'never').length} never counted`,
              ].filter(Boolean).join(' · ') || 'Count what is left; the app compares.'}
            </span>
          </div>
          <button type="button" className="insight__action" onClick={() => { setCounting(due); setDone(null); }}>Start</button>
        </div>
      )}

      {untrackedSold > 0 && (
        <div className="inv-notice" role="status">
          {untrackedSold} {untrackedSold === 1 ? 'item' : 'items'} sold this week took no stock: no recipe yet.
          <a className="inv-notice__link" href="#menu">Answer on Menu</a>
        </div>
      )}

      <label className="inv-search">
        <span className="sr-only">Search inventory</span>
        <input
          className="inv-modal__input" type="search" value={query} placeholder="Search ingredient, category or supplier"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
        />
      </label>

      <main className="inv-rows" aria-label="Inventory">
        {shown.length === 0 && <p className="inv-empty">No ingredients match “{query.trim()}”.</p>}
        {shown.map((item) => {
           const status = stockStatus(item);

           return (
             <article key={item.id} className="inv-row">
               <div className="inv-row__main">
                 <h2 className="inv-row__name">{item.name}</h2>
                 <div className="inv-row__sub" aria-label="Suppliers">
                   {item.supplierIds.map((id) => supplierNames.get(id)).filter(Boolean).join(', ') || 'No active suppliers'}
                 </div>
               </div>
               <div className="inv-row__quantity" aria-label="Available stock and pack size">
                 <span className={`inv-row__status inv-row__status--${status}`}>{STATUS_LABELS[status]}</span>
                 {/* Blind count: while it is due, the shelf amount stays hidden until it is counted. */}
                 <strong>
                   {dueIds.has(item.id) ? 'Count due' : formatQuantity(Math.max(0, item.onHandBaseUnits), item.baseUnit)}
                   {' / '}
                   {formatQuantity(item.packQty, item.baseUnit)}
                 </strong>
                 {status === 'unsure'
                   ? <span className="inv-row__lasts">{missedText(item.missedSales)}</span>
                   : formatLasts(item.lastsDays) && <span className="inv-row__lasts">{formatLasts(item.lastsDays)}</span>}
                 <span className="inv-row__price">Rs {fmt(item.workingPriceCents)} a pack</span>
               </div>
               <div className="inv-row__actions">
                 <button
                   type="button"
                   className="inv-row__update"
                   aria-label={`Update ${item.name}`}
                   onClick={() => { setUpdating(item.id); setArchived(null); setError(''); }}
                 >
                   Update
                 </button>
                 {onFindSupplier && (
                   <button
                     type="button"
                     className="inv-row__supplier"
                     onClick={() => onFindSupplier(item.id)}
                   >
                     Find supplier
                   </button>
                 )}
                 <button
                   type="button"
                   className="inv-row__remove"
                   aria-label={`Remove ${item.name}`}
                   title={`Remove ${item.name}`}
                   onClick={() => removeItem(item.id, item.name)}
                 >
                   <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                     <path d="M4 7h16M10 11v6m4-6v6M5 7l1 13h12l1-13M9 7V4h6v3" />
                   </svg>
                 </button>
               </div>
             </article>
           );
        })}
      </main>
      {updatingItem && (
        <StockSheet
          item={updatingItem}
          onCount={() => {
            setUpdating(null);
            setCounting([due.find((d) => d.id === updatingItem.id) ?? { id: updatingItem.id, tier: tiers.get(updatingItem.id) ?? 'monthly', state: updatingItem.counted ? 'due' : 'never', lastCountedAt: updatingItem.lastCountedAt }]);
          }}
          onClose={() => setUpdating(null)}
          onDone={(message, undo) => setDone({ message, undo })}
        />
      )}
      {counting && <CountFlow due={counting} rows={items} onClose={() => setCounting(null)} />}
      {showAdd && (
        <AddIngredientModal onClose={() => setShowAdd(false)} onSave={addInventoryItem} />
      )}
    </div>
  );
}