import { useEffect, useState, type FormEvent } from 'react';
import { fmt, parseLKR } from '../domain/money.ts';
import { daysAgo, formatStock } from '../domain/itemStory.ts';
import type { Supplier } from '../domain/inventoryData.ts';
import { formatInUnit, fromPacks, packPrice, reasonLabel, receiveUnitOf, roundForUnit, toPacks, unitName, unitPrice, unitsOf } from '../domain/counting.ts';
import type { Actor } from '../domain/auth.ts';
import type { PurchaseState } from '../domain/purchaseOrders.ts';
import { setOrderBelow, setReceiveUnit, setWorkingPrice, useItemStory, type InventoryRow } from '../services/inventoryStore.ts';
import { parsePacks } from '../domain/inventory.ts';
import { CountItem } from './CountFlow.tsx';
import { ItemOrder } from './OrderSheet.tsx';
import type { DueCount } from '../domain/counting.ts';
import type { HistoryEntry } from '../domain/itemStory.ts';
import { wasteReasonLabel } from '../domain/waste.ts';
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
 * so does "Order when below" (SCRUM-135).
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
  const [price, setPrice] = useState(shownPrice);
  /** Choosing the receiving unit: asking the owner's PIN, then the choice. */
  const [unitEdit, setUnitEdit] = useState<'closed' | 'pin' | Actor>('closed');
  useEffect(() => setPrice(shownPrice), [shownPrice]);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const story = useItemStory(item.id, item.packQty);
  const photo = usePhotoUrl(story.lastCount?.photo);
  const sources = suppliers.filter((x) => item.supplierIds.includes(x.id));
  const now = Date.now();
  const tabs = TABS.filter((t) => t.id !== 'order' || purchases);
  /** Without purchase orders (the manager's phone), the sheet opens on Details. */
  const tabState: SheetTab = tab === 'order' && !purchases ? 'details' : tab;

  /** A new price the supplier charges (audited), with Undo. */
  const savePrice = (event: FormEvent) => {
    event.preventDefault();
    const typedCents = parseLKR(price);
    if (typedCents === null) return setError(`Type the price per ${name} in rupees, like 6,400.`);
    const before = item.workingPriceCents;
    const cents = packPrice(typedCents, unit, item.packQty);
    if (price.trim() === shownPrice || cents === before) return setError('That is the price already.');
    setWorkingPrice(item.id, cents);
    setDone({ message: `${item.name}: price now Rs ${fmt(unitPrice(cents, unit, item.packQty))} a ${name}.`, undo: () => setWorkingPrice(item.id, before), tab: 'order' });
  };

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
              onClick={() => { setTab(t.id); setError(''); }}>{t.label}</button>
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
        <ItemOrder item={item} items={items} suppliers={suppliers} purchases={purchases} />

        <div className="receive-unit">
          {unitEdit === 'closed' && (
            <>
              <span>Received in <b>{isPack ? `packs of ${formatQuantity(item.packQty, item.baseUnit)}` : name}</b></span>
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

        <OrderBelow item={item} onDone={(message, undo) => setDone({ message, undo, tab: 'order' })} />

        <form className="receive-price" onSubmit={savePrice}>
          <label className="inv-modal__field">
            <span>Price per {name} (Rs) <small>What the supplier charges</small></span>
            <input className="inv-modal__input num" inputMode="decimal" value={price} onChange={(e) => { setPrice(e.target.value); setError(''); }} />
          </label>
          {price.trim() !== shownPrice && <button type="submit" className="insight__action">Save price</button>}
          {error && <p className="inv-modal__error" role="alert">{error}</p>}
        </form>
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
 * "Order when below" (SCRUM-135): left empty, the reorder rule decides from how fast
 * it sells; an amount replaces that for this item. Typed and shown in what it is bought
 * in (packs, kg), kept in packs. The owner's PIN, then Undo.
 */
function OrderBelow({ item, onDone }: { item: InventoryRow; onDone: (message: string, undo: () => void) => void }) {
  const [edit, setEdit] = useState<'closed' | 'pin' | Actor>('closed');
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const current = item.orderBelowPacks;
  const unit = receiveUnitOf(item);
  const isPack = unit.id === 'pack';
  const shown = (packs: number) => formatInUnit(packs, unit, item.packQty);

  const start = (owner: Actor) => { setTyped(current === null ? '' : String(roundForUnit(fromPacks(current, unit, item.packQty)))); setError(''); setEdit(owner); };
  const save = (owner: Actor, packs: number | null) => {
    setEdit('closed');
    if (packs === current) return;
    setOrderBelow(item.id, packs, owner);
    onDone(packs === null ? `${item.name}: ordered automatically again.` : `${item.name}: order when below ${shown(packs)}.`,
      () => setOrderBelow(item.id, current, owner));
  };
  const submit = (event: FormEvent, owner: Actor) => {
    event.preventDefault();
    if (!typed.trim()) return save(owner, null);
    const n = parsePacks(typed);
    if (n === null || n <= 0) return setError(`Type a number of ${isPack ? 'packs' : unitName(unit)}, like 2, or leave it empty for automatic.`);
    save(owner, isPack ? n : Math.round(toPacks(n, unit, item.packQty) * 1e6) / 1e6);
  };

  return (
    <div className="receive-unit">
      {edit === 'closed' && (
        <>
          <span>Order when below <b>{current === null ? 'automatic' : shown(current)}</b>{current === null && <small> · from how fast it sells</small>}</span>
          {!isManagerPhone() && <button type="button" className="linkbtn" aria-label="Change order when below" onClick={() => setEdit('pin')}>Change</button>}
        </>
      )}
      {edit === 'pin' && <OwnerPin onOpen={start} onCancel={() => setEdit('closed')} refusal="Only the owner sets when to order." />}
      {typeof edit === 'object' && (
        <form className="order-below" onSubmit={(e) => submit(e, edit)}>
          <label className="inv-modal__field">
            <span>Order when below ({isPack ? 'packs' : unitName(unit)}) <small>Empty: automatic, from how fast it sells</small></span>
            <input className="inv-modal__input num" inputMode="decimal" placeholder="automatic" autoFocus value={typed}
              onChange={(e) => { setTyped(e.target.value); setError(''); }} />
          </label>
          <button type="submit" className="insight__action">Save</button>
          {current !== null && <button type="button" className="linkbtn" onClick={() => save(edit, null)}>Automatic</button>}
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
          {h.kind === 'delivery' && <span>Received {formatInUnit(h.packs, unit, item.packQty)}{unit.id === 'pack' && ` (${q(h.packs * item.packQty)})`}</span>}
          {h.kind === 'waste' && (
            <span>Wasted {q(h.qty)}{h.from !== item.name && <> · from {h.from}</>} · {h.note ? `${wasteReasonLabel(h.reason)}: ${h.note}` : wasteReasonLabel(h.reason)}</span>
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
