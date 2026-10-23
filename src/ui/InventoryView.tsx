import { useMemo, useRef, useState } from 'react';
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
import { RejectionNotices } from './Rejections.tsx';
import { StockRulesSheet } from './StockRulesSheet.tsx';
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
  const [sheetTab, setSheetTab] = useState<SheetTab>('details');
  const [delivery, setDelivery] = useState(false);
  const [ordering, setOrdering] = useState(false);
  const [rules, setRules] = useState(false);
  /** What the list shows: everything, or only what needs a look. */
  const [filter, setFilter] = useState<'all' | 'low' | 'out' | 'order'>('all');
  const searchRef = useRef<HTMLInputElement>(null);
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
  const openItem = (id: string) => { setUpdating(id); setSheetTab(needed.has(id) ? 'order' : 'details'); setArchived(null); setError(''); };
  const supplierNames = useMemo(() => new Map(suppliers.map((supplier) => [supplier.id, supplier.name])), [suppliers]);
  const FILTERS = [['all', 'All'], ['low', 'Low'], ['out', 'Out'], ['order', 'On order']] as const;
  const matches = (item: (typeof items)[number], which: typeof filter) =>
    which === 'all' || (which === 'order' ? coming.packs.has(item.id) : stockStatus(item) === which);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byText = !q ? items : items.filter((item) => [item.name, item.category, ...item.supplierIds.map((id) => supplierNames.get(id) ?? '')]
      .some((text) => text.toLowerCase().includes(q)));
    return byText.filter((item) => matches(item, filter));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, query, supplierNames, filter, coming]);
  const updatingItem = items.find((item) => item.id === updating) ?? null;
  // Today's count: what the money says to count, and since when.
  const tiers = useMemo(() => tiersOf(items), [items]);
  const due = useMemo(() => countsDue(items, tiers, Date.now()), [items, tiers]);
  const dueIds = useMemo(() => new Set(due.filter((d) => d.state !== 'never').map((d) => d.id)), [due]);
  const [counting, setCounting] = useState<DueCount[] | null>(null);
  const now = Date.now();

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
         <h1 className="supplier-heading">Inventory</h1>
         <div className="inv-page__actions">
           <button type="button" className="inv-page__secondary" onClick={() => setShowAdd(true)}>+ Add Ingredient</button>
           <button type="button" className="inv-page__secondary" onClick={() => setRules(true)}>Stock rules</button>
         </div>
      </div>

      <nav className="stock-home" aria-label="Stock">
        <Tile label="Inventory" sub={`${items.length} items`} current onClick={() => searchRef.current?.focus()} />
        <Tile label="Purchase orders" name={`Purchase orders${toOrder > 0 ? ` (${toOrder})` : ''}`} badge={toOrder} tone="warn"
          sub={toOrder > 0 ? `${toOrder} to order` : 'Nothing to order'} onClick={() => { setOrdering(true); setArchived(null); setError(''); }} />
        <Tile label="GRN" badge={purchases.open.length} tone="info" sub={purchases.open.length > 0 ? `${purchases.open.length} waiting` : 'None waiting'}
          onClick={() => { setDelivery(true); setArchived(null); setError(''); }} />
        <Tile label="Count" name={`Count${due.length > 0 ? ` (${due.length} due)` : ''}`} badge={due.length} tone="warn" disabled={due.length === 0}
          sub={due.length > 0 ? `${due.length} due today` : 'All counted'} onClick={() => { setCounting(due); setDone(null); }} />
      </nav>

      <RejectionNotices />
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
          ref={searchRef}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
        />
      </label>
      <div className="chips chips--tight inv-filters" role="group" aria-label="Show">
        {FILTERS.map(([id, label]) => (
          <button key={id} type="button" className="chip" aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>
        ))}
      </div>

      <main className="inv-rows" aria-label="Inventory">
        {shown.length === 0 && <p className="inv-empty">{query.trim() ? `No ingredients match “${query.trim()}”.` : 'Nothing here. Everything is fine, or choose All.'}</p>}
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
      {rules && (
        <StockRulesSheet settings={settings} onClose={() => setRules(false)} onDone={(message, undo) => setDone({ message, undo })} />
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

/** One of the four big buttons at the top of the stock area. */
function Tile({ label, name, sub, badge = 0, tone, current = false, disabled = false, onClick }: {
  label: string; name?: string; sub: string; badge?: number; tone?: 'warn' | 'info'; current?: boolean; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button type="button" className={`stock-tile${current ? ' stock-tile--current' : ''}`} aria-label={name ?? label}
      aria-current={current ? 'page' : undefined} disabled={disabled} onClick={onClick}>
      <span className="stock-tile__label" aria-hidden>{label}</span>
      <span className="stock-tile__sub" aria-hidden>{sub}</span>
      {badge > 0 && <span className={`stock-tile__badge stock-tile__badge--${tone ?? 'warn'}`} aria-hidden>{badge}</span>}
    </button>
  );
}
