import { useEffect, useState } from 'react';
import { newLineId } from '../domain/order.ts';
import { useCatalog } from '../services/inventoryStore.ts';
import { AutoSuggestPills } from './AutoSuggestPills.tsx';

export function AddIngredientModal({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (data: {
    id: string;
    name: string;
    supplierIds: string[];
    category: string;
    baseUnit: 'pcs';
    packQty: number;
    workingPriceCents: number;
  }) => void;
}) {
  const { suppliers } = useCatalog();
  const [name, setName] = useState('');
  const [supplierIds, setSupplierIds] = useState<string[]>([]);
  const [error, setError] = useState('');
  const toggleSupplier = (id: string) => setSupplierIds((previous) =>
    previous.includes(id) ? previous.filter((selected) => selected !== id) : [...previous, id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const submit = () => {
    try {
      onSave({
        id: `inv-${newLineId()}`,
        name: name.trim(),
        supplierIds,
        category: 'General',
        baseUnit: 'pcs',
        packQty: 1,
        workingPriceCents: 0,
      });
      onClose();
    } catch (cause) {
      if (!(cause instanceof Error)) throw cause;
      setError(cause.message);
    }
  };

  return (
    <div className="inv-modal-backdrop">
      <section className="inv-modal" role="dialog" aria-modal="true" aria-labelledby="add-ingredient-title">
        <h2 id="add-ingredient-title">Add Ingredient</h2>
        <label className="inv-modal__field">
          <span>Ingredient name</span>
          <input autoFocus maxLength={120} className="inv-modal__input" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Sea Salt" />
        </label>
        <div className="inv-modal__field">
          <span>Suppliers <small>At least one · select any number</small></span>
          <AutoSuggestPills
            options={suppliers.map(({ id, name: supplierName }) => ({ id, name: supplierName }))}
            selectedIds={supplierIds}
            onToggle={toggleSupplier}
            placeholder="Search suppliers…"
            label="Suppliers"
          />
        </div>
        {error && <p className="inv-modal__error" role="alert">{error}</p>}
        <p className="inv-modal__note">New ingredients start as general items measured in pieces. You can update their stock after saving.</p>
        <div className="inv-modal__actions">
          <button type="button" className="inv-modal__cancel" onClick={onClose}>Cancel</button>
          <button type="button" className="insight__action" disabled={!name.trim() || supplierIds.length === 0} onClick={submit}>Save Ingredient</button>
        </div>
      </section>
    </div>
  );
}
