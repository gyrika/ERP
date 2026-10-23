import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { PIN_LENGTH, type Actor } from '../domain/auth.ts';
import {
  addonCost, addonOf, addonQuestion, batchMakes, checkAnswer, checkOwnLines, checkPrepName, kitchenLine, KITCHEN_LINE, linesCost, marginOf,
  menuCost, newPrepId, ownPrepOf, ownPreps, prepQuestion, questionKind, recipeOf, recipeQuestion, recipeUnit, sizesOf, STOCK_LINE, undefinedNames,
  UNITS, waitingOn, type Answer, type Cost, type CostContext, type OwnPrep, type Recipe,
} from '../domain/costing.ts';
import { menuItems } from '../domain/menu.ts';
import { fmt } from '../domain/money.ts';
import { PREPS, type BookLine } from '../domain/recipeBook.ts';
import { MENU_RECIPES } from '../domain/recipeMap.ts';
import type { MenuItem, Option } from '../domain/types.ts';
import { requireOwner } from '../services/auth.ts';
import { answerQuestion, recipesViewed, useCatalog, useCostContext } from '../services/inventoryStore.ts';
import { Question } from './CostQuestions.tsx';
import { useMenu } from './menuStore.ts';
import { OwnerNav } from './OwnerNav.tsx';
import { draftLines, EMPTY_ROW, LinesEditor, readRows, toDraft, useOwnerSession, type Draft } from './RecipeLines.tsx';

/**
 * The owner's recipes (SCRUM-75): the shop's secret, so it is kept like one.
 * Serves the owner, who knows his kitchen; what he needs next is the recipes
 * that are not complete yet, so they come first. Complete means every line
 * reaches his price list with a known amount, so each sale takes the right
 * stock and the item has its full food cost.
 *
 * Opens with his PIN every time (even when he is signed in), locks after a minute
 * untouched or when he leaves, and every opening is in the audit trail
 * (recipe.viewed). Amounts stay blurred until a recipe is opened.
 * Each save is one audited recipe.answer_set with an Undo; nothing is filled in for him.
 *
 * The lock is staged like a safe (SCRUM-91): an open recipe book lies blurred under
 * one warm lamp behind the PIN; the right PIN springs the gold lock, two dark doors
 * slide apart and the recipes come into focus. The recipes are there at once (the
 * doors only cover them for under half a second), so nothing ever waits on it.
 *
 * Below the dishes: what his kitchen makes for them (dough, sauces, the cheese blend), from
 * his sheet, and the semi-processed items he adds here himself. Once added, one is offered
 * in every recipe like his sheet's batches, priced, and taken from stock through what goes in it.
 */
export { RECIPES_IDLE_MS } from './RecipeLines.tsx';
/** How long the doors stay over the recipes after the right PIN (the CSS takes less). */
export const DOORS_MS = 600;
/** A gap in this many recipes or more is asked once, above them all. */
const SHARED_GAP = 3;

const CATEGORY_LABEL: Record<string, string> = { pizza: 'Pizza', burger: 'Burgers', pasta: 'Pasta' };
const CATEGORY_ORDER = ['pizza', 'burger', 'pasta'];

interface Entry {
  key: string;
  question: string;
  title: string;
  group: string;
  category: string;
  price: number;
  recipe: Recipe | null;
  cost: Cost;
  /** The sheet recipe it falls back to when his own is cleared. */
  hasSheet: boolean;
}

const sizeName = (item: MenuItem, size: string) => item.variants?.find((v) => v.id === size)?.label ?? '';

function entriesOf(menu: readonly MenuItem[], ctx: CostContext): Entry[] {
  const out: Entry[] = [];
  for (const item of menu) {
    if (item.hidden) continue;
    for (const size of sizesOf(item)) {
      const label = sizeName(item, size);
      out.push({
        key: recipeQuestion(item.id, size),
        question: recipeQuestion(item.id, size),
        title: `${item.name.en}${label ? ` ${label}` : ''}`,
        group: CATEGORY_LABEL[item.category] ?? item.category,
        category: item.category,
        price: item.variants?.find((v) => v.id === size)?.price ?? item.price ?? 0,
        recipe: recipeOf(item.id, size, ctx.answers),
        cost: menuCost(item.id, size, ctx),
        hasSheet: Boolean(MENU_RECIPES[`${item.id}:${size}`]) || ctx.answers.get(recipeQuestion(item.id, size))?.kind === 'recipe',
      });
    }
  }
  // The extras, once each (the same topping is on every pizza).
  const extras = new Map<string, Option>();
  for (const item of menu) for (const a of item.adds) if (!extras.has(a.id)) extras.set(a.id, a);
  for (const extra of extras.values()) {
    out.push({
      key: addonQuestion(extra.id),
      question: addonQuestion(extra.id),
      title: `Extra ${extra.label.toLowerCase()}`,
      group: 'Extras',
      category: 'extra',
      price: extra.price,
      recipe: addonOf(extra.id, ctx.answers),
      cost: addonCost(extra.id, ctx),
      hasSheet: addonOf(extra.id, new Map())?.origin === 'sheet',
    });
  }
  return out;
}

/** "stock:inv-0006" → "Mozzarella (Prabhat)", "kitchen:k…" → "Garlic Mayo"; his own names as they are. */
const lineName = (name: string, ctx: CostContext) => {
  if (name.startsWith(STOCK_LINE)) return ctx.items.find((i) => i.id === name.slice(STOCK_LINE.length))?.name ?? 'An item no longer in stock';
  if (name.startsWith(KITCHEN_LINE)) return ownPrepOf(name, ctx.answers)?.name ?? 'An item no longer made';
  return name;
};

const amountText = (l: BookLine) => `${Number(l.qty.toFixed(3)).toLocaleString('en-US')} ${l.unit}`;

const upper = (t: string) => `${t[0].toUpperCase()}${t.slice(1)}`;

const statusText = (e: Entry) => {
  if (!e.recipe) return 'No recipe yet';
  // What it waits for, by name (SCRUM-129): a written recipe is not wrong, an amount or price is still to come.
  if (!e.cost.complete) return upper(waitingOn(e.cost.missing, menuItems(), 2));
  const margin = marginOf(e.price, e.cost.cents);
  return `Complete · costs ${fmt(e.cost.cents)}${margin === null ? '' : ` · earns ${Math.round(margin * 100)}%`}`;
};

export function RecipesView({ onRegister }: { onRegister?: () => void }) {
  const [owner, setOwner] = useOwnerSession();
  const [doors, setDoors] = useState(false);

  useEffect(() => {
    if (!doors) return;
    const t = setTimeout(() => setDoors(false), DOORS_MS);
    return () => clearTimeout(t);
  }, [doors]);

  return (
    <div className="owner vault">
      <OwnerNav current="recipes" onRegister={onRegister} />
      {owner
        ? <div className={doors ? 'vault__focus' : undefined}><Book owner={owner} onLock={() => setOwner(null)} /></div>
        : <Lock onOpen={(actor) => { recipesViewed(actor); setOwner(actor); setDoors(true); }} />}
      {owner && doors && <Doors />}
    </div>
  );
}

function Lock({ onOpen }: { onOpen: (owner: Actor) => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const [checking, setChecking] = useState(false);

  const onChange = async (raw: string) => {
    const value = raw.replace(/\D/g, '').slice(0, PIN_LENGTH);
    setPin(value);
    setError(false);
    if (value.length !== PIN_LENGTH) return;
    setChecking(true);
    const owner = await requireOwner(value);
    setChecking(false);
    if (owner) return onOpen(owner);
    setError(true);
    setPin('');
  };

  return (
    <main className="vault__lock" aria-label="Recipes, locked">
      <Scene />
      <LockIcon className={`vault__icon${error ? ' vault__icon--error' : ''}`} />
      <h1 className="vault__name">CheesyBeez recipes</h1>
      <input
        className={`pin${error ? ' pin--error' : ''}`} type="password" inputMode="numeric" autoComplete="off"
        value={pin} readOnly={checking} autoFocus aria-label="Owner PIN" aria-invalid={error} aria-describedby="vault-msg"
        onChange={(e) => void onChange(e.target.value)}
      />
      <p id="vault-msg" className="vault__msg" role={error ? 'alert' : undefined}>
        {error ? 'Only the owner can open the recipes.' : 'Owner PIN'}
      </p>
    </main>
  );
}

/** The gold padlock; its shackle is its own group so it can spring open. */
function LockIcon({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width="40" height="40" aria-hidden="true">
      <path className="vault__shackle" d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="5" y="11" width="14" height="10" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

// Handwriting on the pages: line widths (of 100) per page, fixed so it never jumps.
const LEFT_LINES = [62, 88, 74, 0, 80, 54, 92, 68, 0, 84, 46, 76];
const RIGHT_LINES = [0, 0, 0, 0, 0, 0, 0, 70, 90, 58, 82, 64];

/** An open recipe book under one lamp, too blurred to read: the background of the lock. */
function Scene() {
  const lines = (xs: number[], x0: number) => xs.map((w, i) => (w
    ? <rect key={i} x={x0} y={46 + i * 15} width={w * 1.3} height="3.2" rx="1.6" />
    : null));
  return (
    <div className="vault__scene" aria-hidden="true">
      <div className="vault__lamp" />
      <svg className="vault__tome" viewBox="0 0 320 240" preserveAspectRatio="xMidYMid meet">
        <path className="vault__page" d="M160 22 C 120 12 52 12 14 22 L 14 226 C 52 216 120 216 160 228 Z" />
        <path className="vault__page" d="M160 22 C 200 12 268 12 306 22 L 306 226 C 268 216 200 216 160 228 Z" />
        <path className="vault__spine" d="M160 22 L 160 228" />
        <g className="vault__ink">
          <rect x="34" y="30" width="78" height="6" rx="3" />
          {lines(LEFT_LINES, 34)}
          <circle cx="234" cy="80" r="40" className="vault__sketch" />
          <circle cx="234" cy="80" r="31" className="vault__sketch" />
          <circle cx="220" cy="68" r="5" /><circle cx="248" cy="74" r="5" /><circle cx="230" cy="96" r="5" /><circle cx="252" cy="94" r="4" />
          {lines(RIGHT_LINES, 182)}
        </g>
      </svg>
    </div>
  );
}

/** Right after the PIN: the lock springs and two dark doors slide apart over the recipes. */
function Doors() {
  return (
    <div className="vault__doors" aria-hidden="true">
      <div className="vault__door vault__door--left" />
      <div className="vault__door vault__door--right" />
      <LockIcon className="vault__icon vault__icon--open" />
    </div>
  );
}

function Book({ owner, onLock }: { owner: Actor; onLock: () => void }) {
  useMenu();
  const ctx = useCostContext();
  const entries = useMemo(() => entriesOf(menuItems(), ctx), [ctx]);
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [last, setLast] = useState<{ message: string; undo: () => void } | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  /** The semi-processed item being written: its id, or '' for a new one. */
  const [prepEditing, setPrepEditing] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || editing || prepEditing !== null) return;
      if (open) setOpen(null); else onLock();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, editing, prepEditing, onLock]);

  const complete = entries.filter((e) => e.cost.complete).length;
  // Not complete first, then by the menu's order; groups in a fixed order.
  const groups = [...CATEGORY_ORDER.map((c) => CATEGORY_LABEL[c]), 'Extras']
    .map((g) => ({ name: g, items: entries.filter((e) => e.group === g) }))
    .filter((g) => g.items.length)
    .map((g) => ({ ...g, items: [...g.items.filter((e) => !e.cost.complete), ...g.items.filter((e) => e.cost.complete)] }));
  const saved = (message: string, undo: () => void) => setLast({ message, undo });
  // A gap shared by many recipes (his cheese blend, his sauce) is asked once, at the top.
  const shared = [...entries.reduce((m, e) => {
    for (const q of e.cost.missing) if (questionKind(q) === 'yield' || questionKind(q) === 'ingredient') m.set(q, (m.get(q) ?? 0) + 1);
    return m;
  }, new Map<string, number>())].filter(([, count]) => count >= SHARED_GAP).sort((a, b) => b[1] - a[1]);
  const askedAbove = new Set(shared.map(([q]) => q));
  // One at a time; Skip sends it to the back of the line.
  const asking = [...shared.filter(([q]) => !skipped.includes(q)), ...skipped.flatMap((q) => shared.filter(([s]) => s === q))];
  const first = asking[0] ?? null;
  let n = 0;

  return (
    <main className="owner__main vault__book" aria-label="Recipes">
      <div className="vault__top">
        <h1 className="vault__title">Your recipes</h1>
        <div className="vault__tools">
          <button type="button" className="linkbtn" onClick={() => setPrepEditing('')}>New semi-processed item</button>
          <button type="button" className="linkbtn" onClick={onLock}>Lock</button>
        </div>
      </div>
      <p className="vault__lead num">
        {complete === entries.length
          ? 'Every recipe is complete: each sale takes the right stock.'
          : `${complete} of ${entries.length} complete. Until a recipe is complete, its sales take too little from stock.`}
      </p>
      {last && (
        <p className="costq__saved vault__saved" role="status">
          {last.message}
          <button type="button" className="linkbtn" onClick={() => { last.undo(); setLast(null); }}>Undo</button>
        </p>
      )}
      {first && (
        <section className="vault__group" aria-label="First, these">
          <h2 className="vault__group-name">First, these · {asking.length} to go</h2>
          <ul className="vault__list">
            <li key={first[0]} className="rcard rcard--gap rcard__shared" style={{ '--i': n++ } as CSSProperties}>
              <Question
                q={{ id: first[0], kind: questionKind(first[0]) }} ctx={ctx} actor={owner} autoFocus={false} onAnswered={saved}
                onSkip={asking.length > 1 ? () => setSkipped([...skipped.filter((q) => q !== first[0]), first[0]]) : undefined}
              />
              <p className="rcard__from">In {first[1]} recipes: one answer completes that part of all of them.</p>
            </li>
          </ul>
        </section>
      )}
      {groups.map((g) => (
        <section key={g.name} className="vault__group" aria-label={g.name}>
          <h2 className="vault__group-name">{g.name}</h2>
          <ul className="vault__list">
            {g.items.map((e) => (
              <li key={e.key} style={{ '--i': Math.min(n++, 24) } as CSSProperties}>
                {editing === e.key ? (
                  <Editor
                    entry={e} entries={entries} ctx={ctx}
                    onCancel={() => setEditing(null)}
                    onSave={(lines) => {
                      const before = ctx.answers.get(e.question) ?? null;
                      saved(`${e.title}: your recipe is saved.`, answerQuestion(e.question, { kind: 'own', lines }, before, owner));
                      setEditing(null);
                    }}
                  />
                ) : (
                  <Card
                    entry={e} ctx={ctx} owner={owner} open={open === e.key} asked={askedAbove}
                    onToggle={() => setOpen(open === e.key ? null : e.key)}
                    onEdit={() => { setOpen(e.key); setEditing(e.key); }}
                    onSheet={() => saved(`${e.title}: back to your sheet's recipe.`,
                      answerQuestion(e.question, null, ctx.answers.get(e.question) ?? null, owner))}
                    onSaved={saved}
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      <Kitchen
        ctx={ctx} entries={entries} editing={prepEditing} onEdit={setPrepEditing}
        onSave={(id, answer) => {
          const question = prepQuestion(id);
          saved(`${answer.name}: saved. Your recipes can use it now.`, answerQuestion(question, answer, ctx.answers.get(question) ?? null, owner));
          setPrepEditing(null);
        }}
        onDelete={(p) => {
          const question = prepQuestion(p.id);
          saved(`${p.name}: deleted.`, answerQuestion(question, null, ctx.answers.get(question) ?? null, owner));
        }}
      />
    </main>
  );
}

const unitAmount = (qty: number, unit: string) => `${Number(qty.toFixed(3)).toLocaleString('en-US')} ${unit}`;

/** What his kitchen makes for the dishes: the semi-processed items he added here, then his sheet's batches. */
function Kitchen({ ctx, entries, editing, onEdit, onSave, onDelete }: {
  ctx: CostContext; entries: Entry[]; editing: string | null; onEdit: (id: string | null) => void;
  onSave: (id: string, answer: PrepAnswer) => void; onDelete: (p: OwnPrep) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const own = ownPreps(ctx.answers);
  const rows = [
    ...own.map((p) => ({ key: p.id, name: p.name, own: p as OwnPrep | null })),
    ...Object.keys(PREPS).sort((a, b) => a.localeCompare(b)).map((name) => ({ key: name, name, own: null as OwnPrep | null })),
  ];
  // Used by a dish: by its id, or by the name his sheet uses for it.
  const usedIn = (row: { name: string; own: OwnPrep | null }) => entries.filter((e) => e.recipe?.lines.some((l) =>
    l.name === row.name || (row.own && l.name === kitchenLine(row.own.id)))).length;
  const editor = (p: OwnPrep | null) => (
    <PrepEditor key={p?.id ?? 'new'} item={p} ctx={ctx} onCancel={() => onEdit(null)} onSave={onSave} />
  );

  return (
    <section className="vault__group" aria-label="Made in your kitchen">
      <h2 className="vault__group-name">Made in your kitchen · semi-processed</h2>
      <ul className="vault__list">
        {editing === '' && <li>{editor(null)}</li>}
        {rows.map((row) => {
          if (row.own && editing === row.own.id) return <li key={row.key}>{editor(row.own)}</li>;
          const prep = row.own ?? PREPS[row.name];
          const cost = linesCost(prep.lines, ctx);
          const used = usedIn(row);
          const makes = row.own ? row.own.makes : batchMakes(row.name, recipeUnit(row.name) ?? prep.makes?.unit ?? 'g', ctx.answers);
          const status = [
            makes ? `Makes ${unitAmount(makes.qty, makes.unit)}` : 'Batch size not known yet',
            cost.complete ? `costs ${fmt(cost.cents)} a batch` : waitingOn(cost.missing, menuItems(), 2),
          ].join(' · ');
          const isOpen = open === row.key;
          return (
            <li key={row.key}>
              <article className={`rcard rcard--${cost.complete && makes ? 'ok' : 'gap'}${isOpen ? ' rcard--open' : ''}`}>
                <button type="button" className="rcard__head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : row.key)}>
                  <span className="rcard__name">{row.name}</span>
                  <span className="rcard__status num">{status}</span>
                </button>
                <ul className="rcard__lines" aria-hidden={!isOpen}>
                  {prep.lines.map((l, i) => (
                    <li key={i}><span>{lineName(l.name, ctx)}</span><span className="rcard__amt num">{amountText(l)}</span></li>
                  ))}
                </ul>
                {isOpen && (
                  <div className="rcard__more">
                    <div className="rcard__actions">
                      {row.own && <button type="button" className="chip" onClick={() => onEdit(row.own!.id)}>Edit</button>}
                      {row.own && used === 0 && <button type="button" className="linkbtn" onClick={() => onDelete(row.own!)}>Delete</button>}
                      <span className="rcard__from">
                        {[row.own ? 'Added here' : 'From your sheet', used ? `in ${used} recipe${used === 1 ? '' : 's'}` : 'in no recipe yet'].join(' · ')}
                      </span>
                    </div>
                  </div>
                )}
              </article>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

type PrepAnswer = Extract<Answer, { kind: 'prep' }>;

/**
 * Writing a semi-processed item: its name, one batch's output, what goes in. A new one first
 * offers the names his recipes already use but nothing defines (Fried Chicken Cubes), so
 * picking one completes every dish that names it; a new name only when none fits.
 */
function PrepEditor({ item, ctx, onSave, onCancel }: {
  item: OwnPrep | null; ctx: CostContext; onSave: (id: string, answer: PrepAnswer) => void; onCancel: () => void;
}) {
  const [name, setName] = useState(item?.name ?? '');
  const [qty, setQty] = useState(item ? String(item.makes.qty) : '');
  const [unit, setUnit] = useState(item?.makes.unit ?? 'g');
  const [rows, setRows] = useState<Draft[]>(() => (item ? toDraft(item.lines) : [EMPTY_ROW]));
  const { suppliers } = useCatalog();
  const [error, setError] = useState('');
  const form = useRef<HTMLFormElement>(null);

  // Opened from the top of the page, it is written at the bottom, with what his kitchen makes: go there, name first.
  useEffect(() => {
    form.current?.scrollIntoView?.({ block: 'start' });
    form.current?.querySelector('input')?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const clean = name.trim().replace(/\s+/g, ' ');
  const sheetUnit = recipeUnit(clean);
  const typed = clean.toLowerCase();
  const suggestions = item ? [] : undefinedNames(ctx.answers).filter((u) => u.name.toLowerCase().includes(typed) && u.name !== clean).slice(0, 5);
  const draft = draftLines(rows);
  const preview = draft.length ? linesCost(draft, ctx) : null;
  const makes = Number(qty);
  const per100 = unit === 'g' || unit === 'ml';
  const per = preview?.complete && makes > 0
    ? ` · ${fmt(Math.round((preview.cents / makes) * (per100 ? 100 : 1)))} per ${per100 ? `100 ${unit}` : unit === 'pcs' ? 'piece' : 'sheet'}`
    : '';

  const save = (ev: FormEvent) => {
    ev.preventDefault();
    const taken = ownPreps(ctx.answers).some((p) => p.id !== item?.id && p.name.toLowerCase() === clean.toLowerCase());
    if (taken) return setError('You already have one with that name.');
    const wrongName = checkPrepName(clean);
    if (wrongName) return setError(wrongName);
    if (!/^\d+(\.\d{1,4})?$/.test(qty.trim()) || !(makes > 0)) return setError('Type how much one batch makes, like 2000.');
    const lines = readRows(rows);
    if (typeof lines === 'string') return setError(lines);
    const id = item?.id ?? newPrepId();
    const answer: PrepAnswer = { kind: 'prep', name: clean, makes: { qty: makes, unit }, lines };
    const wrong = checkAnswer(prepQuestion(id), answer);
    if (wrong) return setError(wrong);
    onSave(id, answer);
  };

  return (
    <form ref={form} className="rcard rcard--open rcard--edit" onSubmit={save} aria-label={item ? `${item.name}: what goes in it` : 'New semi-processed item'}>
      <div className="rcard__head rcard__head--static">
        <span className="rcard__name">{item ? item.name : 'New semi-processed item'}</span>
        <span className="rcard__status">One batch</span>
      </div>
      <div className="prep__top">
        <label className="prep__field prep__name">Name
          <input value={name} maxLength={60} placeholder="Garlic sauce"
            onChange={(e) => { setName(e.target.value); setError(''); }} />
        </label>
        <label className="prep__field">One batch makes
          <span className="prep__makes">
            <input className="num" inputMode="decimal" value={qty} aria-label="One batch makes"
              onChange={(e) => { setQty(e.target.value); setError(''); }} />
            <select aria-label="Unit" value={unit} onChange={(e) => setUnit(e.target.value)}>
              {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </span>
        </label>
      </div>
      {suggestions.length > 0 && (
        <div className="chips" role="group" aria-label="Your recipes name these">
          <span className="rcard__from">Your recipes name these, nothing makes them yet:</span>
          {suggestions.map((u) => (
            <button key={u.name} type="button" className="chip"
              onClick={() => { setName(u.name); setUnit(u.unit); setError(''); }}>
              {u.name} · {u.dishes} {u.dishes === 1 ? 'dish' : 'dishes'}
            </button>
          ))}
        </div>
      )}
      {sheetUnit && <p className="rcard__from">Your recipes already use {clean}: saving it gives them its cost and stock.</p>}
      <p className="rcard__from">What goes into one batch:</p>
      <LinesEditor rows={rows} onChange={(r) => { setRows(r); setError(''); }} ctx={ctx} suppliers={suppliers} ownPrepsToo={false} />
      {preview && (
        <p className="redit__cost num" aria-live="polite">
          {preview.complete
            ? `One batch costs ${fmt(preview.cents)}${per}`
            : `One batch costs ${fmt(preview.cents)} so far · ${waitingOn(preview.missing, menuItems())}`}
        </p>
      )}
      {error && <p className="costq__error" role="alert">{error}</p>}
      <div className="costq__actions">
        <button type="button" className="linkbtn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="cta">Save</button>
      </div>
    </form>
  );
}

function Card({ entry: e, ctx, owner, open, asked, onToggle, onEdit, onSheet, onSaved }: {
  entry: Entry; ctx: CostContext; owner: Actor; open: boolean; asked: ReadonlySet<string>;
  onToggle: () => void; onEdit: () => void; onSheet: () => void; onSaved: (message: string, undo: () => void) => void;
}) {
  const tone = !e.recipe ? 'empty' : e.cost.complete ? 'ok' : 'gap';
  // Gaps the Recipes screen answers in place (a batch's output, an ingredient's item or price).
  const fixes = e.cost.missing.filter((q) => !asked.has(q) && (questionKind(q) === 'yield' || questionKind(q) === 'ingredient'));
  const above = e.cost.missing.filter((q) => asked.has(q)).length;
  return (
    <article className={`rcard rcard--${tone}${open ? ' rcard--open' : ''}`}>
      <button type="button" className="rcard__head" aria-expanded={open} onClick={e.recipe ? onToggle : onEdit}>
        <span className="rcard__name">{e.title}</span>
        <span className="rcard__status num">{statusText(e)}</span>
      </button>
      {!e.recipe && <button type="button" className="rcard__write" onClick={onEdit}>Write it</button>}
      {e.recipe && (
        <ul className="rcard__lines" aria-hidden={!open}>
          {e.recipe.lines.map((l, i) => (
            <li key={i}>
              <span>{lineName(l.name, ctx)}</span>
              <span className="rcard__amt num">{amountText(l)}</span>
            </li>
          ))}
        </ul>
      )}
      {open && e.recipe && (
        <div className="rcard__more">
          {above > 0 && <p className="rcard__from">{above} of its gaps {above === 1 ? 'is' : 'are'} asked at the top.</p>}
          {fixes.map((q) => (
            <div key={q} className="rcard__fix">
              <Question q={{ id: q, kind: questionKind(q) }} ctx={ctx} actor={owner} autoFocus={false} onAnswered={onSaved} />
            </div>
          ))}
          <div className="rcard__actions">
            <button type="button" className="chip" onClick={onEdit}>Edit recipe</button>
            {e.recipe.origin === 'own' && e.hasSheet && (
              <button type="button" className="linkbtn" onClick={onSheet}>Use your sheet's recipe</button>
            )}
            <span className="rcard__from">
              {e.recipe.origin === 'own' ? 'Written here' : `From your sheet: ${e.recipe.product}`}
            </span>
          </div>
        </div>
      )}
    </article>
  );
}

/** The cost of an entry if it were made with these lines. */
const costAs = (entry: Entry, lines: BookLine[], ctx: CostContext): Cost => {
  const answers = new Map(ctx.answers).set(entry.question, { kind: 'own', lines });
  const [kind, id, size] = entry.question.split(':');
  return kind === 'addon' ? addonCost(id, { ...ctx, answers }) : menuCost(id, size ?? '', { ...ctx, answers });
};

function Editor({ entry, entries, ctx, onSave, onCancel }: {
  entry: Entry; entries: Entry[]; ctx: CostContext; onSave: (lines: BookLine[]) => void; onCancel: () => void;
}) {
  const [rows, setRows] = useState<Draft[]>(() => (entry.recipe ? toDraft(entry.recipe.lines) : [EMPTY_ROW]));
  const { suppliers } = useCatalog();
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // Start from a recipe of the same kind (Sausages M from BBQ Sausages M), the same size first.
  const sameSize = entry.question.split(':')[2] ?? '';
  const starts = entries
    .filter((o) => o.key !== entry.key && o.recipe && o.category === entry.category)
    .sort((a, b) => Number(b.question.endsWith(`:${sameSize}`)) - Number(a.question.endsWith(`:${sameSize}`)))
    .slice(0, 8);

  // What it would cost and earn as written so far (lines with a name and an amount).
  const draft = draftLines(rows);
  const preview = draft.length ? costAs(entry, draft, ctx) : null;
  const margin = preview?.complete ? marginOf(entry.price, preview.cents) : null;

  const save = (ev: FormEvent) => {
    ev.preventDefault();
    const lines = readRows(rows);
    if (typeof lines === 'string') return setError(lines);
    const wrong = checkOwnLines(lines);
    if (wrong) return setError(wrong);
    onSave(lines);
  };

  return (
    <form className="rcard rcard--open rcard--edit" onSubmit={save} aria-label={`${entry.title}: recipe`}>
      <div className="rcard__head rcard__head--static">
        <span className="rcard__name">{entry.title}</span>
        <span className="rcard__status">One {entry.category === 'extra' ? 'portion' : 'item'}</span>
      </div>
      {starts.length > 0 && (
        <div className="chips" role="group" aria-label="Start from">
          <span className="rcard__from">Start from</span>
          {starts.map((o) => (
            <button key={o.key} type="button" className="chip" onClick={() => { setRows(toDraft(o.recipe!.lines)); setError(''); }}>{o.title}</button>
          ))}
        </div>
      )}
      <LinesEditor rows={rows} onChange={(r) => { setRows(r); setError(''); }} ctx={ctx} suppliers={suppliers} />
      {preview && (
        <p className="redit__cost num" aria-live="polite">
          {preview.complete
            ? `Costs ${fmt(preview.cents)}${margin === null ? '' : ` · earns ${Math.round(margin * 100)}% of ${fmt(entry.price)}`}`
            : `Costs ${fmt(preview.cents)} so far · ${waitingOn(preview.missing, menuItems())}`}
        </p>
      )}
      {error && <p className="costq__error" role="alert">{error}</p>}
      <div className="costq__actions">
        <button type="button" className="linkbtn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="cta">Save recipe</button>
      </div>
    </form>
  );
}
