import { useEffect, useState, type FormEvent } from 'react';
import { parsePacks } from '../domain/inventory.ts';
import { fmt, parseLKR } from '../domain/money.ts';
import { daysAgo, formatStock } from '../domain/itemStory.ts';
import type { Supplier } from '../domain/inventoryData.ts';
import { reasonLabel } from '../domain/counting.ts';
import { whatsAppLink } from '../domain/ordering.ts';
import { receiveStock, useItemStory, type InventoryRow } from '../services/inventoryStore.ts';
import { usePhotoUrl } from '../services/photos.ts';
import { formatLasts, formatPacks, formatQuantity } from './quantity.ts';

/**
 * Serves the manager with a delivery in hand: they know how many packs and the
 * price, the app knows everything else. Saved at once with Undo on the screen.
 * The item's whole story sits on top (SCRUM-93): what is on the shelf and how long
 * it lasts, the last count and delivery, the price and its last change, what uses
 * it, and who supplies it, so nothing feels missing. While its count is due the
 * shelf amount stays hidden (a blind count), and the sheet says so.
 * Count opens the count screen (CountFlow: blind count, units, reasons). Removing
 * the item lives here, out of the way, with Undo on the inventory screen.
 */
export function StockSheet({ item, suppliers = [], countDue = false, onClose, onDone, onCount, onOrder, onRemove }: {
  item: InventoryRow;
  /** Its suppliers, with phone numbers when saved. */
  suppliers?: Supplier[];
  /** Its count is due: the shelf amount stays hidden until it is counted. */
  countDue?: boolean;
  /** Order opens the order sheet for this item. */
  onOrder?: () => void;
  /** Count opens the count screen for this item. */
  onCount: () => void;
  onClose: () => void;
  /** Takes the item off the inventory (Undo on the inventory screen). */
  onRemove?: () => void;
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

  const story = useItemStory(item.id);
  const photo = usePhotoUrl(story.lastCount?.photo);
  const sources = suppliers.filter((x) => item.supplierIds.includes(x.id));
  const now = Date.now();
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
    <div className="inv-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="inv-modal stock-sheet" role="dialog" aria-modal="true" aria-labelledby="stock-sheet-title" onSubmit={save}>
        <button type="button" className="count__close" aria-label="Close" onClick={onClose}>×</button>
        <h2 id="stock-sheet-title">{item.name}</h2>

        <dl className="story" aria-label="About this item">
          <div>
            <dt>On the shelf</dt>
            <dd>
              {!item.counted ? 'Not counted yet: count it once to start'
                : countDue ? 'Count due: hidden until it is counted'
                : <><strong className="num">{formatStock(item.onHandBaseUnits, item)}</strong>
                  {[formatLasts(item.lastsDays), item.usedPerDay > 0 && `uses about ${formatQuantity(Math.round(item.usedPerDay), item.baseUnit)} a day`]
                    .filter(Boolean).map((t) => <span key={String(t)}>{t}</span>)}</>}
            </dd>
          </div>
          <div>
            <dt>Last count</dt>
            <dd>
              {story.lastCount
                ? <>{daysAgo(story.lastCount.at, now)} · {story.lastCount.by} · {story.lastCount.reason
                  ? `${formatQuantity(Math.abs(story.lastCount.delta), item.baseUnit)} ${story.lastCount.delta < 0 ? 'short' : 'over'}, ${reasonLabel(story.lastCount.reason).toLowerCase()}`
                  : story.lastCount.first ? 'first count' : 'matched'}</>
                : 'Never'}
              {story.lastCount?.photo && (photo
                ? <a className="story__photo" href={photo} target="_blank" rel="noreferrer"><img src={photo} alt={`Shelf photo from the last count of ${item.name}`} /></a>
                : <span>photo on the shop PC</span>)}
            </dd>
          </div>
          <div>
            <dt>Last delivery</dt>
            <dd>{story.lastDelivery ? `${daysAgo(story.lastDelivery.at, now)} · ${formatPacks(story.lastDelivery.packs)} · ${story.lastDelivery.by}` : 'None recorded yet'}</dd>
          </div>
          <div>
            <dt>Price</dt>
            <dd>
              <span className="num">Rs {fmt(item.workingPriceCents)} a pack of {formatQuantity(item.packQty, item.baseUnit)}</span>
              {story.lastPrice && (
                <span className={`story__price story__price--${story.lastPrice.after > story.lastPrice.before ? 'up' : 'down'}`}>
                  {story.lastPrice.after > story.lastPrice.before ? '↑' : '↓'} Rs {fmt(Math.abs(story.lastPrice.after - story.lastPrice.before))} {daysAgo(story.lastPrice.at, now)}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>Used in</dt>
            <dd>
              {story.usedIn.length === 0 ? 'No recipe uses it yet'
                : `${story.usedIn.length} menu ${story.usedIn.length === 1 ? 'item' : 'items'}: ${story.usedIn.slice(0, 4).join(', ')}${story.usedIn.length > 4 ? '…' : ''}`}
            </dd>
          </div>
          <div>
            <dt>{sources.length === 1 ? 'Supplier' : 'Suppliers'}</dt>
            <dd className="story__suppliers">
              {sources.length === 0 && 'None'}
              {sources.map((x) => (
                <span key={x.id} className="story__supplier">
                  {x.name}
                  {x.phone && <>
                    <a className="restock-action order__call" href={`tel:${x.phone}`}>Call</a>
                    <a className="restock-action restock-action--wa" href={whatsAppLink(x.phone, '')} target="_blank" rel="noreferrer">WhatsApp</a>
                  </>}
                </span>
              ))}
            </dd>
          </div>
        </dl>

        <div className="inv-mode" role="group" aria-label="What happened">
          <button type="button" className="pill" aria-pressed>Received</button>
          <button type="button" className="pill" aria-pressed={false} onClick={onCount}>Count</button>
          {onOrder && sources.length > 0 && <button type="button" className="pill" aria-pressed={false} onClick={onOrder}>Order</button>}
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
        {onRemove && (
          <button type="button" className="linkbtn inv-modal__remove" aria-label={`Remove ${item.name}`} onClick={onRemove}>Remove from inventory</button>
        )}
      </form>
    </div>
  );
}
