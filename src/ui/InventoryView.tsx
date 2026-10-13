import { useMemo, useState } from 'react';
import {
  addInventoryItem,
  archiveInventoryItem,
  restoreInventoryItem,
  useInventory,
} from '../services/inventoryStore.ts';
import { stockStatus } from '../domain/inventory.ts';
import { fmt } from '../domain/money.ts';
import { AddIngredientModal } from './AddIngredientModal.tsx';
import { OwnerNav } from './OwnerNav.tsx';
import { formatQuantity } from './quantity.ts';
import { StatusDot } from './StatusDot.tsx';
import { StockSheet } from './StockSheet.tsx';


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
  const { items, suppliers } = useInventory();
  const supplierNames = useMemo(() => new Map(suppliers.map((supplier) => [supplier.id, supplier.name])), [suppliers]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => [item.name, item.category, ...item.supplierIds.map((id) => supplierNames.get(id) ?? '')]
      .some((text) => text.toLowerCase().includes(q)));
  }, [items, query, supplierNames]);
  const updatingItem = items.find((item) => item.id === updating) ?? null;

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
                 <span>Available / pack size</span>
                 <strong>
                   {formatQuantity(Math.max(0, item.onHandBaseUnits), item.baseUnit)}
                   {' / '}
                   {formatQuantity(item.packQty, item.baseUnit)}
                 </strong>
                 <span className="inv-row__price">Rs {fmt(item.workingPriceCents)} a pack</span>
               </div>
               <StatusDot status={status} />
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
                     aria-label="Find Supplier"
                     title="Find Supplier"
                     onClick={() => onFindSupplier(item.id)}
                   >
                     <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                       <path d="M3 10.5 12 4l9 6.5" />
                       <path d="M5 9.5V20h14V9.5M9 20v-6h6v6" />
                     </svg>
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
          onClose={() => setUpdating(null)}
          onDone={(message, undo) => setDone({ message, undo })}
        />
      )}
      {showAdd && (
        <AddIngredientModal onClose={() => setShowAdd(false)} onSave={addInventoryItem} />
      )}
    </div>
  );
}