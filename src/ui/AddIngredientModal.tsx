import { useEffect, useState } from 'react';
import { newLineId } from '../domain/order.ts';
import { useCatalog } from '../services/inventoryStore.ts';
import type { BaseUnit } from '../domain/inventoryData.ts';
import type { Cents } from '../domain/types.ts';
import { AutoSuggestPills } from './AutoSuggestPills.tsx';
import { EMPTY_UNIT_PRICE, UnitPriceFields, unitPriceItem } from './UnitPriceFields.tsx';

export function AddIngredientModal({
  onClose,
  onSave,
  initialName = '',
  initialSupplierIds = [],
}: {
  onClose: () => void;
  /** Typed already (Order › Add an item, SCRUM-185). */
  initialName?: string;
  /** The supplier being ordered from, chosen already. */
  initialSupplierIds?: string[];
  onSave: (data: {
    id: string;
    name: string;
    supplierIds: string[];
    category: string;
    baseUnit: BaseUnit;
    packQty: number;
    workingPriceCents: Cents;
  }) => void;
}) {
  const { suppliers } = useCatalog();
  const [name, setName] = useState(initialName);
  const [supplierIds, setSupplierIds] = useState<string[]>(initialSupplierIds);
  const [unitPrice, setUnitPrice] = useState(EMPTY_UNIT_PRICE);
  const [error, setError] = useState('');
  const priced = unitPriceItem(unitPrice);
  const toggleSupplier = (id: string) => setSupplierIds((previous) =>
    previous.includes(id) ? previous.filter((selected) => selected !== id) : [...previous, id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const submit = () => {
    if (!priced) return;
    try {
      onSave({
        id: `inv-${newLineId()}`,
        name: name.trim(),
        supplierIds,
        category: 'General',
        ...priced,
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
        <UnitPriceFields value={unitPrice} onChange={setUnitPrice} />
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
        <div className="inv-modal__actions">
          <button type="button" className="inv-modal__cancel" onClick={onClose}>Cancel</button>
          <button type="button" className="insight__action" disabled={!name.trim() || !priced || supplierIds.length === 0} onClick={submit}>Save Ingredient</button>
        </div>
      </section>
    </div>
  );
}
