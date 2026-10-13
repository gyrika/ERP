import { useEffect, useState, type FormEvent } from 'react';
import { countDifference, parsePacks } from '../domain/inventory.ts';
import { fmt, parseLKR } from '../domain/money.ts';
import { countStock, receiveStock, type InventoryRow } from '../services/inventoryStore.ts';
import { formatPacks, formatQuantity } from './quantity.ts';

type Mode = 'received' | 'count';

/**
 * Serves the manager with a delivery in hand or a shelf in front of them: they
 * know how many packs, the app knows everything else. Two choices, one field
 * each (plus the price on a delivery), saved at once with Undo on the screen.
 */
export function StockSheet({ item, onClose, onDone }: {
  item: InventoryRow;
  onClose: () => void;
  /** What was recorded, and how to take it back. */
  onDone: (message: string, undo: () => void) => void;
}) {
  const [mode, setMode] = useState<Mode>('received');
  const [packs, setPacks] = useState('');
  const [price, setPrice] = useState(fmt(item.workingPriceCents));
  const [error, setError] = useState('');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const choose = (next: Mode) => { setMode(next); setPacks(''); setError(''); };
  const typed = parsePacks(packs);
  const expected = item.onHandBaseUnits / item.packQty;
  const difference = mode === 'count' && typed !== null ? countDifference(item, typed) : null;
  const unitOf = (n: number) => formatQuantity(n * item.packQty, item.baseUnit);

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (mode === 'received') {
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
    } else {
      if (typed === null) return setError('Type how many packs are on the shelf, like 2 or 0.5.');
      const undo = countStock(item, typed);
      onDone(`Counted ${formatPacks(typed)} of ${item.name}.`, undo);
    }
    onClose();
  };

  return (
    <div className="inv-modal-backdrop">
      <form className="inv-modal" role="dialog" aria-modal="true" aria-labelledby="stock-sheet-title" onSubmit={save}>
        <h2 id="stock-sheet-title">{item.name}</h2>
        <div className="inv-mode" role="group" aria-label="What happened">
          <button type="button" className="pill" aria-pressed={mode === 'received'} onClick={() => choose('received')}>Received</button>
          <button type="button" className="pill" aria-pressed={mode === 'count'} onClick={() => choose('count')}>Count</button>
        </div>

        <label className="inv-modal__field">
          <span>
            {mode === 'received' ? 'Packs received' : 'Packs on the shelf now'}
            <small>1 pack = {formatQuantity(item.packQty, item.baseUnit)}</small>
          </span>
          <input
            autoFocus key={mode} className="inv-modal__input num" inputMode="decimal" value={packs}
            placeholder={mode === 'received' ? '0' : 'e.g. 1.5'}
            onChange={(e) => { setPacks(e.target.value); setError(''); }}
          />
        </label>

        {mode === 'received' ? (
          <label className="inv-modal__field">
            <span>Price per pack (Rs) <small>What the supplier charged</small></span>
            <input className="inv-modal__input num" inputMode="decimal" value={price} onChange={(e) => { setPrice(e.target.value); setError(''); }} />
          </label>
        ) : (
          <p className="inv-modal__note" aria-live="polite">
            {item.counted ? `The app expects ${formatPacks(Math.max(0, expected))}.` : 'Not counted before: this sets the starting amount.'}
            {typed !== null && ` That is ${unitOf(typed)}.`}
            {difference !== null && item.counted && Math.abs(difference) >= 0.05 &&
              ` ${unitOf(Math.abs(difference))} ${difference < 0 ? 'less' : 'more'} than expected.`}
          </p>
        )}

        {error && <p className="inv-modal__error" role="alert">{error}</p>}
        <div className="inv-modal__actions">
          <button type="button" className="inv-modal__cancel" onClick={onClose}>Cancel</button>
          <button type="submit" className="insight__action">Save</button>
        </div>
      </form>
    </div>
  );
}
