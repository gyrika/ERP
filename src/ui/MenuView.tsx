import { useEffect, useState, type FormEvent } from 'react';
import { MENU, menuItems, menuState } from '../domain/menu.ts';
import { checkOverride, nextMorning, type ItemOverride } from '../domain/menuEdits.ts';
import { fmt } from '../domain/money.ts';
import type { Category, Cents, MenuItem, SizeId } from '../domain/types.ts';
import { currentCashier } from '../services/auth.ts';
import { appendEvent } from './eventLog.ts';
import { useMenu } from './menuStore.ts';

const SECTIONS: { id: Category; label: string }[] = [
  { id: 'pizza', label: 'Pizza' },
  { id: 'burger', label: 'Burgers' },
  { id: 'pasta', label: 'Pasta' },
];
const printed = (id: string) => {
  const item = MENU.find((entry) => entry.id === id);
  if (!item) throw new Error(`Unknown printed menu item: ${id}`);
  return item;
};
const prices = (item: MenuItem) =>
  item.variants ? item.variants.map((variant) => `${variant.id} ${fmt(variant.price)}`).join(' · ') : fmt(item.price ?? 0);
const toCents = (text: string): Cents | null => {
  const value = text.replace(/[,\s]/g, '');
  return /^\d{1,6}$/.test(value) ? Number(value) * 100 : null;
};

const record = (itemId: string, after: ItemOverride): ItemOverride => {
  const before = menuState().overrides[itemId] ?? {};
  appendEvent({
    type: 'menu.item_set',
    at: Date.now(),
    orderNumber: 0,
    actor: currentCashier(),
    itemId,
    before,
    after,
  });
  return before;
};

const recordSoldOut = (itemId: string, until: number | null) =>
  appendEvent({
    type: 'menu.sold_out',
    at: Date.now(),
    orderNumber: 0,
    actor: currentCashier(),
    itemId,
    until,
  });

function Editor({
  item,
  onClose,
  onSaved,
}: {
  item: MenuItem;
  onClose: () => void;
  onSaved: (message: string, undo: () => void) => void;
}) {
  const base = printed(item.id);
  const [en, setEn] = useState(item.name.en);
  const [si, setSi] = useState(item.name.si ?? '');
  const [ta, setTa] = useState(item.name.ta ?? '');
  const [description, setDescription] = useState(item.description);
  const sizes = item.variants?.map((variant) => variant.id) ?? ['one' as const];
  const [price, setPrice] = useState<Record<string, string>>(() => Object.fromEntries(
    item.variants
      ? item.variants.map((variant) => [variant.id, String(variant.price / 100)])
      : [['one', String((item.price ?? 0) / 100)]],
  ));
  const [adds, setAdds] = useState<Record<string, string>>(() =>
    Object.fromEntries(item.adds.map((add) => [add.id, String(add.price / 100)])));
  const [hidden, setHidden] = useState(Boolean(item.hidden));
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const basePrice = (id: string) =>
    id === 'one' ? base.price ?? 0 : base.variants?.find((variant) => variant.id === id)?.price ?? 0;

  const buildOverride = (): ItemOverride | string => {
    const override: ItemOverride = {};
    const name: NonNullable<ItemOverride['name']> = {};
    if (en.trim() !== base.name.en) name.en = en.trim();
    if (si.trim() !== (base.name.si ?? '')) name.si = si.trim();
    if (ta.trim() !== (base.name.ta ?? '')) name.ta = ta.trim();
    if (Object.keys(name).length) override.name = name;
    if (description.trim() !== base.description) override.description = description.trim();

    const pricesBySize: NonNullable<ItemOverride['prices']> = {};
    for (const id of sizes) {
      const cents = toCents(price[id] ?? '');
      if (cents === null) return 'Prices are whole rupees, like 1650.';
      if (cents !== basePrice(id)) pricesBySize[id as SizeId | 'one'] = cents;
    }
    if (Object.keys(pricesBySize).length) override.prices = pricesBySize;

    const addPrices: Record<string, Cents> = {};
    for (const add of base.adds) {
      const cents = toCents(adds[add.id] ?? '');
      if (cents === null) return 'Prices are whole rupees, like 300.';
      if (cents !== add.price) addPrices[add.id] = cents;
    }
    if (Object.keys(addPrices).length) override.adds = addPrices;
    if (hidden) override.hidden = true;
    return checkOverride(base, override) ?? override;
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    const override = buildOverride();
    if (typeof override === 'string') {
      setError(override);
      return;
    }
    const before = record(item.id, override);
    onSaved(`Saved ${en.trim() || base.name.en}`, () => record(item.id, before));
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <form className="sheet menued" role="dialog" aria-modal="true" aria-label={`Change ${item.name.en}`} onSubmit={save}>
        <div className="sheet__body">
          <div className="sheet__title">
            <h1>{item.name.en}</h1>
            {item.edited && (
              <button type="button" className="linkbtn" onClick={() => {
                const before = record(item.id, {});
                onSaved(`${base.name.en}: back to the printed menu`, () => record(item.id, before));
              }}>
                Back to the printed menu
              </button>
            )}
          </div>
          <section className="group">
            <h2>Name</h2>
            <div className="menued__grid">
              <label>English<input value={en} onChange={(event) => setEn(event.target.value)} maxLength={40} required /></label>
              <label>Sinhala<input value={si} onChange={(event) => setSi(event.target.value)} maxLength={60} lang="si" /></label>
              <label>Tamil<input value={ta} onChange={(event) => setTa(event.target.value)} maxLength={60} lang="ta" /></label>
              <label className="menued__wide">Description<input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={160} /></label>
            </div>
          </section>
          <section className="group">
            <h2>Price</h2>
            <div className="menued__grid">
              {sizes.map((id) => {
                const variant = item.variants?.find((entry) => entry.id === id);
                const originalPrice = basePrice(id);
                return (
                  <label key={id}>
                    {variant ? `${variant.label}${variant.hint ? ` ${variant.hint}` : ''}` : 'Price'}
                    <input
                      className="num"
                      inputMode="numeric"
                      value={price[id]}
                      onChange={(event) => setPrice({ ...price, [id]: event.target.value })}
                      aria-label={variant ? `${variant.label} price` : 'Price'}
                    />
                    {toCents(price[id]) !== originalPrice && <span className="menued__was num">Printed {fmt(originalPrice)}</span>}
                  </label>
                );
              })}
            </div>
          </section>
          {base.adds.length > 0 && (
            <section className="group">
              <h2>Extras</h2>
              <div className="menued__grid">
                {base.adds.map((add) => (
                  <label key={add.id}>
                    {add.label}
                    <input
                      className="num"
                      inputMode="numeric"
                      value={adds[add.id]}
                      onChange={(event) => setAdds({ ...adds, [add.id]: event.target.value })}
                      aria-label={`${add.label} price`}
                    />
                  </label>
                ))}
              </div>
            </section>
          )}
          <section className="group">
            <label className="menued__check">
              <input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.target.checked)} />
              Hide from the menu <span>(the counter and cheesybeez.com stop offering it; old orders keep it)</span>
            </label>
          </section>
          {error && <p className="reason-msg" role="alert">{error}</p>}
        </div>
        <div className="sheet__foot menued__foot">
          <button type="button" className="linkbtn" onClick={onClose}>Cancel</button>
          <button type="submit" className="cta">Save</button>
        </div>
      </form>
    </>
  );
}

export function MenuView({ owner, onBack }: { owner: boolean; onBack: () => void }) {
  useMenu();
  const [section, setSection] = useState<Category>('pizza');
  const [editing, setEditing] = useState<MenuItem | null>(null);
  const [toast, setToast] = useState<{ id: number; message: string; undo: () => void } | null>(null);
  const items = menuItems().filter((item) => item.category === section);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !editing) onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, onBack]);

  const announce = (message: string, undo: () => void) =>
    setToast({ id: Date.now(), message, undo });

  return (
    <div className="owner">
      <header className="owner__head">
        <span className="brand">CheesyBeez</span>
        <nav className="owner__nav" aria-label="Menu actions">
          <button type="button" className="owner__back" onClick={onBack}>Register <kbd>Esc</kbd></button>
        </nav>
      </header>
      <main className="owner__main menuv" aria-label="Menu">
        <h1 className="menuv__title">Menu</h1>
        <p className="menuv__lead">
          {owner
            ? 'Change a price, a name or what is on offer. Changes reach the counter, kitchen and online menu.'
            : 'Mark an item sold out for today. Prices and names are changed by the owner.'}
        </p>
        <nav className="cats" aria-label="Menu sections">
          {SECTIONS.map((entry) => (
            <button key={entry.id} type="button" className="pill" aria-pressed={section === entry.id} onClick={() => setSection(entry.id)}>
              {entry.label}
            </button>
          ))}
        </nav>
        <ul className="menuv__list">
          {items.map((item) => (
            <li key={item.id} className={`menuv__row${item.hidden ? ' menuv__row--hidden' : ''}`}>
              <div className="menuv__name">
                <b>{item.name.en}</b>
                {(item.name.si || item.name.ta) && <span>{[item.name.si, item.name.ta].filter(Boolean).join(' · ')}</span>}
                <span className="num">{prices(item)}</span>
              </div>
              <div className="menuv__tags">
                {item.edited && <span className="status status--paid">Changed</span>}
                {item.hidden && <span className="status status--unpaid">Hidden</span>}
              </div>
              {!item.hidden && (
                <button
                  type="button"
                  className="chip menuv__sold"
                  aria-pressed={Boolean(item.soldOut)}
                  onClick={() => {
                    const previous = menuState().soldOut[item.id] ?? null;
                    const next = item.soldOut ? null : nextMorning(Date.now());
                    recordSoldOut(item.id, next);
                    announce(item.soldOut ? `${item.name.en} is back` : `${item.name.en}: sold out until morning`, () => recordSoldOut(item.id, previous));
                  }}
                >
                  {item.soldOut ? 'Sold out today' : 'Available'}
                </button>
              )}
              {owner && (
                <button type="button" className="chip chip--solid" onClick={() => setEditing(item)} aria-label={`Change ${item.name.en}`}>
                  Change
                </button>
              )}
            </li>
          ))}
        </ul>
      </main>
      {editing && (
        <Editor
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={(message, undo) => { setEditing(null); announce(message, undo); }}
        />
      )}
      {toast && !editing && (
        <div className="toast" role="status" key={toast.id}>
          <span>{toast.message}</span>
          <button type="button" onClick={() => { toast.undo(); setToast(null); }}>Undo</button>
        </div>
      )}
    </div>
  );
}
