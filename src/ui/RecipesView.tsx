import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import type { Actor } from '../domain/auth.ts';
import {
  addonCost, addonOf, addonQuestion, batchEdit, batchMakes, batchQuestion, checkAnswer, checkOwnLines, checkPrepName, kitchenLine, KITCHEN_LINE, linesCost, marginOf,
  menuCost, newPrepId, ownPrepOf, ownPreps, prepOf, prepQuestion, questionKind, recipeOf, recipeQuestion, recipeUnit, sizesOf, STOCK_LINE, undefinedNames,
  UNITS, waitingOn, type Answer, type Cost, type CostContext, type OwnPrep, type Recipe,
} from '../domain/costing.ts';
import { menuItems } from '../domain/menu.ts';
import { fmt } from '../domain/money.ts';
import { PREPS, type BookLine } from '../domain/recipeBook.ts';
import { MENU_RECIPES } from '../domain/recipeMap.ts';
import type { MenuItem, Option } from '../domain/types.ts';
import { answerQuestion, recipesViewed, useCatalog, useCostContext } from '../services/inventoryStore.ts';
import { Question } from './CostQuestions.tsx';
import { useMenu } from './menuStore.ts';
import { ItemsTabs } from './ItemsTabs.tsx';
import { OwnerNav } from './OwnerNav.tsx';
import { draftLines, EMPTY_ROW, LinesEditor, readRows, toDraft, useOwner, type Draft } from './RecipeLines.tsx';

/**
 * The recipes of the finished items (SCRUM-75), under Items › Finished. Serves the owner, who
 * knows his kitchen; what he needs next is the recipes that are not complete yet, so they come
 * first. Complete means every line reaches his price list with a known amount, so each sale takes
 * the right stock and the item has its full food cost. They are the owner's alone (managers do not
 * see them; the server takes recipe changes from the owner only) and open for him as he is signed
 * in, with no PIN; each opening is in the audit trail (recipe.viewed). Each save is one audited
 * recipe.answer_set with an Undo; nothing is filled in for him.
 *
 * Semi-processed items (dough, sauces, the cheese blend) are items, not recipes: SemiView below
 * shows them to everyone; once added, one is offered in every recipe like his sheet's batches,
 * priced, and taken from stock through what goes in it.
 */
/** A gap in this many recipes or more is asked once, above them all. */
const SHARED_GAP = 3;

const CATEGORY_LABEL: Record<string, string> = { pizza: 'Pizza', burger: 'Burgers', pasta: 'Pasta' };
const CATEGORY_ORDER = ['pizza', 'burger', 'pasta'];

interface Entry {
  key: string;
  /** The dish it belongs to (none for an extra). */
  itemId?: string;
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
        itemId: item.id,
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

/**
 * The recipes of the finished items (Items › Finished), or one dish's with `focus`, opened from
 * that dish on the menu. There is no Recipes page of its own: a recipe is part of the dish it makes.
 * Semi-processed items are items, not recipes: they have their own page (SemiView), with no PIN.
 */
export function RecipesView({ onRegister, focus }: { onRegister?: () => void; focus?: string }) {
  const owner = useOwner();
  // Each opening is in the audit trail, as it was behind the PIN.
  useEffect(() => { if (owner) recipesViewed(owner); }, [owner]);
  return (
    <div className="owner vault">
      <OwnerNav current="items" onRegister={onRegister} />
      <div className="vault__tabs"><ItemsTabs current="finished" /></div>
      {owner
        ? <Book owner={owner} focus={focus} />
        : <main className="owner__main" aria-label="Recipes"><p className="vault__lead">Only the owner sees the recipes.</p></main>}
    </div>
  );
}

function Book({ owner, focus }: { owner: Actor; focus?: string }) {
  useMenu();
  const ctx = useCostContext();
  const all = useMemo(() => entriesOf(menuItems(), ctx), [ctx]);
  // One dish's recipe, when it was opened from that dish on the menu.
  const entries = useMemo(() => (focus ? all.filter((e) => e.itemId === focus) : all), [all, focus]);
  const dish = focus ? menuItems().find((m) => m.id === focus) : undefined;
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [last, setLast] = useState<{ message: string; undo: () => void } | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || editing) return;
      if (open) setOpen(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, editing]);

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
  const asking = !focus ? [...shared.filter(([q]) => !skipped.includes(q)), ...skipped.flatMap((q) => shared.filter(([s]) => s === q))] : [];
  const first = asking[0] ?? null;
  let n = 0;

  return (
    <main className="owner__main vault__book" aria-label="Recipes">
      <div className="vault__top">
        <h1 className="vault__title">{dish ? `Recipe · ${dish.name.en}` : 'Recipes of the finished items'}</h1>
        <div className="vault__tools">
          {dish && <a className="linkbtn" href="#items/recipe">All recipes</a>}
        </div>
      </div>
      <p className="vault__lead num">
        {complete === entries.length
            ? `${dish ? 'This recipe is' : 'Every recipe is'} complete: each sale takes the right stock.`
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
    </main>
  );
}

const unitAmount = (qty: number, unit: string) => `${Number(qty.toFixed(3)).toLocaleString('en-US')} ${unit}`;

/** What his kitchen makes for the dishes: the semi-processed items he added here, then his sheet's batches. */
function Kitchen({ ctx, entries, editing, canEdit, onEdit, onSave, onDelete }: {
  ctx: CostContext; entries: Entry[]; editing: string | null; canEdit: boolean; onEdit: (key: string | null) => void;
  onSave: (question: string, answer: PrepAnswer | BatchAnswer, name: string) => void;
  /** Takes away one of his own items, or his changes to a sheet batch. */
  onDelete: (question: string, name: string, message: string) => void;
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
  const editor = (p: OwnPrep | null, sheet?: string) => (
    <PrepEditor key={p?.id ?? sheet ?? 'new'} item={p} sheet={sheet} ctx={ctx} onCancel={() => onEdit(null)} onSave={onSave} />
  );

  return (
    <section className="vault__group" aria-label="Made in your kitchen">
      <ul className="vault__list">
        {editing === '' && <li>{editor(null)}</li>}
        {rows.map((row) => {
          if (editing === row.key) return <li key={row.key}>{editor(row.own, row.own ? undefined : row.name)}</li>;
          const prep = row.own ?? prepOf(row.name, ctx.answers)!;
          const edited = !row.own && batchEdit(row.name, ctx.answers) !== null;
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
                      {canEdit && <button type="button" className="chip" onClick={() => onEdit(row.key)}>Edit</button>}
                      {canEdit && row.own && used === 0 && (
                        <button type="button" className="linkbtn" onClick={() => onDelete(prepQuestion(row.own!.id), row.name, `${row.name}: deleted.`)}>Delete</button>
                      )}
                      {canEdit && edited && (
                        <button type="button" className="linkbtn" onClick={() => onDelete(batchQuestion(row.name), row.name, `${row.name}: back to your sheet.`)}>Use your sheet's batch</button>
                      )}
                      <span className="rcard__from">
                        {[row.own ? 'Added here' : edited ? 'Changed here, from your sheet' : 'From your sheet', used ? `in ${used} recipe${used === 1 ? '' : 's'}` : 'in no recipe yet'].join(' · ')}
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
type BatchAnswer = Extract<Answer, { kind: 'batch' }>;

/**
 * Writing a semi-processed item: its name, one batch's output, what goes in. A new one first
 * offers the names his recipes already use but nothing defines (Fried Chicken Cubes), so
 * picking one completes every dish that names it; a new name only when none fits.
 * One of his sheet's batches (`sheet`) keeps its name and unit: his dishes use it by them.
 */
function PrepEditor({ item, sheet, ctx, onSave, onCancel }: {
  item: OwnPrep | null; sheet?: string; ctx: CostContext;
  onSave: (question: string, answer: PrepAnswer | BatchAnswer, name: string) => void; onCancel: () => void;
}) {
  const sheetUnit0 = sheet ? recipeUnit(sheet) ?? PREPS[sheet]?.makes?.unit ?? 'g' : null;
  const sheetMakes = sheet ? batchMakes(sheet, sheetUnit0!, ctx.answers) : null;
  const [name, setName] = useState(item?.name ?? sheet ?? '');
  const [qty, setQty] = useState(item ? String(item.makes.qty) : sheetMakes ? String(sheetMakes.qty) : '');
  const [unit, setUnit] = useState(item?.makes.unit ?? sheetUnit0 ?? 'g');
  const [rows, setRows] = useState<Draft[]>(() => (item ? toDraft(item.lines) : sheet ? toDraft(prepOf(sheet, ctx.answers)?.lines ?? []) : [EMPTY_ROW]));
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
  const suggestions = item || sheet ? [] : undefinedNames(ctx.answers).filter((u) => u.name.toLowerCase().includes(typed) && u.name !== clean).slice(0, 5);
  const draft = draftLines(rows);
  const preview = draft.length ? linesCost(draft, ctx) : null;
  const makes = Number(qty);
  const per100 = unit === 'g' || unit === 'ml';
  const per = preview?.complete && makes > 0
    ? ` · ${fmt(Math.round((preview.cents / makes) * (per100 ? 100 : 1)))} per ${per100 ? `100 ${unit}` : unit === 'pcs' ? 'piece' : 'sheet'}`
    : '';

  const save = (ev: FormEvent) => {
    ev.preventDefault();
    if (sheet) {
      if (!/^\d+(\.\d{1,4})?$/.test(qty.trim()) || !(makes > 0)) return setError('Type how much one batch makes, like 2000.');
      const lines = readRows(rows);
      if (typeof lines === 'string') return setError(lines);
      const answer: BatchAnswer = { kind: 'batch', makes: { qty: makes, unit }, lines };
      const wrong = checkAnswer(batchQuestion(sheet), answer);
      return wrong ? setError(wrong) : onSave(batchQuestion(sheet), answer, sheet);
    }
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
    onSave(prepQuestion(id), answer, clean);
  };

  return (
    <form ref={form} className="rcard rcard--open rcard--edit" onSubmit={save} aria-label={item || sheet ? `${item?.name ?? sheet}: what goes in it` : 'New semi-processed item'}>
      <div className="rcard__head rcard__head--static">
        <span className="rcard__name">{item?.name ?? sheet ?? 'New semi-processed item'}</span>
        <span className="rcard__status">One batch</span>
      </div>
      <div className="prep__top">
        {!sheet && (
          <label className="prep__field prep__name">Name
            <input value={name} maxLength={60} placeholder="Garlic sauce"
              onChange={(e) => { setName(e.target.value); setError(''); }} />
          </label>
        )}
        <label className="prep__field">One batch makes
          <span className="prep__makes">
            <input className="num" inputMode="decimal" value={qty} aria-label="One batch makes"
              onChange={(e) => { setQty(e.target.value); setError(''); }} />
            {sheet ? <span className="redit__unit">{unit}</span> : (
              <select aria-label="Unit" value={unit} onChange={(e) => setUnit(e.target.value)}>
                {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            )}
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
      {sheetUnit && !sheet && <p className="rcard__from">Your recipes already use {clean}: saving it gives them its cost and stock.</p>}
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

/**
 * Items › Semi-processed: what the kitchen makes for the dishes (dough, sauces, the cheese blend).
 * Items, not recipes: everyone who sees Items sees them, with no PIN; what one batch makes, what it
 * costs, which dishes use it. The owner adds and changes them (the server checks it is the owner).
 * Once added, one is offered in every dish's recipe and taken from stock through what goes in it.
 */
export function SemiView({ onRegister }: { onRegister?: () => void }) {
  useMenu();
  const ctx = useCostContext();
  const entries = useMemo(() => entriesOf(menuItems(), ctx), [ctx]);
  const owner = useOwner();
  const canEdit = owner !== null;
  const [editing, setEditing] = useState<string | null>(null);
  const [last, setLast] = useState<{ message: string; undo: () => void } | null>(null);
  return (
    <div className="owner">
      <OwnerNav current="items" onRegister={onRegister} />
      <main className="owner__main semi" aria-label="Semi-processed">
        <ItemsTabs current="semi" />
        <div className="semi__top">
          <h1 className="menuv__title">Semi-processed</h1>
          {canEdit && <button type="button" className="chip chip--solid" onClick={() => setEditing('')}>New semi-processed item</button>}
        </div>
        <p className="menuv__lead">What your kitchen makes for the dishes: dough, sauces, blends. Each is taken from stock through what goes in it.</p>
        {last && (
          <p className="costq__saved" role="status">
            {last.message}
            <button type="button" className="linkbtn" onClick={() => { last.undo(); setLast(null); }}>Undo</button>
          </p>
        )}
        <Kitchen
          ctx={ctx} entries={entries} editing={editing} canEdit={canEdit} onEdit={setEditing}
          onSave={(question, answer, name) => {
            const message = answer.kind === 'prep' ? `${name}: saved. Your recipes can use it now.` : `${name}: saved. Your recipes use it as changed.`;
            setLast({ message, undo: answerQuestion(question, answer, ctx.answers.get(question) ?? null, owner ?? undefined) });
            setEditing(null);
          }}
          onDelete={(question, _name, message) => {
            setLast({ message, undo: answerQuestion(question, null, ctx.answers.get(question) ?? null, owner ?? undefined) });
          }}
        />
      </main>
    </div>
  );
}
