import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { marginOf, menuCost, openQuestions, sizesOf, type CostContext } from '../domain/costing.ts';
import { MENU, menuItems, menuState } from '../domain/menu.ts';
import { checkOverride, nextMorning, type ItemOverride } from '../domain/menuEdits.ts';
import { fmt } from '../domain/money.ts';
import type { Category, Cents, MenuItem, SizeId } from '../domain/types.ts';
import { currentCashier } from '../services/auth.ts';
import { useCostContext } from '../services/inventoryStore.ts';
import { CostQuestions } from './CostQuestions.tsx';
import { appendEvent } from './eventLog.ts';
import { useMenu } from './menuStore.ts';
import { OwnerNav } from './OwnerNav.tsx';

/**
 * The owner's menu (#menu). Serves the owner: they know their menu and want one change made
 * now, a price, a name, something off for today, without calling anyone. The single next
 * thing: find the item, change it, save. Managers see the same list with "Sold out today" only.
 * Every change is an event (who, when, before/after) with an Undo, and reaches the counter,
 * the kitchen and cheesybeez.com at once.
 */
const SECTIONS: { id: Category; label: string }[] = [
  { id: 'pizza', label: 'Pizza' }, { id: 'burger', label: 'Burgers' }, { id: 'pasta', label: 'Pasta' },
];
const printed = (id: string) => MENU.find((m) => m.id === id)!;
const prices = (m: MenuItem) => (m.variants ? m.variants.map((v) => `${v.id} ${fmt(v.price)}`).join(' · ') : fmt(m.price ?? 0));

/**
 * "Cost M 412 · 75%  L 690 · 72%", or "Cost so far M 38 · L 66 · 5 answers to go":
 * what each size costs to make from the owner's recipes (SCRUM-77).
 */
function CostLine({ item, ctx }: { item: MenuItem; ctx: CostContext }) {
  const sizes = sizesOf(item).map((size) => ({
    size,
    price: size ? item.variants!.find((v) => v.id === size)!.price : (item.price ?? 0),
    cost: menuCost(item.id, size, ctx),
  }));
  const gaps = new Set(sizes.flatMap((s) => s.cost.missing)).size;
  const answers = `${gaps} ${gaps === 1 ? 'answer' : 'answers'}`;
  if (sizes.every((s) => !s.cost.product)) return <span className="menuv__cost">Cost: which of your recipes is it? ({answers} to go)</span>;
  return (
    <span className="menuv__cost num">
      {gaps ? 'Cost so far ' : 'Cost '}
      {sizes.map(({ size, price, cost }, i) => {
        const margin = cost.complete ? marginOf(price, cost.cents) : null;
        return (
          <span key={size}>
            {i > 0 && ' · '}{size && `${size} `}{fmt(Math.round(cost.cents / 100) * 100)}
            {margin !== null && <b>{` ${Math.round(margin * 100)}%`}</b>}
          </span>
        );
      })}
      {gaps > 0 && ` · ${answers} to go`}
    </span>
  );
}

/** "1,650" or "1650" → cents, whole rupees only. */
const toCents = (text: string): Cents | null => {
  const t = text.replace(/[,\s]/g, '');
  return /^\d{1,6}$/.test(t) ? Number(t) * 100 : null;
};

const record = (itemId: string, after: ItemOverride) => {
  const before = menuState().overrides[itemId] ?? {};
  appendEvent({ type: 'menu.item_set', at: Date.now(), orderNumber: 0, actor: currentCashier(), itemId, before, after });
  return before;
};
const setSoldOut = (itemId: string, out: boolean) =>
  appendEvent({ type: 'menu.sold_out', at: Date.now(), orderNumber: 0, actor: currentCashier(), itemId, until: out ? nextMorning(Date.now()) : null });

function Editor({ item, onSaved, onClose }: { item: MenuItem; onSaved: (message: string, undo: () => void) => void; onClose: () => void }) {
  const base = printed(item.id);
  const [en, setEn] = useState(item.name.en);
  const [si, setSi] = useState(item.name.si ?? '');
  const [ta, setTa] = useState(item.name.ta ?? '');
  const [desc, setDesc] = useState(item.description);
  const sizes = item.variants?.map((v) => v.id) ?? ['one' as const];
  const [price, setPrice] = useState<Record<string, string>>(() =>
    Object.fromEntries(item.variants ? item.variants.map((v) => [v.id, String(v.price / 100)]) : [['one', String((item.price ?? 0) / 100)]]));
  const [adds, setAdds] = useState<Record<string, string>>(() => Object.fromEntries(item.adds.map((a) => [a.id, String(a.price / 100)])));
  const [hidden, setHidden] = useState(Boolean(item.hidden));
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const basePrice = (id: string) => (id === 'one' ? base.price ?? 0 : base.variants!.find((v) => v.id === id)!.price);

  /** Only what differs from the printed menu is kept, so "same as printed" is simply nothing. */
  const build = (): ItemOverride | string => {
    const o: ItemOverride = {};
    const name: ItemOverride['name'] = {};
    if (en.trim() !== base.name.en) name.en = en.trim();
    if (si.trim()) name.si = si.trim();
    if (ta.trim()) name.ta = ta.trim();
    if (Object.keys(name).length) o.name = name;
    if (desc.trim() !== base.description) o.description = desc.trim();
    const p: NonNullable<ItemOverride['prices']> = {};
    for (const id of sizes) {
      const c = toCents(price[id] ?? '');
      if (c === null) return 'Prices are whole rupees, like 1650.';
      if (c !== basePrice(id)) p[id as SizeId | 'one'] = c;
    }
    if (Object.keys(p).length) o.prices = p;
    const a: Record<string, Cents> = {};
    for (const opt of base.adds) {
      const c = toCents(adds[opt.id] ?? '');
      if (c === null) return 'Prices are whole rupees, like 300.';
      if (c !== opt.price) a[opt.id] = c;
    }
    if (Object.keys(a).length) o.adds = a;
    if (hidden) o.hidden = true;
    return checkOverride(base, o) ?? o;
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    const o = build();
    if (typeof o === 'string') { setError(o); return; }
    const before = record(item.id, o);
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
              }}>Back to the printed menu</button>
            )}
          </div>

          <section className="group">
            <h2>Name</h2>
            <div className="menued__grid">
              <label>English<input value={en} onChange={(e) => setEn(e.target.value)} maxLength={40} required /></label>
              <label>Sinhala<input value={si} onChange={(e) => setSi(e.target.value)} maxLength={60} lang="si" /></label>
              <label>Tamil<input value={ta} onChange={(e) => setTa(e.target.value)} maxLength={60} lang="ta" /></label>
              <label className="menued__wide">Description<input value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={160} /></label>
            </div>
          </section>

          <section className="group">
            <h2>Price</h2>
            <div className="menued__grid">
              {sizes.map((id) => {
                const v = item.variants?.find((x) => x.id === id);
                const was = basePrice(id);
                return (
                  <label key={id}>
                    {v ? `${v.label}${v.hint ? ` ${v.hint}` : ''}` : 'Price'}
                    <input className="num" inputMode="numeric" value={price[id]} onChange={(e) => setPrice({ ...price, [id]: e.target.value })} aria-label={v ? `${v.label} price` : 'Price'} />
                    {toCents(price[id]) !== was && <span className="menued__was num">Printed {fmt(was)}</span>}
                  </label>
                );
              })}
            </div>
          </section>

          {base.adds.length > 0 && (
            <section className="group">
              <h2>Extras</h2>
              <div className="menued__grid">
                {base.adds.map((opt) => (
                  <label key={opt.id}>
                    {opt.label}
                    <input className="num" inputMode="numeric" value={adds[opt.id]} onChange={(e) => setAdds({ ...adds, [opt.id]: e.target.value })} aria-label={`${opt.label} price`} />
                  </label>
                ))}
              </div>
            </section>
          )}

          <section className="group">
            <label className="menued__check">
              <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
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
  const items = menuItems().filter((m) => m.category === section);
  const costs = useCostContext();
  const [answering, setAnswering] = useState(false);
  const questions = useMemo(() => openQuestions(menuItems(), costs), [costs]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (answering) setAnswering(false);
      else if (!editing) onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, answering, onBack]);

  const said = (message: string, undo: () => void) => setToast({ id: Date.now(), message, undo });

  return (
    <div className="owner">
      <OwnerNav current="menu" onRegister={onBack} />
      <main className="owner__main menuv" aria-label="Menu">
        <h1 className="menuv__title">Menu</h1>
        <p className="menuv__lead">
          {owner ? 'Change a price, a name or what is on offer. It reaches the counter, the kitchen and cheesybeez.com at once.'
            : 'Mark something sold out for today. Prices and names are changed by the owner.'}
        </p>
        {owner && questions.length > 0 && (
          <div className="menuv__gaps">
            <span>
              <b>Costs: {questions.length} {questions.length === 1 ? 'answer' : 'answers'} to go.</b>
              {' '}Your recipes are in; your sheets leave a few things open (like how much sauce a batch makes).
            </span>
            <button type="button" className="chip chip--solid" onClick={() => setAnswering(true)}>Answer</button>
          </div>
        )}
        <nav className="cats" aria-label="Menu sections">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" className="pill" aria-pressed={section === s.id} onClick={() => setSection(s.id)}>{s.label}</button>
          ))}
        </nav>
        <ul className="menuv__list">
          {items.map((m) => (
            <li key={m.id} className={`menuv__row${m.hidden ? ' menuv__row--hidden' : ''}`}>
              <div className="menuv__name">
                <b>{m.name.en}</b>
                {(m.name.si || m.name.ta) && <span>{[m.name.si, m.name.ta].filter(Boolean).join(' · ')}</span>}
                <span className="num">{prices(m)}</span>
                <CostLine item={m} ctx={costs} />
              </div>
              <div className="menuv__tags">
                {m.edited && <span className="status status--paid">Changed</span>}
                {m.hidden && <span className="status status--unpaid">Hidden</span>}
              </div>
              {!m.hidden && (
                <button
                  type="button" className="chip menuv__sold" aria-pressed={Boolean(m.soldOut)}
                  onClick={() => {
                    setSoldOut(m.id, !m.soldOut);
                    said(m.soldOut ? `${m.name.en} is back` : `${m.name.en}: sold out until morning`, () => setSoldOut(m.id, Boolean(m.soldOut)));
                  }}
                >
                  {m.soldOut ? 'Sold out today' : 'Available'}
                </button>
              )}
              {owner && <button type="button" className="chip chip--solid" onClick={() => setEditing(m)} aria-label={`Change ${m.name.en}`}>Change</button>}
            </li>
          ))}
        </ul>
      </main>
      {editing && <Editor item={editing} onClose={() => setEditing(null)} onSaved={(msg, undo) => { setEditing(null); said(msg, undo); }} />}
      {answering && <CostQuestions questions={questions} ctx={costs} onClose={() => setAnswering(false)} />}
      {toast && !editing && !answering && (
        <div className="toast" role="status" key={toast.id}>
          <span>{toast.message}</span>
          <button type="button" onClick={() => { toast.undo(); setToast(null); }}>Undo</button>
        </div>
      )}
    </div>
  );
}
