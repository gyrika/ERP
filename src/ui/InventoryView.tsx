import { useState } from 'react';
import { addInventoryItem, useInventory } from '../services/inventoryStore.ts';
import { stockStatus } from '../domain/inventory.ts';
import { AddIngredientModal } from './AddIngredientModal.tsx';

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
  const { items } = useInventory();

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

      <main className="inv-rows" aria-label="Inventory">
        {items.map((item) => {
           const status = stockStatus(item);

           return (
             <article key={item.id} className="inv-row">
               <h2 className="inv-row__name">{item.name}</h2>
               <StatusDot status={status} />
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