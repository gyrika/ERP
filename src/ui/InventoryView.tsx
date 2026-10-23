import { useMemo, useState } from 'react';
import {
  addInventoryItem,
  archiveInventoryItem,
  restoreInventoryItem,
  useInventory,
  usePurchases,
  useStockSettings,
  type StockStatus,
} from '../services/inventoryStore.ts';
import { stockStatus } from '../domain/inventory.ts';
import { draftsOf } from '../domain/ordering.ts';
import { AddIngredientModal } from './AddIngredientModal.tsx';
import { OwnerNav } from './OwnerNav.tsx';
import { formatLasts, formatQuantity } from './quantity.ts';
import { daysAgo, formatStock } from '../domain/itemStory.ts';
import { StockSheet, type SheetTab } from './StockSheet.tsx';
import { CountFlow } from './CountFlow.tsx';
import { GoodsReceivingSheet } from './GoodsReceivingSheet.tsx';
import { OrderSheet } from './OrderSheet.tsx';
import { onOrder } from '../domain/purchaseOrders.ts';
import { countsDue, tiersOf, type DueCount } from '../domain/counting.ts';

const STATUS_LABELS: Record<StockStatus, string> = {
  out: 'Out of stock',
  low: 'Low stock',
  unsure: 'Check shelf',
  ok: 'In stock',
  unknown: 'Not counted yet',
};

/**
 * Inventory (SCRUM-92: fewer buttons). Tap a row to open its sheet (received, count,
 * remove); "Purchase orders" is the one place to order (drafts written by
 * `suggestions`); "Goods receiving" takes a delivery against its order (GRN). The supplier's name opens that supplier.
 */

/** Why a row says "Check shelf": what it has not been able to take off. */
const missedText = (n: number) => `${n} sold since the last count not taken off`;


export function InventoryView({
  onFindSupplier,
  onRegister,
}: {
  onFindSupplier?: (id: string) => void;
  onRegister?: () => void;
} = {}) {
  const [showAdd, setShowAdd] = useState(false);
  const [archived, setArchived] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  /** The item whose sheet is open, and on which tab. */
  const [updating, setUpdating] = useState<string | null>(null);
  const [sheetTab, setSheetTab] = useState<SheetTab>('order');
  const [delivery, setDelivery] = useState(false);
  const [ordering, setOrdering] = useState(false);
  /** The last stock change, with its Undo (instant action, visible Undo: no confirmations). */
  const [done, setDone] = useState<{ message: string; undo?: () => void } | null>(null);
  const { items, suppliers, untrackedSold } = useInventory();
  const purchases = usePurchases();
  const settings = useStockSettings();
  const coming = useMemo(() => {
    const packs = onOrder(purchases.open);
    const po = new Map<string, string>();
    for (const o of purchases.open) for (const l of o.lines) po.set(l.itemId, o.poNo);
    return { packs, po };
  }, [purchases]);
  /** Items that need ordering now: the badge, and a tap opens them on Order. */
  const needed = useMemo(() => new Set([...draftsOf(items).values()].flatMap((d) => Object.keys(d))), [items]);
  const toOrder = needed.size;
  const openItem = (id: string) => { setUpdating(id); setSheetTab(needed.has(id) ? 'order' : 'count'); setArchived(null); setError(''); };
  const supplierNames = useMemo(() => new Map(suppliers.map((supplier) => [supplier.id, supplier.name])), [suppliers]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => [item.name, item.category, ...item.supplierIds.map((id) => supplierNames.get(id) ?? '')]
      .some((text) => text.toLowerCase().includes(q)));
  }, [items, query, supplierNames]);
  const updatingItem = items.find((item) => item.id === updating) ?? null;
  // Today's count: what the money says to count, and since when.
  const tiers = useMemo(() => tiersOf(items), [items]);
  const due = useMemo(() => countsDue(items, tiers, Date.now()), [items, tiers]);
  const dueIds = useMemo(() => new Set(due.filter((d) => d.state !== 'never').map((d) => d.id)), [due]);
  const [counting, setCounting] = useState<DueCount[] | null>(null);
  const now = Date.now();
  const countedSoFar = items.filter((i) => i.counted).length;

  const removeItem = (id: string, name: string) => {
    try {
      archiveInventoryItem(id);
      setArchived({ id, name });
      setDone(null);
      setError('');
    } catch (cause) {
      if (!(cause instanceof Error)) throw cause;
      setError(cause.message);
    }
  };

  const undoArchive = () => {
    if (!archived) return;
    try {
      restoreInventoryItem(archived.id);
      setArchived(null);
      setError('');
    } catch (cause) {
      if (!(cause instanceof Error)) throw cause;
      setError(cause.message);
    }
  };

  return (
    <div className="inv-page">
      <OwnerNav current="inventory" onRegister={onRegister} />
      <div className="inv-page__head">
         <h1 className="supplier-heading">Inventory Dashboard</h1>
         <div className="inv-page__actions">
           <button type="button" className="inv-page__primary" onClick={() => { setDelivery(true); setArchived(null); setError(''); }}>GRN</button>
           <button type="button" className="inv-page__secondary" onClick={() => { setOrdering(true); setArchived(null); setError(''); }}>
             Purchase orders{toOrder > 0 && <span className="po-badge" aria-label={`${toOrder} to order`}>{toOrder}</span>}
           </button>
           <button type="button" className="inv-page__secondary" onClick={() => setShowAdd(true)}>+ Add Ingredient</button>
         </div>
      </div>

      {(archived || error) && (
        <div className={`inv-notice${error ? ' inv-notice--error' : ''}`} role={error ? 'alert' : 'status'}>
          {error || `${archived?.name} removed from inventory.`}
          {archived && !error && <button type="button" onClick={undoArchive}>Undo</button>}
        </div>
      )}
      {done && !archived && !error && (
        <div className="inv-notice" role="status">
          {done.message}
          {done.undo && <button type="button" onClick={() => { done.undo?.(); setDone(null); }}>Undo</button>}
        </div>
      )}

      {due.length > 0 && (
        <div className="count-due" role="region" aria-label="Today's count">
          <div>
            <strong className="count-due__title">Today's count · {due.length} {due.length === 1 ? 'item' : 'items'}</strong>
            <span className="count-due__sub">
              {[
                due.some((d) => d.state === 'overdue') && `${due.filter((d) => d.state === 'overdue').length} overdue`,
                countedSoFar < items.length && `${countedSoFar} of ${items.length} counted once`,
              ].filter(Boolean).join(' · ') || 'Count what is left; the app compares.'}
            </span>
          </div>
          <button type="button" className="insight__action" onClick={() => { setCounting(due); setDone(null); }}>Start</button>
        </div>
      )}

      {untrackedSold > 0 && (
        <div className="inv-notice" role="status">
          {untrackedSold} {untrackedSold === 1 ? 'item' : 'items'} sold this week took no stock: no recipe yet.
          <a className="inv-notice__link" href="#menu">Answer on Menu</a>
        </div>
      )}

      <label className="inv-search">
        <span className="sr-only">Search inventory</span>
        <input
          className="inv-modal__input" type="search" value={query} placeholder="Search ingredient, category or supplier"
          // Never the browser's saved logins: it took this box for an email field.
          name="inventory-search" autoComplete="off" spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
        />
      </label>

      <main className="inv-rows" aria-label="Inventory">
        {shown.length === 0 && <p className="inv-empty">No ingredients match “{query.trim()}”.</p>}
        {shown.map((item) => {
           const status = stockStatus(item);

           return (
             <article key={item.id} className="inv-row"
               onClick={(e) => { if (!(e.target as HTMLElement).closest('button, a')) openItem(item.id); }}>
               <div className="inv-row__main">
                 <h2 className="inv-row__name">
                   <button type="button" className="inv-row__open" onClick={() => openItem(item.id)}>
                     {item.name}
                   </button>
                 </h2>
                 <div className="inv-row__sub">
                 <span aria-label="Suppliers">
                   {!item.supplierIds.some((id) => supplierNames.has(id)) && 'No active suppliers'}
                   {item.supplierIds.filter((id) => supplierNames.has(id)).map((id, i) => (
                     <span key={id}>
                       {i > 0 && ', '}
                       {onFindSupplier
                         ? <button type="button" className="inv-row__source" onClick={() => onFindSupplier(item.id)}>{supplierNames.get(id)}</button>
                         : supplierNames.get(id)}
                     </span>
                   ))}
                 </span>
                 <span className="inv-row__counted"> · {item.lastCountedAt === null ? 'never counted' : `counted ${daysAgo(item.lastCountedAt, now)}`}</span>
                 </div>
               </div>
               <div className="inv-row__quantity" aria-label="Available stock and pack size">
                 <span className={`inv-row__status inv-row__status--${status}`}>{STATUS_LABELS[status]}</span>
                 {/* Never a fake zero: an item never counted shows no amount. Blind count: while
                     it is due, the amount stays hidden until it is counted, and says so. */}
                 {item.counted && (dueIds.has(item.id)
                   ? <strong>Count due · hidden</strong>
                   : <>
                     <strong>{formatStock(item.onHandBaseUnits, item)}</strong>
                     <Level days={item.lastsDays} status={status} />
                   </>)}
                 {!item.counted && <span className="inv-row__lasts">{formatQuantity(item.packQty, item.baseUnit)} a pack</span>}
                 {status === 'unsure'
                   ? <span className="inv-row__lasts">{missedText(item.missedSales)}</span>
                   : item.counted && !dueIds.has(item.id) && formatLasts(item.lastsDays) && <span className="inv-row__lasts">{formatLasts(item.lastsDays)}</span>}
               </div>
               <div className="inv-row__actions">
                 {coming.packs.has(item.id) && (
                   <span className="inv-row__onorder">On order {coming.packs.get(item.id)} · {coming.po.get(item.id)}</span>
                 )}
               </div>
             </article>
           );
        })}
      </main>
      {updatingItem && (
        <StockSheet
          key={updatingItem.id}
          item={updatingItem}
          items={items}
          suppliers={suppliers}
          purchases={purchases}
          tab={sheetTab}
          countDue={dueIds.has(updatingItem.id)}
          countAs={due.find((d) => d.id === updatingItem.id)
            ?? { id: updatingItem.id, tier: tiers.get(updatingItem.id) ?? 'monthly', state: updatingItem.counted ? 'due' : 'never', lastCountedAt: updatingItem.lastCountedAt }}
          onRemove={() => { setUpdating(null); removeItem(updatingItem.id, updatingItem.name); }}
          onClose={() => setUpdating(null)}
        />
      )}
      {delivery && (
        <GoodsReceivingSheet items={items} suppliers={suppliers} purchases={purchases} settings={settings} onClose={() => setDelivery(false)} onDone={(message) => setDone({ message })} />
      )}
      {ordering && (
        <OrderSheet items={items} suppliers={suppliers} purchases={purchases} onClose={() => setOrdering(false)} onDone={(message, undo) => setDone({ message, undo })} />
      )}
      {counting && <CountFlow due={counting} rows={items} onClose={() => setCounting(null)} />}
      {showAdd && (
        <AddIngredientModal onClose={() => setShowAdd(false)} onSave={addInventoryItem} />
      )}
    </div>
  );
}

/** How long what is left lasts, against a week: a full bar is a week or more. */
const WEEK = 7;
function Level({ days, status }: { days: number | null; status: StockStatus }) {
  if (days === null && status !== 'out') return null;
  const share = status === 'out' ? 0 : Math.min(1, (days ?? 0) / WEEK);
  return (
    <span className={`inv-level inv-level--${status}`} aria-hidden="true">
      <span style={{ width: `${Math.max(share * 100, status === 'out' ? 0 : 6)}%` }} />
    </span>
  );
}
