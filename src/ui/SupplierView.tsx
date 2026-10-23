import { useMemo, useState } from 'react';
import {
  addSupplier,
  archiveSupplier,
  editSupplier,
  restoreSupplier,
  useInventory,
} from '../services/inventoryStore.ts';
import { summariseSuppliers } from '../domain/inventory.ts';
import { SupplierCard } from './SupplierCard.tsx';
import { AddSupplierModal } from './AddSupplierModal.tsx';
import { ItemsTabs } from './ItemsTabs.tsx';
import { OwnerNav } from './OwnerNav.tsx';

type ArchivedSupplier = { id: string; name: string };
type EditedSupplier = { name: string; undo: () => void };

export function SupplierView({
  filterIngredientId = null,
  onRegister,
}: {
  filterIngredientId?: string | null;
  onRegister?: () => void;
} = {}) {
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [edited, setEdited] = useState<EditedSupplier | null>(null);
  const [archived, setArchived] = useState<ArchivedSupplier | null>(null);
  const [error, setError] = useState('');
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

  const removeSupplier = (supplierId: string, name: string) => {
    try {
      archiveSupplier(supplierId);
      setArchived({ id: supplierId, name });
      setEdited(null);
      setError('');
    } catch (cause) {
      if (!(cause instanceof Error)) throw cause;
      setError(cause.message);
    }
  };

  const undoArchive = () => {
    if (!archived) return;
    try {
      restoreSupplier(archived.id);
      setArchived(null);
      setError('');
    } catch (cause) {
      if (!(cause instanceof Error)) throw cause;
      setError(cause.message);
    }
  };

  const saveEdit: typeof editSupplier = (supplier, linkedItemIds, newIngredients) => {
    const undo = editSupplier(supplier, linkedItemIds, newIngredients);
    setEdited({ name: supplier.name.trim(), undo });
    setArchived(null);
    setError('');
    return undo;
  };

  const undoEdit = () => {
    edited?.undo();
    setEdited(null);
  };

  const editingSupplier = suppliers.find((s) => s.id === editing);

  return (
    <div className="inv-page">
      <OwnerNav current="items" onRegister={onRegister} />
      <ItemsTabs current="raw" />
      <div className="inv-page__head">
         <h1 className="supplier-heading">
           {filterIngredientId ? 'Targeted Suppliers' : 'All Suppliers'}
         </h1>
         <button type="button" className="insight__action" onClick={() => setShowAdd(true)}>+ Add Supplier</button>
      </div>

      {(archived || edited || error) && (
        <div className={`inv-notice${error ? ' inv-notice--error' : ''}`} role={error ? 'alert' : 'status'}>
          {error || (archived ? `${archived.name} removed from suppliers.` : `${edited?.name} updated.`)}
          {archived && !error && <button type="button" onClick={undoArchive}>Undo</button>}
          {edited && !archived && !error && <button type="button" onClick={undoEdit}>Undo</button>}
        </div>
      )}

      <main className="sup-grid supplier-grid" aria-label="Suppliers">
        {summaries.length === 0 ? (
          <div className="inv-empty">No suppliers found for this query.</div>
        ) : (
          summaries.map((summary) => (
            <SupplierCard
              key={summary.supplier.id}
              summary={summary}
              onEdit={setEditing}
              onArchive={(id) => removeSupplier(id, summary.supplier.name)}
            />
          ))
        )}
      </main>
      {showAdd && (
        <AddSupplierModal onClose={() => setShowAdd(false)} onSave={addSupplier} />
      )}
      {editingSupplier && (
        <AddSupplierModal supplier={editingSupplier} onClose={() => setEditing(null)} onSave={saveEdit} />
      )}
    </div>
  );
}