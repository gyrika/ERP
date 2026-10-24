import { useMemo, useRef, useState } from 'react';
import {
  addInventoryItem,
  addToDraft,
  archiveInventoryItem,
  restoreInventoryItem,
  useInventory,
  usePurchases,
  type StockStatus,
} from '../services/inventoryStore.ts';
import { stockStatus } from '../domain/inventory.ts';
import { cartOf, cartsOf, draftsOf } from '../domain/ordering.ts';
import { AddIngredientModal } from './AddIngredientModal.tsx';
import { OwnerNav } from './OwnerNav.tsx';
import { formatLasts, formatQuantity } from './quantity.ts';
import { daysAgo, formatStock } from '../domain/itemStory.ts';
import { StockSheet, type SheetTab } from './StockSheet.tsx';
import { ItemsTabs } from './ItemsTabs.tsx';
import { RejectionNotices } from './Rejections.tsx';
import { onOrder } from '../domain/purchaseOrders.ts';
import { countsDue, receiveUnitOf, tiersOf, unitName } from '../domain/counting.ts';

const STATUS_LABELS: Record<StockStatus, string> = {
  out: 'Out of stock',
  low: 'Low stock',
  unsure: 'Check shelf',
  ok: 'In stock',
  unknown: 'Not counted yet',
};

/**
 * Items › Raw materials: what the shop buys, with what is on the shelf (SCRUM-92: fewer buttons).
 * Tap a row to open its sheet (details and counting it, ordering it, its history). Receiving,
 * ordering and counting are the menu's own places now (Receive, Order, Count), so this page
 * is the list itself. The supplier's name opens that supplier; Suppliers lists them all.
 */

/** Why a row says "Check shelf": what it has not been able to take off. */
const missedText = (n: number) => `${n} sold since the last count not taken off`;


export function InventoryView({
  onFindSupplier,
  onRegister,
  lowFirst = false,
}: {
  onFindSupplier?: (id: string) => void;
  onRegister?: () => void;
  /** Opened to order (#items/low, from Orders' Place an order): out first, then low, then the rest. */
  lowFirst?: boolean;
} = {}) {
  const [showAdd, setShowAdd] = useState(false);
  const [archived, setArchived] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  /** The item whose sheet is open, and on which tab. */
  const [updating, setUpdating] = useState<string | null>(null);
  const [sheetTab, setSheetTab] = useState<SheetTab>('details');
  /** What the list shows: everything, or only what needs a look. */
  const [filter, setFilter] = useState<'all' | 'low' | 'out' | 'order'>('all');
  const searchRef = useRef<HTMLInputElement>(null);
  /** The last stock change, with its Undo (instant action, visible Undo: no confirmations). */
  const [done, setDone] = useState<{ message: string; undo?: () => void; href?: string } | null>(null);
  const { items, suppliers, untrackedSold } = useInventory();
  const purchases = usePurchases();
  const coming = useMemo(() => {
    const packs = onOrder(purchases.open);
    const po = new Map<string, string>();
    for (const o of purchases.open) for (const l of o.lines) po.set(l.itemId, o.poNo);
    return { packs, po };
  }, [purchases]);
  /** Items that need ordering now: the badge, and a tap opens them on Order. */
  const needed = useMemo(() => new Set([...draftsOf(items).values()].flatMap((d) => Object.keys(d))), [items]);
  /** Each supplier's cart: what runs low is in it by itself; + Cart puts in what is not. */
  const carts = useMemo(() => cartsOf(draftsOf(items), purchases.drafts), [items, purchases]);
  const toCart = (item: (typeof items)[number]) => {
    const last = purchases.lastSupplier.get(item.id);
    const to = item.suggestedSupplierId ?? (last && item.supplierIds.includes(last) && supplierNames.has(last) ? last : item.supplierIds.find((id) => supplierNames.has(id)));
    if (!to) return;
    const { draft, undo } = addToDraft(to, item.id, Math.max(1, item.suggestedPacks), carts.get(to) ?? {});
    const count = Object.keys(draft).length;
    setDone({ message: `${item.name}: added to ${supplierNames.get(to)}'s cart · ${count} ${count === 1 ? 'item' : 'items'}.`, undo, href: `#order/${to}` });
  };
  const openItem = (id: string) => { setUpdating(id); setSheetTab(needed.has(id) ? 'order' : 'details'); setArchived(null); setError(''); };
  const supplierNames = useMemo(() => new Map(suppliers.map((supplier) => [supplier.id, supplier.name])), [suppliers]);
  const FILTERS = [['all', 'All'], ['low', 'Low'], ['out', 'Out'], ['order', 'On order']] as const;
  const matches = (item: (typeof items)[number], which: typeof filter) =>
    which === 'all' || (which === 'order' ? coming.packs.has(item.id) : stockStatus(item) === which);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byText = !q ? items : items.filter((item) => [item.name, item.category, ...item.supplierIds.map((id) => supplierNames.get(id) ?? '')]
      .some((text) => text.toLowerCase().includes(q)));
    const found = byText.filter((item) => matches(item, filter));
    if (!lowFirst) return found;
    const rank = (item: (typeof items)[number]) => ({ out: 0, low: 1 } as Record<string, number>)[stockStatus(item)] ?? 2;
    return [...found].sort((a, b) => rank(a) - rank(b)); // stable: the usual order within each
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, query, supplierNames, filter, coming, lowFirst]);
  const updatingItem = items.find((item) => item.id === updating) ?? null;
  // Today's count: what the money says to count, and since when.
  const tiers = useMemo(() => tiersOf(items), [items]);
  const due = useMemo(() => countsDue(items, tiers, Date.now()), [items, tiers]);
  const dueIds = useMemo(() => new Set(due.filter((d) => d.state !== 'never').map((d) => d.id)), [due]);
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
      <OwnerNav current="items" onRegister={onRegister} />
      <div className="inv-page__head">
         <h1 className="supplier-heading">Items</h1>
         <div className="inv-page__actions">
           <button type="button" className="inv-page__secondary" onClick={() => setShowAdd(true)}>+ Add Ingredient</button>
           <a className="inv-page__secondary" href="#suppliers">Suppliers</a>
         </div>
      </div>

      <ItemsTabs current="raw" />

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
          {done.href && <a className="inv-notice__link" href={done.href}>Open cart</a>}
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
           const cart = cartOf(carts, item.id);
           const canCart = !cart && !coming.packs.has(item.id) && (status === 'low' || status === 'out') && item.supplierIds.some((id) => supplierNames.has(id));

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
                   : <strong>{formatStock(item.onHandBaseUnits, item)}</strong>)}
                 {!item.counted && <span className="inv-row__lasts">{receiveUnitOf(item).id === 'pack' ? `${formatQuantity(item.packQty, item.baseUnit)} a pack` : `Bought by ${unitName(receiveUnitOf(item))}`}</span>}
                 {status === 'unsure'
                   ? <span className="inv-row__lasts">{missedText(item.missedSales)}</span>
                   : item.counted && !dueIds.has(item.id) && formatLasts(item.lastsDays) && <span className="inv-row__lasts">{formatLasts(item.lastsDays)}</span>}
               </div>
               <div className="inv-row__actions">
                 {coming.packs.has(item.id) && (
                   <span className="inv-row__onorder">On order {coming.packs.get(item.id)} · {coming.po.get(item.id)}</span>
                 )}
                 {cart && <a className="inv-row__cart" href={`#order/${cart}`}>In cart · {supplierNames.get(cart)}</a>}
                 {canCart && <button type="button" className="inv-row__cart inv-row__cart--add" aria-label={`Add ${item.name} to its cart`} onClick={() => toCart(item)}>+ Cart</button>}
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
      {showAdd && (
        <AddIngredientModal onClose={() => setShowAdd(false)} onSave={addInventoryItem} />
      )}
    </div>
  );
}
