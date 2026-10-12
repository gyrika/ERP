import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UIEvent } from 'react';
import { fmt, formatLKR } from '../domain/money.ts';
import type { Cents } from '../domain/types.ts';
import { supplierById } from '../domain/inventory.ts';
import {
  adjustStock,
  isLowStock,
  setWorkingPrice,
  useInventory,
  type InventoryRow,
} from '../services/inventoryStore.ts';

type CategoryFilter = 'all' | 'flour' | 'cheese' | 'veg' | 'packaging';

const FILTERS: { id: CategoryFilter; label: string; match: (category: string) => boolean }[] = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'flour', label: 'Flour', match: (category) => category === 'Flour' },
  { id: 'cheese', label: 'Cheese', match: (category) => category === 'Cheese' },
  { id: 'veg', label: 'Veg', match: (category) => category === 'Vegetable' },
  { id: 'packaging', label: 'Packaging', match: (category) => category === 'Packaging' },
];

const parsePriceLKR = (raw: string): Cents | null => {
  const match = raw.trim().match(/^((?:\d+|\d{1,3}(?:,\d{3})+))(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const rupees = Number(match[1].replace(/,/g, ''));
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const cents = rupees * 100 + Number(fraction);
  return Number.isSafeInteger(cents) ? cents : null;
};

function PriceDrawer({
  item,
  onClose,
  onSave,
}: {
  item: InventoryRow;
  onClose: () => void;
  onSave: (cents: Cents) => void;
}) {
  const [value, setValue] = useState(fmt(item.workingPriceCents));
  const [error, setError] = useState('');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const save = () => {
    const cents = parsePriceLKR(value);
    if (cents === null) {
      setError('Enter a valid LKR price, such as 1,250.00.');
      return;
    }
    onSave(cents);
    onClose();
  };

  const adjustPrice = (factor: number) => {
    const cents = parsePriceLKR(value);
    if (cents === null) {
      setError('Enter a valid LKR price before using a price adjustment.');
      return;
    }
    setValue(fmt(Math.round(cents * factor) as Cents));
    setError('');
  };

  const roundToHundred = () => {
    const cents = parsePriceLKR(value);
    if (cents === null) {
      setError('Enter a valid LKR price before rounding.');
      return;
    }
    setValue(fmt(Math.round(cents / 10000) * 10000 as Cents));
    setError('');
  };

  return (
    <div className="inv-drawer-layer">
      <button className="inv-drawer-scrim" type="button" aria-label="Close price editor" onClick={onClose} />
      <aside className="inv-drawer" role="dialog" aria-modal="true" aria-label={`Price · ${item.name}`}>
        <div className="inv-drawer__content">
          <header className="inv-drawer__header">
            <div>
              <p className="inv-drawer__sub">{item.category} · {item.packQty} {item.baseUnit} per pack</p>
              <h2 className="inv-drawer__title">{item.name}</h2>
              <p className="inv-drawer__sub">Working price per pack · LKR</p>
            </div>
            <button className="inv-drawer__close" type="button" aria-label="Close price editor" onClick={onClose}>
              ×
            </button>
          </header>

          <label className="inv-price-field">
            <span className="inv-price-field__label">Price</span>
            <span className="inv-input-box">
              <span aria-hidden="true">LKR</span>
              <input
                autoFocus
                className="inv-price-input"
                inputMode="decimal"
                aria-label="Price"
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'inv-price-error' : undefined}
                value={value}
                onChange={(event) => { setValue(event.target.value); setError(''); }}
                onKeyDown={(event) => { if (event.key === 'Enter') save(); }}
              />
            </span>
            {error && <span id="inv-price-error" className="inv-price-error" role="alert">{error}</span>}
          </label>

          <div className="inv-drawer__presets" aria-label="Price adjustments">
            <button className="inv-btn-preset" type="button" onClick={() => adjustPrice(1.05)}>+5%</button>
            <button className="inv-btn-preset" type="button" onClick={() => adjustPrice(1.1)}>+10%</button>
            <button className="inv-btn-preset" type="button" onClick={roundToHundred}>Round to Rs 100</button>
          </div>
        </div>

        <footer className="inv-drawer__footer">
          <button className="inv-btn-save" type="button" onClick={save}>Save price</button>
          <button className="inv-btn-cancel" type="button" onClick={onClose}>Cancel (Esc)</button>
        </footer>
      </aside>
    </div>
  );
}

export function InventoryView() {
  const { items } = useInventory();
  const [filter, setFilter] = useState<CategoryFilter>('all');
  const [query, setQuery] = useState('');
  const [priceItemId, setPriceItemId] = useState<string | null>(null);
  const [headerHidden, setHeaderHidden] = useState(false);
  const lastScrollTop = useRef(0);
  const commandBarRef = useRef<HTMLDivElement>(null);

  const priceItem = items.find((item) => item.id === priceItemId) ?? null;
  const supplierName = useCallback(
    (id: string) => supplierById(id)?.name ?? id,
    [],
  );

  const visible = useMemo(() => {
    const matchesCategory = FILTERS.find((option) => option.id === filter)?.match ?? (() => true);
    const normalizedQuery = query.trim().toLowerCase();
    return items.filter((item) => {
      if (!matchesCategory(item.category)) return false;
      if (!normalizedQuery) return true;
      return item.name.toLowerCase().includes(normalizedQuery)
        || item.category.toLowerCase().includes(normalizedQuery)
        || (item.note ?? '').toLowerCase().includes(normalizedQuery)
        || supplierName(item.mainSupplierId).toLowerCase().includes(normalizedQuery);
    });
  }, [items, filter, query, supplierName]);

  const lowStockCount = useMemo(() => items.filter(isLowStock).length, [items]);

  const savePrice = useCallback((item: InventoryRow, cents: Cents) => {
    setWorkingPrice(item.id, cents);
  }, []);

  const handleInventoryScroll = (event: UIEvent<HTMLDivElement>) => {
    const scrollTop = event.currentTarget.scrollTop;
    const delta = scrollTop - lastScrollTop.current;
    lastScrollTop.current = scrollTop;

    if (scrollTop <= 0) {
      setHeaderHidden(false);
    } else if (Math.abs(delta) > 4) {
      const focusIsInHeader = commandBarRef.current?.contains(document.activeElement);
      setHeaderHidden(!focusIsInHeader && delta > 0);
    }
  };

  return (
    <div className="inv-page">
      <header className="inv-page__head">
        <span className="brand">CheesyBeez</span>
        <nav className="inv-page__nav" aria-label="Inventory sections">
          <a className="inv-page__link inv-page__link--on" href="#inventory" aria-current="page">Inventory</a>
          <a className="inv-page__link" href="#suppliers">Suppliers</a>
          <a className="inv-page__link" href="#">Register</a>
        </nav>
      </header>

      <main className="inv-shell" aria-label="Inventory">
        <div
          className="inv-scroll"
          role="region"
          aria-label="Inventory list"
          tabIndex={0}
          onScroll={handleInventoryScroll}
        >
          <div
            ref={commandBarRef}
            className={`inv-command-bar${headerHidden ? ' inv-command-bar--hidden' : ''}`}
            onFocusCapture={() => setHeaderHidden(false)}
          >
            <div className="inv-command-bar__top">
              <label className="inv-search-wrap">
                <span className="inv-search-icon" aria-hidden="true">⌕</span>
                <span className="sr-only">Search inventory</span>
                <input
                  className="inv-search-input"
                  type="search"
                  placeholder="Search item, category or supplier"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <div className="inv-metrics" aria-live="polite">
                <span className="inv-metric-badge">
                  <span className="inv-dot inv-dot--emerald" />
                  Showing <strong>{visible.length}</strong> of {items.length}
                </span>
                {lowStockCount > 0 && (
                  <span className="inv-metric-badge inv-metric-badge--alert">
                    <span className="inv-dot inv-dot--amber" />
                    {lowStockCount} low stock
                  </span>
                )}
              </div>
            </div>

            <div className="inv-categories" aria-label="Filter by category">
              {FILTERS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`inv-cat-pill${filter === option.id ? ' inv-cat-pill--active' : ''}`}
                  aria-pressed={filter === option.id}
                  onClick={() => setFilter(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="inv-workspace">
            <ul className="inv-grid" aria-label="Inventory items">
              {visible.map((item) => {
                const low = isLowStock(item);
                const selected = priceItemId === item.id;
                return (
                  <li
                    key={item.id}
                    className={`inv-card${low ? ' inv-card--low' : ''}${selected ? ' inv-card--selected' : ''}`}
                  >
                    <div>
                      <div className="inv-card__header">
                        <h2 className="inv-card__title">{item.name}</h2>
                        <span className={`inv-badge${low ? ' inv-badge--alert' : ' inv-badge--neutral'}`}>
                          {low ? 'Low stock' : 'In stock'}
                        </span>
                      </div>
                      <p className="inv-card__sub">{item.category} · {item.note ?? supplierName(item.mainSupplierId)}</p>
                      <p className="inv-card__meta">
                        Pack: {item.packQty} {item.baseUnit} · Supplier: {supplierName(item.mainSupplierId)}
                      </p>
                    </div>

                    <div className="inv-card__footer">
                      <div className="inv-stock">
                        <span className="inv-stock__label">On hand</span>
                        <div className="inv-stepper" aria-label={`Stock of ${item.name}`}>
                          <button
                            className="inv-stepper__btn"
                            type="button"
                            aria-label={`Remove one pack of ${item.name}`}
                            disabled={item.onHandPacks <= 0}
                            onClick={() => adjustStock(item.id, -1)}
                          >
                            −
                          </button>
                          <span className="inv-stepper__val">{item.onHandPacks}</span>
                          <button
                            className="inv-stepper__btn"
                            type="button"
                            aria-label={`Add one pack of ${item.name}`}
                            onClick={() => adjustStock(item.id, 1)}
                          >
                            +
                          </button>
                        </div>
                        <span className="inv-stock__unit">packs</span>
                      </div>
                      <button
                        className={`inv-price-trigger${selected ? ' inv-price-trigger--active' : ''}`}
                        type="button"
                        aria-label={`Edit price for ${item.name}, ${formatLKR(item.workingPriceCents)}`}
                        onClick={() => setPriceItemId(item.id)}
                      >
                        <span>{formatLKR(item.workingPriceCents)}</span>
                        <span aria-hidden="true">✎</span>
                      </button>
                    </div>
                  </li>
                );
              })}
              {visible.length === 0 && <li className="inv-empty">No items match</li>}
            </ul>

            {priceItem && (
              <PriceDrawer
                key={priceItem.id}
                item={priceItem}
                onClose={() => setPriceItemId(null)}
                onSave={(cents) => savePrice(priceItem, cents)}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
