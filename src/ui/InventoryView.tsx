import { useState } from 'react';
import {
  addInventoryItem,
  archiveInventoryItem,
  restoreInventoryItem,
  useInventory,
} from '../services/inventoryStore.ts';
import { stockStatus } from '../domain/inventory.ts';
import { AddIngredientModal } from './AddIngredientModal.tsx';

const formatQuantity = (quantity: number, unit: 'g' | 'ml' | 'pcs' | 'sheets'): string => {
  const scaled = unit === 'g' && quantity >= 1000
    ? { value: quantity / 1000, unit: 'kg' }
    : unit === 'ml' && quantity >= 1000
      ? { value: quantity / 1000, unit: 'L' }
      : { value: quantity, unit };
  const value = Number(scaled.value.toFixed(2)).toString();
  return `${value} ${scaled.unit}`;
};

// Extracted purely for visual mapping of your existing .dot classes
const StatusDot = ({ status }: { status: 'out' | 'low' | 'ok' }) => {
  const statusMap = {
    out: 'dot--out',
    low: 'dot--low',
    ok: 'dot--ok',
  };

  return <span className={`dot ${statusMap[status]}`} aria-label={`Status: ${status}`} />;
};

export function InventoryView({
  onFindSupplier,
  onOwnerView,
}: {
  onFindSupplier?: (id: string) => void;
  onOwnerView?: () => void;
} = {}) {
  const [showAdd, setShowAdd] = useState(false);
  const [archived, setArchived] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState('');
  const { items, suppliers } = useInventory();
  const supplierNames = new Map(suppliers.map((supplier) => [supplier.id, supplier.name]));

  const removeItem = (id: string, name: string) => {
    try {
      archiveInventoryItem(id);
      setArchived({ id, name });
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
      <header className="inv-page__head">
         <h1 className="supplier-heading">Inventory Dashboard</h1>
         <nav className="inv-page__nav" aria-label="Inventory navigation">
           <a className="inv-page__link" href="#suppliers">Suppliers</a>
           {onOwnerView && (
             <button type="button" className="inv-page__link" onClick={onOwnerView}>Owner view</button>
           )}
         </nav>
         <button type="button" className="insight__action" onClick={() => setShowAdd(true)}>+ Add Ingredient</button>
      </header>

      {(archived || error) && (
        <div className={`inv-notice${error ? ' inv-notice--error' : ''}`} role={error ? 'alert' : 'status'}>
          {error || `${archived?.name} removed from inventory.`}
          {archived && !error && <button type="button" onClick={undoArchive}>Undo</button>}
        </div>
      )}

      <main className="inv-rows" aria-label="Inventory">
        {items.map((item) => {
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
                   {formatQuantity(item.onHandBaseUnits ?? item.onHandPacks * item.packQty, item.baseUnit)}
                   {' / '}
                   {formatQuantity(item.packQty, item.baseUnit)}
                 </strong>
               </div>
               <StatusDot status={status} />
               <div className="inv-row__actions">
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
      {showAdd && (
        <AddIngredientModal onClose={() => setShowAdd(false)} onSave={addInventoryItem} />
      )}
    </div>
  );
}