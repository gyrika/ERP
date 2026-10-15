import { useEffect, useState, type FormEvent } from 'react';
import { parsePacks } from '../domain/inventory.ts';
import { fmt, parseLKR } from '../domain/money.ts';
import { receiveStock, type InventoryRow } from '../services/inventoryStore.ts';
import { formatPacks, formatQuantity } from './quantity.ts';

/**
 * Serves the manager with a delivery in hand: they know how many packs and the
 * price, the app knows everything else. Saved at once with Undo on the screen.
 * Count opens the count screen (CountFlow: blind count, units, reasons).
 */
export function StockSheet({ item, onClose, onDone, onCount }: {
  item: InventoryRow;
  /** Count opens the count screen for this item. */
  onCount: () => void;
  onClose: () => void;
  /** What was recorded, and how to take it back. */
  onDone: (message: string, undo: () => void) => void;
}) {
  const [packs, setPacks] = useState('');
  const [price, setPrice] = useState(fmt(item.workingPriceCents));
  const [error, setError] = useState('');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const typed = parsePacks(packs);

  const save = (event: FormEvent) => {
    event.preventDefault();
    const received = packs.trim() === '' ? 0 : typed;
    const cents = parseLKR(price);
    if (received === null) return setError('Type the number of packs, like 2 or 1.5.');
    if (cents === null) return setError('Type the price per pack in rupees, like 6,400.');
    if (received === 0 && cents === item.workingPriceCents) return setError('Type the packs received, or a new price.');
    const undo = receiveStock(item, received, cents);
    const parts = [
      ...(received > 0 ? [`Received ${formatPacks(received)} of ${item.name}`] : [`${item.name}`]),
      ...(cents !== item.workingPriceCents ? [`price now Rs ${fmt(cents)} a pack`] : []),
    ];
    onDone(`${parts.join(', ')}.`, undo);
    onClose();
  };

  return (
    <div className="inv-modal-backdrop">
      <form className="inv-modal" role="dialog" aria-modal="true" aria-labelledby="stock-sheet-title" onSubmit={save}>
        <h2 id="stock-sheet-title">{item.name}</h2>
        <div className="inv-mode" role="group" aria-label="What happened">
          <button type="button" className="pill" aria-pressed>Received</button>
          <button type="button" className="pill" aria-pressed={false} onClick={onCount}>Count</button>
        </div>

        <label className="inv-modal__field">
          <span>
            Packs received
            <small>1 pack = {formatQuantity(item.packQty, item.baseUnit)}</small>
          </span>
          <input
            autoFocus className="inv-modal__input num" inputMode="decimal" value={packs} placeholder="0"
            onChange={(e) => { setPacks(e.target.value); setError(''); }}
          />
        </label>

        <label className="inv-modal__field">
          <span>Price per pack (Rs) <small>What the supplier charged</small></span>
          <input className="inv-modal__input num" inputMode="decimal" value={price} onChange={(e) => { setPrice(e.target.value); setError(''); }} />
        </label>

        {error && <p className="inv-modal__error" role="alert">{error}</p>}
        <div className="inv-modal__actions">
          <button type="button" className="inv-modal__cancel" onClick={onClose}>Cancel</button>
          <button type="submit" className="insight__action">Save</button>
        </div>
      </form>
    </div>
  );
}
