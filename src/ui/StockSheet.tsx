import { useEffect, useState, type FormEvent } from 'react';
import { fmt } from '../domain/money.ts';
import { daysAgo, formatStock } from '../domain/itemStory.ts';
import type { Supplier } from '../domain/inventoryData.ts';
import { formatInUnit, fromPacks, reasonLabel, receiveUnitOf, roundForUnit, toPacks, unitName, unitPrice, unitsOf } from '../domain/counting.ts';
import type { Actor } from '../domain/auth.ts';
import type { PurchaseState } from '../domain/purchaseOrders.ts';
import { setOrderBelow, setReceiveUnit, useItemStory, type InventoryRow } from '../services/inventoryStore.ts';
import { parsePacks } from '../domain/inventory.ts';
import { CountItem } from './CountFlow.tsx';
import { HomeChips } from './WarehousesView.tsx';
import { ItemOrder } from './OrderSheet.tsx';
import type { DueCount } from '../domain/counting.ts';
import type { HistoryEntry } from '../domain/itemStory.ts';
import { wasteReasonLabel } from '../domain/waste.ts';
import { rawValue } from '../domain/valuation.ts';
import { NumberInput } from './NumberInput.tsx';
import { OwnerPin } from './OwnerPin.tsx';
import { isManagerPhone } from '../services/pairing.ts';
import { usePhotoUrl } from '../services/photos.ts';
import { formatLasts, formatQuantity } from './quantity.ts';

/**
 * Serves the manager looking at one item: Details (its story, and counting it) · Order · History.
 * Stock comes in only through a GRN against a purchase order; Order here is the same
 * draft as Purchase orders, started from this item. The item's whole story sits on top (SCRUM-93): what is on the shelf and how long
 * it lasts, the last count and delivery, the price and its last change, what uses
 * it, and who supplies it, so nothing feels missing. While its count is due the
 * shelf amount stays hidden (a blind count), and the sheet says so.
 * Receiving is counted in what the owner chose for this item (SCRUM-96): packs, kg,
 * or a unit like Tray; the price is per that unit too. Changing it needs his PIN, and
 * so does the low stock margin, "Order when below" (SCRUM-135), on Details.
 * Details · Order · History are tabs of this one sheet (SCRUM-97): counting
 * or ordering this item never leaves it, and what was just done shows here with its
 * Undo. History lists every count (with its gap, reason, photo and the owner's word),
 * delivery and price change, newest first. Removing the item lives here, out of the
 * way, with Undo on the inventory screen.
 */
export type SheetTab = 'details' | 'order' | 'history';
const TABS: { id: SheetTab; label: string }[] = [
  { id: 'details', label: 'Details' }, { id: 'order', label: 'Order' }, { id: 'history', label: 'History' },
];

export function StockSheet({ item, items = [item], suppliers = [], purchases, countAs, countDue = false, tab: firstTab = 'details', photoRequired, onClose, onRemove }: {
  item: InventoryRow;
  /** Every item: an order takes this supplier's other items that need ordering too. */
  items?: InventoryRow[];
  /** Its suppliers, with phone numbers when saved. */
  suppliers?: Supplier[];
  /** Open orders and the next numbers; without them there is no Order tab. */
  purchases?: PurchaseState;
  /** How a count of it is recorded (its list, and whether it is a first count). */
  countAs?: DueCount;
  /** Its count is due: a blind count, so the shelf amount stays hidden until it is counted. */
  countDue?: boolean;
  /** The tab it opens on . */
  tab?: SheetTab;
  /** A big gap needs a shelf photo (the manager's phone). */
  photoRequired?: boolean;
  onClose: () => void;
  /** Takes the item off the inventory (Undo on the inventory screen). */
  onRemove?: () => void;
}) {
  const [tab, setTab] = useState<SheetTab>(firstTab);
  /** What was just done in this sheet, with its Undo. */
  const [done, setDone] = useState<{ message: string; undo: () => void; tab: SheetTab } | null>(null);
  /** A new key starts a fresh count form after each saved count. */
  const [countKey, setCountKey] = useState(0);
  const unit = receiveUnitOf(item);
  const isPack = unit.id === 'pack';
  const name = unitName(unit);
  const shownPrice = fmt(unitPrice(item.workingPriceCents, unit, item.packQty));
  /** Choosing the receiving unit: asking the owner's PIN, then the choice. */
  const [unitEdit, setUnitEdit] = useState<'closed' | 'pin' | Actor>('closed');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const story = useItemStory(item.id, item.packQty, item.workingPriceCents);
  const value = rawValue(item);
  const photo = usePhotoUrl(story.lastCount?.photo);
  const sources = suppliers.filter((x) => item.supplierIds.includes(x.id));
  const now = Date.now();
  const tabs = TABS.filter((t) => t.id !== 'order' || purchases);
  /** Without purchase orders (the manager's phone), the sheet opens on Details. */
  const tabState: SheetTab = tab === 'order' && !purchases ? 'details' : tab;

  const counted = (gapCents: number, big: boolean, undo: () => void) => {
    setDone({ message: big ? `Counted: gap of Rs ${fmt(Math.abs(gapCents))} saved.` : 'Counted: it matches.', undo, tab: 'details' });
    setCountKey(countKey + 1);
    setTab('history');
  };

  return (
    <div className="inv-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="inv-modal stock-sheet" role="dialog" aria-modal="true" aria-labelledby="stock-sheet-title">
        <button type="button" className="count__close" aria-label="Close" onClick={onClose}>×</button>
        <h2 id="stock-sheet-title">{item.name}</h2>

        <div className="inv-mode sheet-tabs" role="tablist" aria-label={item.name}>
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} className="pill" aria-selected={tabState === t.id} aria-controls={`panel-${t.id}`}
              onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </div>

        {done && (
          <p className="count__saved" role="status">
            {done.message}
            <button type="button" className="linkbtn" onClick={() => { done.undo(); setDone(null); setTab(done.tab); }}>Undo</button>
          </p>
        )}

        {tabState === 'details' && (
          <div role="tabpanel" id="panel-details" aria-labelledby="tab-details" className="sheet-panel">
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
            {value.cents !== null && !countDue && (
              <div>
                <dt>Value</dt>
                <dd><strong className="num">Rs {fmt(value.cents)}</strong></dd>
              </div>
            )}
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
              <dd>{story.lastDelivery ? `${daysAgo(story.lastDelivery.at, now)} · ${formatInUnit(story.lastDelivery.packs, unit, item.packQty)} · ${story.lastDelivery.by}` : 'None recorded yet'}</dd>
            </div>
            <div>
              <dt>Price</dt>
              <dd>
                <span className="num">{isPack ? `Rs ${fmt(item.workingPriceCents)} a pack of ${formatQuantity(item.packQty, item.baseUnit)}` : `Rs ${shownPrice} a ${name}`}</span>
                {story.lastPrice && (
                  <span className={`story__price story__price--${story.lastPrice.after > story.lastPrice.before ? 'up' : 'down'}`}>
                    {story.lastPrice.after > story.lastPrice.before ? '↑' : '↓'} Rs {fmt(Math.abs(story.lastPrice.after - story.lastPrice.before))} {daysAgo(story.lastPrice.at, now)}
                  </span>
                )}
              </dd>
            </div>
            {/* Where it is kept (SCRUM-186): deliveries go there and it is counted there. */}
            <div>
              <dt>Kept in</dt>
              <dd><HomeChips stockKey={`stock:${item.id}`} name={item.name} onDone={(message, undo) => setDone({ message, undo, tab: 'details' })} /></dd>
            </div>
            {/* The low stock margin: the one thing here that can be changed (the owner's PIN). */}
            <div>
              <dt>Low stock below</dt>
              <dd><OrderBelow item={item} onDone={(message, undo) => setDone({ message, undo, tab: 'details' })} /></dd>
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
                  </span>
                ))}
              </dd>
            </div>
          </dl>
            <h3 className="sheet-panel__title">Count it now</h3>
            <CountItem key={countKey} embedded row={item} position=""
              due={countAs ?? { id: item.id, tier: 'monthly', state: item.counted ? 'due' : 'never', lastCountedAt: item.lastCountedAt }}
              photoRequired={photoRequired ?? isManagerPhone()} onSaved={counted} />
          </div>
        )}

        {tabState === 'history' && (
          <div role="tabpanel" id="panel-history" aria-labelledby="tab-history"><History item={item} entries={story.history} /></div>
        )}

        {tabState === 'order' && purchases && (
        <div role="tabpanel" id="panel-order" aria-labelledby="tab-order" className="sheet-panel">
        {/* First the price per pack with the packs on its right, then Add to cart, then the pack settings. */}
        <ItemOrder item={item} items={items} suppliers={suppliers} purchases={purchases} />

        <div className="receive-unit">
          {unitEdit === 'closed' && (
            <>
              <span>Pack settings <b>{isPack ? `packs of ${formatQuantity(item.packQty, item.baseUnit)}` : name}</b></span>
              {/* The owner's PIN is checked at the shop; the phone apps cannot (SCRUM-94). */}
              {!isManagerPhone() && <button type="button" className="linkbtn" onClick={() => setUnitEdit('pin')}>Change</button>}
            </>
          )}
          {unitEdit === 'pin' && <OwnerPin onOpen={setUnitEdit} onCancel={() => setUnitEdit('closed')} refusal="Only the owner chooses how it is received." />}
          {typeof unitEdit === 'object' && (
            <div className="chips" role="group" aria-label="Received in">
              {unitsOf(item).map((u) => (
                <button key={u.id} type="button" className="chip" aria-pressed={u.id === unit.id}
                  onClick={() => { setReceiveUnit(item.id, u.id, unitEdit); setUnitEdit('closed'); }}>{u.label}</button>
              ))}
            </div>
          )}
        </div>

        </div>
        )}

        {onRemove && (
          <button type="button" className="linkbtn inv-modal__remove" aria-label={`Remove ${item.name}`} onClick={onRemove}>Remove from inventory</button>
        )}
      </section>
    </div>
  );
}

/**
 * The low stock margin, "Order when below" (SCRUM-135), on Details: Automatic (the reorder
 * rule decides from how fast it sells) or an amount for this item, typed and shown in what it
 * is bought in (packs, kg), kept in packs. Below it the item is Low: its supplier's cart, Low
 * on Items, Orders. Two buttons, never an empty box that secretly means automatic
 * (SCRUM-137). The owner's PIN, then Undo.
 */
function OrderBelow({ item, onDone }: { item: InventoryRow; onDone: (message: string, undo: () => void) => void }) {
  const [edit, setEdit] = useState<'closed' | 'pin' | Actor>('closed');
  const [mode, setMode] = useState<'auto' | 'number'>('auto');
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const current = item.orderBelowPacks;
  const unit = receiveUnitOf(item);
  const isPack = unit.id === 'pack';
  const shown = (packs: number) => formatInUnit(packs, unit, item.packQty);

  const start = (owner: Actor) => {
    setMode(current === null ? 'auto' : 'number');
    setTyped(current === null ? '' : String(roundForUnit(fromPacks(current, unit, item.packQty))));
    setError('');
    setEdit(owner);
  };
  const save = (owner: Actor, packs: number | null) => {
    setEdit('closed');
    if (packs === current) return;
    setOrderBelow(item.id, packs, owner);
    onDone(packs === null ? `${item.name}: low stock worked out automatically again.` : `${item.name}: low stock below ${shown(packs)}.`,
      () => setOrderBelow(item.id, current, owner));
  };
  const submit = (event: FormEvent, owner: Actor) => {
    event.preventDefault();
    if (mode === 'auto') return save(owner, null);
    const n = parsePacks(typed);
    if (n === null || n <= 0) return setError(`Type how many ${isPack ? 'packs' : unitName(unit)}, more than 0, or choose Automatic.`);
    save(owner, isPack ? n : Math.round(toPacks(n, unit, item.packQty) * 1e6) / 1e6);
  };

  return (
    <div className="receive-unit">
      {edit === 'closed' && (
        <>
          <span><b>{current === null ? 'automatic' : shown(current)}</b>{current === null && <small> · from how fast it sells</small>}</span>
          {!isManagerPhone() && <button type="button" className="linkbtn" aria-label="Change low stock below" onClick={() => setEdit('pin')}>Change</button>}
        </>
      )}
      {edit === 'pin' && <OwnerPin onOpen={start} onCancel={() => setEdit('closed')} refusal="Only the owner sets when to order." />}
      {typeof edit === 'object' && (
        <form className="order-below" onSubmit={(e) => submit(e, edit)}>
          <div className="chips" role="group" aria-label="When to order">
            <button type="button" className="chip" aria-pressed={mode === 'auto'} onClick={() => { setMode('auto'); setError(''); }}>Automatic</button>
            <button type="button" className="chip" aria-pressed={mode === 'number'} onClick={() => { setMode('number'); setError(''); }}>Set a number</button>
          </div>
          {mode === 'auto'
            ? <p className="inv-modal__note">Ordered when it would not last until the next delivery, from how fast it sells.</p>
            : (
              <label className="inv-modal__field">
                <span>Low stock below</span>
                <NumberInput className="inv-modal__input" unit={isPack ? 'packs' : unitName(unit)} autoFocus value={typed}
                  onText={(text) => { setTyped(text); setError(''); }} />
              </label>
            )}
          <button type="submit" className="insight__action">Save</button>
          {error && <p className="inv-modal__error" role="alert">{error}</p>}
        </form>
      )}
    </div>
  );
}

/** Everything that happened to this item, newest first (SCRUM-97). */
function History({ item, entries }: { item: InventoryRow; entries: HistoryEntry[] }) {
  const now = Date.now();
  if (!entries.length) return <p className="history__none">Nothing yet: no counts, deliveries, waste or price changes for {item.name}.</p>;
  const q = (n: number) => formatQuantity(Math.abs(n), item.baseUnit);
  const unit = receiveUnitOf(item);
  const per = unit.id === 'pack' ? 'a pack' : `a ${unitName(unit)}`;
  const rs = (packCents: number) => fmt(unitPrice(packCents, unit, item.packQty));
  return (
    <ol className="history" aria-label={`History of ${item.name}`}>
      {entries.map((h, i) => (
        <li key={i} className={`history__item history__item--${h.kind}`}>
          <span className="history__when">{daysAgo(h.at, now)} · {h.by}</span>
          {h.kind === 'count' && <HistoryCount item={item} h={h} q={q} />}
          {h.kind === 'delivery' && <span>Received {formatInUnit(h.packs, unit, item.packQty)}{unit.id === 'pack' && ` (${q(h.packs * item.packQty)})`}{h.valueCents !== undefined && <> · Rs {fmt(h.valueCents)}</>}</span>}
          {h.kind === 'waste' && (
            <span>Wasted {q(h.qty)}{h.valueCents !== undefined && <> (Rs {fmt(h.valueCents)})</>}{h.from !== item.name && <> · from {h.from}</>} · {h.note ? `${wasteReasonLabel(h.reason)}: ${h.note}` : wasteReasonLabel(h.reason)}</span>
          )}
          {h.kind === 'price' && (
            <span>Price Rs {rs(h.before)} → <b>Rs {rs(h.after)}</b> {per}
              <span className={`story__price story__price--${h.after > h.before ? 'up' : 'down'}`}> {h.after > h.before ? '↑' : '↓'} Rs {rs(Math.abs(h.after - h.before))}</span>
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

function HistoryCount({ item, h, q }: { item: InventoryRow; h: Extract<HistoryEntry, { kind: 'count' }>; q: (n: number) => string }) {
  const photo = usePhotoUrl(h.photo);
  const review = h.review;
  return (
    <>
      <span>
        Counted <b>{q(h.counted)}</b>
        {h.first ? ' · first count' : <> · expected {q(Math.max(0, h.expected))} · {h.reason
          ? <span className={h.delta < 0 ? 'history__short' : undefined}>{q(h.delta)} {h.delta < 0 ? 'short' : 'over'} (Rs {fmt(Math.abs(h.valueCents))}) · {reasonLabel(h.reason)}</span>
          : 'matched'}</>}
      </span>
      {h.photo && (photo
        ? <a href={photo} target="_blank" rel="noreferrer"><img className="history__photo" src={photo} alt={`Shelf photo of ${item.name}`} /></a>
        : <span className="history__sub">photo</span>)}
      {review && review.kind === 'ok' && <span className="history__sub">Owner: OK</span>}
      {review && review.kind === 'asked' && (
        <span className="history__sub">{review.by} asked: {review.note || 'Please explain.'}{review.answer ? ` · ${review.answer.by}: ${review.answer.note}` : ' · not answered yet'}</span>
      )}
    </>
  );
}
