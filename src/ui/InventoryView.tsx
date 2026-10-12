import { useCallback, useEffect, useMemo, useState } from 'react';
import { fmt, formatLKR } from '../domain/money.ts';
import type { Cents } from '../domain/types.ts';
import {
  isLowStock, readItems, useInventory, writeItems, type InventoryRow,
} from '../services/inventoryStore.ts';
import { supplierById } from '../domain/inventory.ts';

type CategoryFilter = 'all' | 'flour' | 'cheese' | 'veg' | 'packaging';

const FILTERS: { id: CategoryFilter; label: string; match: (category: string) => boolean }[] = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'flour', label: 'Flour', match: (c) => c === 'Flour' },
  { id: 'cheese', label: 'Cheese', match: (c) => c === 'Cheese' },
  { id: 'veg', label: 'Veg', match: (c) => c === 'Vegetable' },
  { id: 'packaging', label: 'Packaging', match: (c) => c === 'Packaging' },
];

const parsePriceLKR = (raw: string): Cents | null => {
  const m = raw.trim().match(/^((?:\d+|\d{1,3}(?:,\d{3})+))(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const rupees = Number(m[1].replace(/,/g, ''));
  const frac = (m[2] ?? '').padEnd(2, '0').slice(0, 2);
  const cents = rupees * 100 + Number(frac);
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
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={`Price · ${item.name}`}>
        <div className="sheet__body">
          <div className="sheet__title">
            <h1>{item.name}</h1>
            <p className="sheet__sub">Working price per pack (LKR)</p>
            <button type="button" className="inv-drawer-close" onClick={onClose}>Close</button>
          </div>
          <label className="inv-field">
            <span className="inv-field__label">Price</span>
            <input
              className="inv-field__input num"
              inputMode="decimal"
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'price-error' : undefined}
              autoFocus
              value={value}
              onChange={(e) => { setValue(e.target.value); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
            />
            {error && <span id="price-error" className="inv-price-error" role="alert">{error}</span>}
          </label>
        </div>
        <div className="sheet__foot">
          <button type="button" className="cta" onClick={save}>Save price</button>
        </div>
      </div>
    </>
  );
}

export function InventoryView() {
  const { items, suppliers } = useInventory();
  const [filter, setFilter] = useState<CategoryFilter>('all');
  const [query, setQuery] = useState('');
  const [priceItem, setPriceItem] = useState<InventoryRow | null>(null);

  const supplierName = useCallback(
    (id: string) => suppliers.find((s) => s.id === id)?.name ?? supplierById(id)?.name ?? id,
    [suppliers],
  );

  const visible = useMemo(() => {
    const match = FILTERS.find((f) => f.id === filter)?.match ?? (() => true);
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (!match(item.category)) return false;
      if (!q) return true;
      return item.name.toLowerCase().includes(q) || item.category.toLowerCase().includes(q);
    });
  }, [items, filter, query]);

  const patchItem = (id: string, patch: Partial<InventoryRow>) => {
    const next = readItems().map((row) => (row.id === id ? { ...row, ...patch } : row));
    writeItems(next);
  };

  const bumpStock = (id: string, delta: number) => {
    const row = readItems().find((i) => i.id === id);
    if (!row) return;
    patchItem(id, { onHandPacks: Math.max(0, row.onHandPacks + delta) });
  };

  return (
    <div className="inv-page">
      <header className="inv-page__head">
        <span className="brand">CheesyBeez</span>
        <nav className="inv-page__nav" aria-label="Inventory sections">
          <a className="inv-page__link inv-page__link--on" href="#inventory">Inventory</a>
          <a className="inv-page__link" href="#suppliers">Suppliers</a>
          <a className="inv-page__link" href="#">Register</a>
        </nav>
      </header>

      <main className="inv-page__main" aria-label="Inventory">
        <nav className="cats" aria-label="Categories">
          {(['flour', 'cheese', 'veg', 'packaging'] as const).map((id) => {
            const f = FILTERS.find((x) => x.id === id)!;
            return (
              <button
                key={f.id}
                type="button"
                className="pill"
                aria-pressed={filter === f.id}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            );
          })}
          <button
            type="button"
            className="pill"
            aria-pressed={filter === 'all'}
            onClick={() => setFilter('all')}
          >
            All
          </button>
        </nav>

        <label className="inv-search">
          <span className="inv-search__label">Search</span>
          <input
            className="inv-search__input"
            type="search"
            placeholder="Item or category"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>

        <ul className="inv-list">
          {visible.length === 0 && (
            <li className="inv-empty">No items match</li>
          )}
          {visible.map((item) => (
            <li key={item.id} className="inv-row">
              <div className="inv-row__main">
                <div className="inv-row__title">
                  <span className="inv-row__name">{item.name}</span>
                  {isLowStock(item) && (
                    <span className="status status--low">Low stock</span>
                  )}
                </div>
                <span className="inv-row__meta">
                  {item.category} · {supplierName(item.mainSupplierId)}
                  {item.note ? ` · ${item.note}` : ''}
                </span>
              </div>
              <div className="inv-row__stock">
                <span className="inv-row__stock-label">Packs</span>
                <div className="inv-stepper">
                  <button
                    type="button"
                    className="inv-stepper__btn"
                    aria-label={`Remove one pack of ${item.name}`}
                    onClick={() => bumpStock(item.id, -1)}
                  >
                    −
                  </button>
                  <span className="inv-stepper__val num">{item.onHandPacks}</span>
                  <button
                    type="button"
                    className="inv-stepper__btn"
                    aria-label={`Add one pack of ${item.name}`}
                    onClick={() => bumpStock(item.id, 1)}
                  >
                    +
                  </button>
                </div>
              </div>
              <button
                type="button"
                className="inv-row__price num"
                aria-label={`Edit price for ${item.name}, ${formatLKR(item.workingPriceCents)}`}
                onClick={() => setPriceItem(item)}
              >
                {formatLKR(item.workingPriceCents)}
              </button>
            </li>
          ))}
        </ul>
      </main>

      {priceItem && (
        <PriceDrawer
          item={priceItem}
          onClose={() => setPriceItem(null)}
          onSave={(cents) => patchItem(priceItem.id, { workingPriceCents: cents })}
        />
      )}
    </div>
  );
}
