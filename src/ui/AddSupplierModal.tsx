import { useEffect, useState } from 'react';
import { useInventory } from '../services/inventoryStore.ts';
import { newLineId } from '../domain/order.ts';
import { AutoSuggestPills } from './AutoSuggestPills.tsx';

export function AddSupplierModal({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (data: { id: string; name: string; phone?: string }, linkedItemIds: string[]) => void;
}) {
  const { items } = useInventory();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [linkedItemIds, setLinkedItemIds] = useState<string[]>([]);
  const [error, setError] = useState('');
  const toggleItem = (id: string) => setLinkedItemIds((previous) =>
    previous.includes(id) ? previous.filter((selected) => selected !== id) : [...previous, id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const submit = () => {
    try {
      onSave({ id: `sup_${newLineId()}`, name, ...(phone.trim() ? { phone: phone.trim() } : {}) }, linkedItemIds);
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
          <input className="inv-modal__input" type="tel" maxLength={40} value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+94 77…" />
        </label>
        <div className="inv-modal__field">
          <span>Ingredients supplied <small>Optional · select any number</small></span>
          <AutoSuggestPills
            options={items.map(({ id, name: itemName }) => ({ id, name: itemName }))}
            selectedIds={linkedItemIds}
            onToggle={toggleItem}
            placeholder="Search ingredients…"
            label="Ingredients"
          />
        </div>
        {error && <p className="inv-modal__error" role="alert">{error}</p>}
        <div className="inv-modal__actions">
          <button type="button" className="inv-modal__cancel" onClick={onClose}>Cancel</button>
          <button type="button" className="insight__action" disabled={!name.trim()} onClick={submit}>Save Supplier</button>
        </div>
      </section>
    </div>
  );
}
