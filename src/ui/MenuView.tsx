import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Actor } from '../domain/auth.ts';
import {
  checkOwnLines, linesCost, marginOf, menuCost, recipeOf, recipeQuestion, sizesOf, type CostContext,
} from '../domain/costing.ts';
import { MENU, menuItems, menuState, startingItem } from '../domain/menu.ts';
import { checkNewItem, checkOverride, newItemSizes, nextMorning, type ItemOverride, type NewItem } from '../domain/menuEdits.ts';
import { fmt } from '../domain/money.ts';
import type { BookLine } from '../domain/recipeBook.ts';
import type { Category, Cents, MenuItem, SizeId } from '../domain/types.ts';
import { currentCashier } from '../services/auth.ts';
import { answerQuestion, useCatalog, useCostContext } from '../services/inventoryStore.ts';
import { appendEvent } from './eventLog.ts';
import { useMenu } from './menuStore.ts';
import { OwnerNav } from './OwnerNav.tsx';
import { draftLines, EMPTY_ROW, LinesEditor, OwnerPin, readRows, toDraft, useOwnerSession, type Draft } from './RecipeLines.tsx';

/**
 * The owner's menu (#menu). Serves the owner: they know their menu and want one change made
 * now, a price, a name, something off for today, without calling anyone. The single next
 * thing: find the item, change it, save. Managers see the same list with "Sold out today" only.
 * Every change is an event (who, when, before/after) with an Undo, and reaches the counter,
 * the kitchen and cheesybeez.com at once.
 */
const SECTIONS: { id: Category; label: string; one: string }[] = [
  { id: 'pizza', label: 'Pizza', one: 'pizza' }, { id: 'burger', label: 'Burgers', one: 'burger' }, { id: 'pasta', label: 'Pasta', one: 'pasta' },
];
/** The item as printed, or as the owner added it. */
const startOf = (id: string) => startingItem(id) ?? MENU.find((m) => m.id === id)!;
const prices = (m: MenuItem) => (m.variants ? m.variants.map((v) => `${v.id} ${fmt(v.price)}`).join(' · ') : fmt(m.price ?? 0));

/**
 * "Cost M 412 · 75%  L 690 · 72%", "Cost so far M 38 · L 66 · 5 to answer in Recipes", or, with
 * no recipe, what that means for him: its sales take nothing from stock (SCRUM-77, SCRUM-129).
 */
function CostLine({ item, ctx, onWrite }: { item: MenuItem; ctx: CostContext; onWrite?: () => void }) {
  const sizes = sizesOf(item).map((size) => ({
    size,
    price: size ? item.variants!.find((v) => v.id === size)!.price : (item.price ?? 0),
    cost: menuCost(item.id, size, ctx),
  }));
  const gaps = new Set(sizes.flatMap((s) => s.cost.missing)).size;
  if (sizes.every((s) => !s.cost.origin)) {
    return (
      <span className="menuv__cost">
        No recipe yet: its sales don't take stock.
        {onWrite && <button type="button" className="linkbtn menuv__write" onClick={onWrite}>Write the recipe</button>}
      </span>
    );
  }
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
      {gaps > 0 && ` · ${gaps} to answer in Recipes`}
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
const addItem = (itemId: string, item: NewItem | null) =>
  appendEvent({ type: 'menu.item_added', at: Date.now(), orderNumber: 0, actor: currentCashier(), itemId, item });

/** "Chicken Alfredo" → "new-chicken-alfredo", or "new-chicken-alfredo-2" if that was ever used. */
const newId = (en: string): string => {
  const slug = en.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';
  const taken = new Set(menuItems().map((m) => m.id));
  let id = `new-${slug}`;
  for (let n = 2; taken.has(id); n++) id = `new-${slug}-${n}`;
  return id;
};

/** Typing "pasta" or a name already on the menu must keep finding one item, so names stay unique. */
const nameTaken = (en: string): MenuItem | undefined => {
  const t = en.trim().toLowerCase();
  return menuItems().find((m) => !m.removed && (m.name.en.toLowerCase() === t || m.aliases.includes(t)));
};

/** Escape closes a sheet. */
const useEscape = (onClose: () => void) => useEffect(() => {
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}, [onClose]);

/** A size as his recipes name it: '' for a single-price item. */
const recipeSize = (id: SizeId | 'one') => (id === 'one' ? '' : id);
const pct = (m: number | null) => (m === null ? '' : `${Math.round(m * 100)}%`);
const words = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3);

interface DishSize { id: string; label: string; price: Cents }

/**
 * What goes in a dish, size by size, behind the owner's PIN. It starts from the dish most like
 * this one (shared words in the name first), so he changes what differs instead of starting
 * from nothing. Used when adding a dish and by "Write the recipe" on a dish without one.
 */
function DishRecipe({ category, name, sizes, rows, onRows, owner, onOwner, ctx }: {
  category: Category; name: string; sizes: DishSize[]; rows: Record<string, Draft[]>; onRows: (rows: Record<string, Draft[]>) => void;
  owner: Actor | null; onOwner: (owner: Actor) => void; ctx: CostContext;
}) {
  const { suppliers } = useCatalog();
  const [size, setSize] = useState(sizes[0].id);
  if (!owner) return <OwnerPin onOpen={onOwner} />;

  const mine = words(name);
  const likes = menuItems()
    .filter((m) => m.category === category && !m.removed && !m.hidden && m.name.en !== name && sizes.every((s) => recipeOf(m.id, s.id, ctx.answers)))
    .map((m) => ({ m, shared: words(m.name.en).filter((w) => mine.includes(w)).length }))
    .sort((x, y) => y.shared - x.shared || x.m.name.en.localeCompare(y.m.name.en))
    .slice(0, 8);
  const here = sizes.find((s) => s.id === size) ?? sizes[0];
  const draft = draftLines(rows[here.id] ?? []);
  const cost = draft.length ? linesCost(draft, ctx) : null;
  const margin = cost?.complete && here.price ? marginOf(here.price, cost.cents) : null;

  return (
    <div className="dish__recipe">
      {likes.length > 0 && (
        <div className="chips" role="group" aria-label="Start from">
          <span className="dish__hint">Start from</span>
          {likes.map(({ m }) => (
            <button key={m.id} type="button" className="chip" onClick={() =>
              onRows(Object.fromEntries(sizes.map((s) => [s.id, toDraft(recipeOf(m.id, s.id, ctx.answers)!.lines)])))}>
              {m.name.en}
            </button>
          ))}
        </div>
      )}
      {sizes.length > 1 && (
        <nav className="cats" aria-label="Sizes">
          {sizes.map((s) => (
            <button key={s.id} type="button" className="pill" aria-pressed={s.id === here.id} onClick={() => setSize(s.id)}>{s.label}</button>
          ))}
        </nav>
      )}
      <LinesEditor rows={rows[here.id] ?? [EMPTY_ROW]} onChange={(r) => onRows({ ...rows, [here.id]: r })} ctx={ctx} suppliers={suppliers} />
      {cost && (
        <p className="redit__cost num" aria-live="polite">
          {sizes.length > 1 && `${here.label}: `}
          {cost.complete
            ? `costs Rs ${fmt(cost.cents)}${margin === null ? '' : ` · earns ${pct(margin)} of Rs ${fmt(here.price)}`}`
            : `costs Rs ${fmt(cost.cents)} so far · ${cost.missing.length} ${cost.missing.length === 1 ? 'thing' : 'things'} to answer in Recipes`}
        </p>
      )}
    </div>
  );
}

/** Every size written properly: the lines per size, or what to fix. */
const readDish = (sizes: DishSize[], rows: Record<string, Draft[]>): Record<string, BookLine[]> | string => {
  const out: Record<string, BookLine[]> = {};
  for (const s of sizes) {
    const lines = readRows(rows[s.id] ?? []);
    if (typeof lines === 'string') return lines;
    if (!lines.length) return sizes.length > 1 ? `Write what goes in the ${s.label} too, or start from a dish above.` : 'Write what goes in it.';
    const wrong = checkOwnLines(lines);
    if (wrong) return sizes.length > 1 ? `${s.label}: ${wrong}` : wrong;
    out[s.id] = lines;
  }
  return out;
};

/** Saves his recipe for each size (as the owner who opened them); returns one Undo for all. */
const saveRecipes = (itemId: string, lines: Record<string, BookLine[]>, owner: Actor, ctx: CostContext): (() => void) => {
  const undos = Object.entries(lines).map(([size, l]) => {
    const q = recipeQuestion(itemId, size);
    return answerQuestion(q, { kind: 'own', lines: l }, ctx.answers.get(q) ?? null, owner);
  });
  return () => { for (const undo of undos.reverse()) undo(); };
};

/** "M earns 75% · L earns 72%", from lines just written (before the events fold in). */
const earnings = (sizes: DishSize[], lines: Record<string, BookLine[]>, ctx: CostContext): string =>
  sizes.map((s) => {
    const c = linesCost(lines[s.id], ctx);
    const m = c.complete ? marginOf(s.price, c.cents) : null;
    return `${sizes.length > 1 ? `${s.id} ` : ''}${m === null ? `costs Rs ${fmt(c.cents)} so far` : `earns ${pct(m)}`}`;
  }).join(' · ');

const STEPS = ['Name', 'What goes in it', 'Price'] as const;
type Step = 0 | 1 | 2;

/**
 * Add a dish (SCRUM-129). Serves the owner, who thinks of a dish as one thing: what it is,
 * what goes in it, what he charges, in that order, so he sets the price knowing its cost.
 * The recipe is behind his PIN (the shop's secret) and can wait ("Later"); nothing is saved
 * until the last step, then the item and its recipes go in at once with one Undo.
 */
function AddDish({ section, ctx, onSaved, onClose }: {
  section: (typeof SECTIONS)[number]; ctx: CostContext; onSaved: (message: string, undo: () => void) => void; onClose: () => void;
}) {
  const shape = newItemSizes(section.id, MENU);
  const [step, setStep] = useState<Step>(0);
  const [en, setEn] = useState('');
  const [si, setSi] = useState('');
  const [ta, setTa] = useState('');
  const [desc, setDesc] = useState('');
  const [price, setPrice] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<Record<string, Draft[]>>({});
  const [owner, setOwner] = useOwnerSession();
  /** The recipes as written, and the owner who wrote them; null: "Later". */
  const recipe = useRef<{ lines: Record<string, BookLine[]>; by: Actor } | null>(null);
  const [error, setError] = useState('');
  useEscape(onClose);

  const sizes: DishSize[] = shape.map((s) => ({ id: recipeSize(s.id), label: s.label === 'Price' ? 'Price' : s.label, price: toCents(price[s.id] ?? '') ?? 0 }));
  const go = (next: Step) => { setError(''); setStep(next); };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (step === 0) {
      const same = nameTaken(en);
      if (same) return setError(`${same.name.en} is already on the menu. Give this one another name.`);
      const bad = en.trim() ? null : 'Type its name in English.';
      return bad ? setError(bad) : go(1);
    }
    if (step === 1) {
      if (!owner) return setError('Type your PIN, or choose Later.');
      const lines = readDish(sizes, rows);
      if (typeof lines === 'string') return setError(lines);
      recipe.current = { lines, by: owner };
      return go(2);
    }
    const prices: NewItem['prices'] = {};
    for (const s of shape) {
      const c = toCents(price[s.id] ?? '');
      if (c === null || c === 0) return setError(`Type a price for ${s.id === 'one' ? 'it' : s.label}, in whole rupees, like 1650.`);
      prices[s.id] = c;
    }
    const item: NewItem = {
      category: section.id,
      name: { en: en.trim(), ...(si.trim() ? { si: si.trim() } : {}), ...(ta.trim() ? { ta: ta.trim() } : {}) },
      description: desc.trim(),
      prices,
    };
    const bad = checkNewItem(item, MENU);
    if (bad) return setError(`${bad[0].toUpperCase()}${bad.slice(1)}.`);
    const id = newId(item.name.en);
    addItem(id, item);
    const written = recipe.current;
    const undoRecipes = written ? saveRecipes(id, written.lines, written.by, ctx) : () => {};
    onSaved(
      `${item.name.en} is on the counter · ${written ? earnings(sizes, written.lines, ctx) : 'no recipe yet, so its sales don\'t take stock'}`,
      () => { undoRecipes(); addItem(id, null); },
    );
  };

  const later = () => { recipe.current = null; go(2); };
  const written = recipe.current;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <form className="sheet menued" role="dialog" aria-modal="true" aria-label={`Add a ${section.one}`} onSubmit={submit}>
        <div className="sheet__body">
          <div className="sheet__title"><h1>{step === 0 || !en.trim() ? `Add a ${section.one}` : en.trim()}</h1></div>
          <ol className="dish__steps" aria-label="Steps">
            {STEPS.map((label, i) => (
              <li key={label} aria-current={i === step ? 'step' : undefined} className={i < step ? 'dish__done' : undefined}>{label}</li>
            ))}
          </ol>

          {step === 0 && (
            <section className="group">
              <div className="menued__grid">
                <label>English<input value={en} onChange={(e) => { setEn(e.target.value); setError(''); }} maxLength={40} autoFocus /></label>
                <label>Sinhala<input value={si} onChange={(e) => setSi(e.target.value)} maxLength={60} lang="si" /></label>
                <label>Tamil<input value={ta} onChange={(e) => setTa(e.target.value)} maxLength={60} lang="ta" /></label>
                <label className="menued__wide">Description<input value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={160} /></label>
              </div>
            </section>
          )}

          {step === 1 && (
            <section className="group">
              <p className="dish__hint">One {section.one}: what goes in, and how much. Each sale then takes it from your stock.</p>
              <DishRecipe
                category={section.id} name={en.trim()} sizes={sizes} rows={rows} onRows={(r) => { setRows(r); setError(''); }}
                owner={owner} onOwner={setOwner} ctx={ctx}
              />
            </section>
          )}

          {step === 2 && (
            <section className="group">
              <div className="menued__grid">
                {shape.map((s, i) => {
                  const c = toCents(price[s.id] ?? '');
                  const cost = written ? linesCost(written.lines[sizes[i].id], ctx) : null;
                  const margin = cost?.complete && c ? marginOf(c, cost.cents) : null;
                  return (
                    <label key={s.id}>
                      {s.hint ? `${s.label} ${s.hint}` : s.label}
                      <input className="num" inputMode="numeric" value={price[s.id] ?? ''} autoFocus={i === 0}
                        onChange={(e) => { setPrice({ ...price, [s.id]: e.target.value }); setError(''); }}
                        aria-label={s.id === 'one' ? 'Price' : `${s.label} price`} />
                      {cost && (
                        <span className="menued__was num">
                          {cost.complete ? `Costs Rs ${fmt(cost.cents)}` : `Costs Rs ${fmt(cost.cents)} so far`}
                          {margin !== null && <b>{` · earns ${pct(margin)}`}</b>}
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
              <p className="menued__note">
                {written
                  ? `Extras are the same as on the other ${section.label.toLowerCase()}.`
                  : 'No recipe yet: until you write it, its sales don\'t take stock. Write it any time from the Menu.'}
              </p>
            </section>
          )}
          {error && <p className="reason-msg" role="alert">{error}</p>}
        </div>
        <div className="sheet__foot menued__foot">
          <button type="button" className="linkbtn" onClick={step === 0 ? onClose : () => go((step - 1) as Step)}>{step === 0 ? 'Cancel' : 'Back'}</button>
          {step === 1 && <button type="button" className="linkbtn" onClick={later}>Later</button>}
          <button type="submit" className="cta">{step === 2 ? 'Add to the menu' : 'Next'}</button>
        </div>
      </form>
    </>
  );
}

/** "Write the recipe" for a dish already on the menu that has none (behind the owner's PIN). */
function WriteRecipe({ item, ctx, onSaved, onClose }: {
  item: MenuItem; ctx: CostContext; onSaved: (message: string, undo: () => void) => void; onClose: () => void;
}) {
  const sizes: DishSize[] = sizesOf(item).map((size) => {
    const v = item.variants?.find((x) => x.id === size);
    return { id: size, label: v?.label ?? 'Price', price: v?.price ?? item.price ?? 0 };
  });
  const [rows, setRows] = useState<Record<string, Draft[]>>({});
  const [owner, setOwner] = useOwnerSession();
  const [error, setError] = useState('');
  useEscape(onClose);

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!owner) return setError('Type your PIN first.');
    const lines = readDish(sizes, rows);
    if (typeof lines === 'string') return setError(lines);
    onSaved(`${item.name.en}: recipe saved · ${earnings(sizes, lines, ctx)}`, saveRecipes(item.id, lines, owner, ctx));
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <form className="sheet menued" role="dialog" aria-modal="true" aria-label={`${item.name.en}: recipe`} onSubmit={save}>
        <div className="sheet__body">
          <div className="sheet__title"><h1>{item.name.en}</h1></div>
          <section className="group">
            <p className="dish__hint">What goes in one, and how much. Each sale then takes it from your stock.</p>
            <DishRecipe
              category={item.category} name={item.name.en} sizes={sizes} rows={rows} onRows={(r) => { setRows(r); setError(''); }}
              owner={owner} onOwner={setOwner} ctx={ctx}
            />
          </section>
          {error && <p className="reason-msg" role="alert">{error}</p>}
        </div>
        <div className="sheet__foot menued__foot">
          <button type="button" className="linkbtn" onClick={onClose}>Cancel</button>
          <button type="submit" className="cta">Save recipe</button>
        </div>
      </form>
    </>
  );
}

function Editor({ item, onSaved, onClose }: { item: MenuItem; onSaved: (message: string, undo: () => void) => void; onClose: () => void }) {
  const base = startOf(item.id);
  const startName = base.added ? 'how you added it' : 'the printed menu';
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

  useEscape(onClose);

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
                onSaved(`${base.name.en}: back to ${startName}`, () => record(item.id, before));
              }}>Back to {startName}</button>
            )}
            {base.added && (
              <button type="button" className="linkbtn" onClick={() => {
                // Only his own dishes go for good; printed ones are hidden instead.
                const { removed: _, ...was } = menuState().added[item.id];
                addItem(item.id, null);
                onSaved(`Deleted ${item.name.en}`, () => addItem(item.id, was));
              }}>Delete</button>
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
                    {toCents(price[id]) !== was && <span className="menued__was num">{base.added ? 'Was' : 'Printed'} {fmt(was)}</span>}
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
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState<{ id: number; message: string; undo: () => void } | null>(null);
  const items = menuItems().filter((m) => m.category === section && !m.removed);
  const here = SECTIONS.find((s) => s.id === section)!;
  const costs = useCostContext();
  const [writing, setWriting] = useState<MenuItem | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editing && !adding && !writing) onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, adding, writing, onBack]);

  const said = (message: string, undo: () => void) => setToast({ id: Date.now(), message, undo });

  return (
    <div className="owner">
      <OwnerNav current="menu" onRegister={onBack} />
      <main className="owner__main menuv" aria-label="Menu">
        <h1 className="menuv__title">Menu</h1>
        <p className="menuv__lead">
          {owner ? 'Change a price, a name or what is on offer, or add something new. It reaches the counter, the kitchen and cheesybeez.com at once.'
            : 'Mark something sold out for today. Prices and names are changed by the owner.'}
        </p>
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
                <CostLine item={m} ctx={costs} onWrite={owner && !m.hidden ? () => setWriting(m) : undefined} />
              </div>
              <div className="menuv__tags">
                {m.added && <span className="status status--paid">Added</span>}
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
        {owner && (
          <button type="button" className="chip menuv__add" onClick={() => setAdding(true)}>+ Add a {here.one}</button>
        )}
      </main>
      {adding && <AddDish section={here} ctx={costs} onClose={() => setAdding(false)} onSaved={(msg, undo) => { setAdding(false); said(msg, undo); }} />}
      {writing && <WriteRecipe item={writing} ctx={costs} onClose={() => setWriting(null)} onSaved={(msg, undo) => { setWriting(null); said(msg, undo); }} />}
      {editing && <Editor item={editing} onClose={() => setEditing(null)} onSaved={(msg, undo) => { setEditing(null); said(msg, undo); }} />}
      {toast && !editing && !adding && !writing && (
        <div className="toast" role="status" key={toast.id}>
          <span>{toast.message}</span>
          <button type="button" onClick={() => { toast.undo(); setToast(null); }}>Undo</button>
        </div>
      )}
    </div>
  );
}
