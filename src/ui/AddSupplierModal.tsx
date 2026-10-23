import { useEffect, useState } from 'react';
import { useCatalog } from '../services/inventoryStore.ts';
import { newLineId } from '../domain/order.ts';
import { AutoSuggestPills } from './AutoSuggestPills.tsx';
import type { NewIngredient } from '../services/inventoryStore.ts';
import { EMPTY_UNIT_PRICE, UnitPriceFields, unitPriceItem, type UnitPrice } from './UnitPriceFields.tsx';

export function AddSupplierModal({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (
    data: { id: string; name: string; phone?: string },
    linkedItemIds: string[],
    newIngredients: NewIngredient[],
  ) => void;
}) {
  const { items } = useCatalog();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [linkedItemIds, setLinkedItemIds] = useState<string[]>([]);
  const [newIngredients, setNewIngredients] = useState<({ name: string } & UnitPrice)[]>([]);
  const [error, setError] = useState('');
  const toggleItem = (id: string) => setLinkedItemIds((previous) =>
    previous.includes(id) ? previous.filter((selected) => selected !== id) : [...previous, id]);

  const addNewIngredient = (ingredientName: string) => {
    if (newIngredients.some((existing) => existing.name.toLowerCase() === ingredientName.toLowerCase())) {
      setError(`${ingredientName} is already in the new ingredient list.`);
      return;
    }
    setNewIngredients((previous) => [...previous, { name: ingredientName, ...EMPTY_UNIT_PRICE }]);
    setError('');
  };

  const priced = newIngredients.map((ingredient) => unitPriceItem(ingredient));
  const setUnitPrice = (ingredientName: string, next: UnitPrice) => setNewIngredients((previous) =>
    previous.map((ingredient) => (ingredient.name === ingredientName ? { ...ingredient, ...next } : ingredient)));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const submit = () => {
    if (priced.some((item) => !item)) return;
    try {
      onSave(
        { id: `sup_${newLineId()}`, name, ...(phone.trim() ? { phone: phone.trim() } : {}) },
        linkedItemIds,
        newIngredients.map(({ name: ingredientName }, i) => ({ name: ingredientName, ...priced[i]! })),
      );
      onClose();
    } catch (cause) {
      if (!(cause instanceof Error)) throw cause;
      setError(cause.message);
    }
  };

  return (
    <div className="inv-modal-backdrop">
      <section className="inv-modal" role="dialog" aria-modal="true" aria-labelledby="add-supplier-title">
        <h2 id="add-supplier-title">Add Supplier</h2>
        <label className="inv-modal__field">
          <span>Supplier name</span>
          <input autoFocus maxLength={120} className="inv-modal__input" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Fresh Farms" />
        </label>
        <label className="inv-modal__field">
          <span>Phone <small>Optional</small></span>
          <input className="inv-modal__input" type="tel" maxLength={40} value={phone} onChange={(event) => setPhone(event.target.value.replace(/[^\d+ -]/g, ''))} placeholder="+94 77…" />
        </label>
        <div className="inv-modal__field">
          <span>Ingredients supplied <small>Required · select existing ingredients or add new ones</small></span>
          <AutoSuggestPills
            options={items.map(({ id, name: itemName }) => ({ id, name: itemName }))}
            selectedIds={linkedItemIds}
            onToggle={toggleItem}
            placeholder="Search ingredients…"
            label="Ingredients"
            onAddCustom={addNewIngredient}
          />
          {newIngredients.map((ingredient) => (
            <div key={ingredient.name} className="inv-new-ingredient" aria-label={`New ingredient ${ingredient.name}`}>
              <button
                type="button"
                className="inv-suggest__pill"
                aria-label={`Remove new ingredient ${ingredient.name}`}
                onClick={() => setNewIngredients((previous) => previous.filter((other) => other.name !== ingredient.name))}
              >
                {ingredient.name} <span aria-hidden="true">×</span>
              </button>
              <UnitPriceFields name={ingredient.name} value={ingredient} onChange={(next) => setUnitPrice(ingredient.name, next)} />
            </div>
          ))}
        </div>
        {error && <p className="inv-modal__error" role="alert">{error}</p>}
        <div className="inv-modal__actions">
          <button type="button" className="inv-modal__cancel" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="insight__action"
            disabled={!name.trim() || (linkedItemIds.length === 0 && newIngredients.length === 0) || priced.some((item) => !item)}
            onClick={submit}
          >
            Save Supplier
          </button>
        </div>
      </section>
    </div>
  );
}
