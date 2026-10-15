import { useEffect, useState, type FormEvent } from 'react';
import type { Supplier } from '../domain/inventoryData.ts';
import { parsePacks } from '../domain/inventory.ts';
import { receiveUnitOf, toPacks, unitName } from '../domain/counting.ts';
import { receiveStock, type InventoryRow } from '../services/inventoryStore.ts';
import { formatQuantity } from './quantity.ts';

/**
 * A delivery came (SCRUM-92). Serves the manager with one supplier's bill in hand:
 * they pick the supplier, see only that supplier's items, tap +1 or type the packs
 * for each line on the bill, and save once. Undo takes the whole delivery back.
 * A new price is still set on the item's own sheet. Each line is in what the owner chose
 * for that item (packs, kg, a Tray: SCRUM-96).
 */
export function DeliverySheet({ items, suppliers, onClose, onDone }: {
  items: InventoryRow[];
  suppliers: Supplier[];
  onClose: () => void;
  onDone: (message: string, undo: () => void) => void;
}) {
  const carried = suppliers.filter((s) => items.some((i) => i.supplierIds.includes(s.id)));
  const [supplierId, setSupplierId] = useState<string | null>(carried.length === 1 ? carried[0].id : null);
  const [packs, setPacks] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const supplier = carried.find((s) => s.id === supplierId) ?? null;
  const lines = supplier ? items.filter((i) => i.supplierIds.includes(supplier.id)) : [];
  const set = (id: string, value: string) => { setPacks({ ...packs, [id]: value }); setError(''); };
  const plusOne = (id: string) => set(id, String((parsePacks(packs[id] ?? '') ?? 0) + 1));

  const save = (event: FormEvent) => {
    event.preventDefault();
    const received: [InventoryRow, number][] = [];
    for (const row of lines) {
      const raw = (packs[row.id] ?? '').trim();
      if (!raw) continue;
      const n = parsePacks(raw);
      if (n === null) return setError(`Type the amount of ${row.name} as a number, like 2 or 1.5.`);
      if (n > 0) received.push([row, toPacks(n, receiveUnitOf(row), row.packQty)]);
    }
    if (received.length === 0) return setError('Tap +1 or type the packs for what came.');
    const undos = received.map(([row, n]) => receiveStock(row, n, row.workingPriceCents));
    const total = received.length;
    onDone(`Delivery from ${supplier!.name}: ${total} ${total === 1 ? 'item' : 'items'} in.`, () => undos.forEach((u) => u()));
    onClose();
  };

  return (
    <div className="inv-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="inv-modal delivery" role="dialog" aria-modal="true" aria-labelledby="delivery-title" onSubmit={save}>
        <button type="button" className="count__close" aria-label="Close" onClick={onClose}>×</button>
        <h2 id="delivery-title">{supplier ? `Delivery from ${supplier.name}` : 'Delivery came'}</h2>

        {!supplier ? (
          <>
            <p className="delivery__hint">Who brought it?</p>
            <div className="delivery__suppliers" role="group" aria-label="Supplier">
              {carried.map((s) => (
                <button key={s.id} type="button" className="chip" onClick={() => setSupplierId(s.id)}>{s.name}</button>
              ))}
            </div>
          </>
        ) : (
          <>
            {carried.length > 1 && (
              <button type="button" className="linkbtn delivery__change" onClick={() => { setSupplierId(null); setPacks({}); }}>Another supplier</button>
            )}
            <ul className="delivery__lines" aria-label="What came">
              {lines.map((row) => {
                const unit = receiveUnitOf(row);
                const name = unitName(unit);
                return (
                  <li key={row.id}>
                    <span className="delivery__name">
                      {row.name}
                      <small>{unit.id === 'pack' ? `${formatQuantity(row.packQty, row.baseUnit)} a pack` : `in ${name}`}</small>
                    </span>
                    <input
                      className="inv-modal__input num delivery__packs" inputMode="decimal" placeholder="0"
                      aria-label={unit.id === 'pack' ? `Packs of ${row.name}` : `${name} of ${row.name}`} value={packs[row.id] ?? ''} onChange={(e) => set(row.id, e.target.value)}
                    />
                    <button type="button" className="chip" aria-label={`One more ${name} of ${row.name}`} onClick={() => plusOne(row.id)}>+1</button>
                  </li>
                );
              })}
            </ul>
            {error && <p className="inv-modal__error" role="alert">{error}</p>}
            <div className="inv-modal__actions">
              <button type="button" className="inv-modal__cancel" onClick={onClose}>Cancel</button>
              <button type="submit" className="insight__action">Save delivery</button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
