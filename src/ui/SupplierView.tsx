import { useMemo, useState } from 'react';
import { addSupplier, useInventory } from '../services/inventoryStore.ts';
import { summariseSuppliers } from '../domain/inventory.ts';
import { SupplierCard } from './SupplierCard.tsx';
import { AddSupplierModal } from './AddSupplierModal.tsx';

export function SupplierView({
  filterIngredientId = null,
  onOwnerView,
}: {
  filterIngredientId?: string | null;
  onOwnerView?: () => void;
} = {}) {
  const [showAdd, setShowAdd] = useState(false);
  const { items, suppliers } = useInventory();

  // Execute the exact targeted filter logic
  const visibleSuppliers = useMemo(() => {
    if (!filterIngredientId) return suppliers;

    const targetItem = items.find(i => i.id === filterIngredientId);
    if (!targetItem) return suppliers;

    return suppliers.filter(s => targetItem.supplierIds.includes(s.id));
  }, [suppliers, items, filterIngredientId]);

  // Generate summaries only for the suppliers we want to see
  const summaries = useMemo(() =>
    summariseSuppliers(items, visibleSuppliers),
  [items, visibleSuppliers]);

  return (
    <div className="inv-page">
      <header className="inv-page__head">
         <h1 className="supplier-heading">
           {filterIngredientId ? 'Targeted Suppliers' : 'All Suppliers'}
         </h1>
         <nav className="inv-page__nav" aria-label="Supplier navigation">
           <a className="inv-page__link" href="#inventory">Inventory</a>
           {onOwnerView && (
             <button type="button" className="inv-page__link" onClick={onOwnerView}>Owner view</button>
           )}
         </nav>
         <button type="button" className="insight__action" onClick={() => setShowAdd(true)}>+ Add Supplier</button>
      </header>

      <main className="sup-grid supplier-grid" aria-label="Suppliers">
        {summaries.length === 0 ? (
          <div className="inv-empty">No suppliers found for this query.</div>
        ) : (
          summaries.map((summary) => (
            <SupplierCard key={summary.supplier.id} summary={summary} />
          ))
        )}
      </main>
      {showAdd && (
        <AddSupplierModal onClose={() => setShowAdd(false)} onSave={addSupplier} />
      )}
    </div>
  );
}