import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import { PIN_LENGTH, type Actor } from '../domain/auth.ts';
import {
  addonCost, addonOf, addonQuestion, checkOwnLines, marginOf, menuCost, questionKind, recipeOf, recipeQuestion, recipeUnit,
  sizesOf, STOCK_LINE, stockLine, type Cost, type CostContext, type Recipe,
} from '../domain/costing.ts';
import { menuItems } from '../domain/menu.ts';
import { fmt } from '../domain/money.ts';
import { PREPS, type BookLine } from '../domain/recipeBook.ts';
import { MENU_RECIPES } from '../domain/recipeMap.ts';
import type { MenuItem, Option } from '../domain/types.ts';
import { requireOwner } from '../services/auth.ts';
import { answerQuestion, recipesViewed, useCostContext } from '../services/inventoryStore.ts';
import { Question } from './CostQuestions.tsx';
import { useMenu } from './menuStore.ts';
import { OwnerNav } from './OwnerNav.tsx';

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
 */
export const RECIPES_IDLE_MS = 60_000;
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

/** "stock:inv-0006" → "Mozzarella (Prabhat)"; his own names as they are. */
const lineName = (name: string, ctx: CostContext) =>
  name.startsWith(STOCK_LINE) ? ctx.items.find((i) => i.id === name.slice(STOCK_LINE.length))?.name ?? 'An item no longer in stock' : name;

const amountText = (l: BookLine) => `${Number(l.qty.toFixed(3)).toLocaleString('en-US')} ${l.unit}`;

const statusText = (e: Entry) => {
  if (!e.recipe) return 'No recipe yet';
  if (!e.cost.complete) return `${e.cost.missing.length} ${e.cost.missing.length === 1 ? 'thing' : 'things'} missing`;
  const margin = marginOf(e.price, e.cost.cents);
  return `Complete · costs ${fmt(e.cost.cents)}${margin === null ? '' : ` · earns ${Math.round(margin * 100)}%`}`;
};

export function RecipesView({ onRegister }: { onRegister?: () => void }) {
  const [owner, setOwner] = useState<Actor | null>(null);

  // Lock after a minute untouched, and whenever the screen goes away.
  useEffect(() => {
    if (!owner) return;
    let t = setTimeout(() => setOwner(null), RECIPES_IDLE_MS);
    const awake = () => { clearTimeout(t); t = setTimeout(() => setOwner(null), RECIPES_IDLE_MS); };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, awake, { passive: true });
    return () => { clearTimeout(t); for (const e of events) window.removeEventListener(e, awake); };
  }, [owner]);

  return (
    <div className="owner vault">
      <OwnerNav current="recipes" onRegister={onRegister} />
      {owner
        ? <Book owner={owner} onLock={() => setOwner(null)} />
        : <Lock onOpen={(actor) => { recipesViewed(actor); setOwner(actor); }} />}
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
      <svg className="vault__icon" viewBox="0 0 24 24" width="40" height="40" aria-hidden="true">
        <rect x="5" y="11" width="14" height="10" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
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

function Book({ owner, onLock }: { owner: Actor; onLock: () => void }) {
  useMenu();
  const ctx = useCostContext();
  const entries = useMemo(() => entriesOf(menuItems(), ctx), [ctx]);
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [last, setLast] = useState<{ message: string; undo: () => void } | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || editing) return;
      if (open) setOpen(null); else onLock();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, editing, onLock]);

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
        <button type="button" className="linkbtn" onClick={onLock}>Lock</button>
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
    </main>
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

interface Draft { name: string; qty: string; unit: string }

/** The cost of an entry if it were made with these lines. */
const costAs = (entry: Entry, lines: BookLine[], ctx: CostContext): Cost => {
  const answers = new Map(ctx.answers).set(entry.question, { kind: 'own', lines });
  const [kind, id, size] = entry.question.split(':');
  return kind === 'addon' ? addonCost(id, { ...ctx, answers }) : menuCost(id, size ?? '', { ...ctx, answers });
};

const unitFor = (name: string, ctx: CostContext, fallback = 'g'): string =>
  name.startsWith(STOCK_LINE)
    ? ctx.items.find((i) => i.id === name.slice(STOCK_LINE.length))?.baseUnit ?? fallback
    : recipeUnit(name) ?? fallback;

const toDraft = (lines: readonly BookLine[]): Draft[] => lines.map((l) => ({ name: l.name, qty: String(l.qty), unit: l.unit }));

function Editor({ entry, entries, ctx, onSave, onCancel }: {
  entry: Entry; entries: Entry[]; ctx: CostContext; onSave: (lines: BookLine[]) => void; onCancel: () => void;
}) {
  const [rows, setRows] = useState<Draft[]>(() => (entry.recipe ? toDraft(entry.recipe.lines) : [{ name: '', qty: '', unit: 'g' }]));
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

  // What a line can be: his batches, then his price list. Names copied from his sheet stay choosable.
  const preps = Object.keys(PREPS).sort();
  const stock = [...ctx.items].sort((a, b) => a.name.localeCompare(b.name));
  const known = new Set([...preps, ...stock.map((i) => stockLine(i.id))]);

  // What it would cost and earn as written so far (lines with a name and an amount).
  const draft: BookLine[] = rows.filter((r) => r.name && Number(r.qty) > 0).map((r) => ({ name: r.name, qty: Number(r.qty), unit: r.unit }));
  const preview = draft.length ? costAs(entry, draft, ctx) : null;
  const margin = preview?.complete ? marginOf(entry.price, preview.cents) : null;

  const set = (i: number, patch: Partial<Draft>) => { setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r))); setError(''); };

  const save = (ev: FormEvent) => {
    ev.preventDefault();
    const filled = rows.filter((r) => r.name || r.qty.trim());
    const lines: BookLine[] = filled.map((r) => ({ name: r.name, qty: Number(r.qty.trim()), unit: r.unit }));
    if (filled.some((r) => !/^\d+(\.\d{1,4})?$/.test(r.qty.trim()))) return setError('Type each amount as a number, like 90 or 0.5.');
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
      <ul className="redit__rows">
        {rows.map((r, i) => (
          <li key={i} className="redit__row">
            <select
              aria-label={`Line ${i + 1}: what goes in`} value={r.name} autoFocus={i === 0 && !r.name}
              onChange={(e) => set(i, { name: e.target.value, unit: unitFor(e.target.value, ctx, r.unit) })}
            >
              <option value="">Choose…</option>
              {r.name && !known.has(r.name) && <option value={r.name}>{r.name} (your sheet)</option>}
              <optgroup label="Made in your kitchen">
                {preps.map((p) => <option key={p} value={p}>{p}</option>)}
              </optgroup>
              <optgroup label="Your stock">
                {stock.map((s) => <option key={s.id} value={stockLine(s.id)}>{s.name}</option>)}
              </optgroup>
            </select>
            <input
              className="num" inputMode="decimal" aria-label={`Line ${i + 1}: how much`} value={r.qty}
              onChange={(e) => set(i, { qty: e.target.value })}
            />
            <span className="redit__unit">{r.unit}</span>
            <button type="button" className="redit__remove" aria-label={`Remove line ${i + 1}`}
              onClick={() => setRows(rows.length > 1 ? rows.filter((_, j) => j !== i) : [{ name: '', qty: '', unit: 'g' }])}>×</button>
          </li>
        ))}
      </ul>
      <button type="button" className="linkbtn redit__add" onClick={() => setRows([...rows, { name: '', qty: '', unit: 'g' }])}>Add a line</button>
      {preview && (
        <p className="redit__cost num" aria-live="polite">
          {preview.complete
            ? `Costs ${fmt(preview.cents)}${margin === null ? '' : ` · earns ${Math.round(margin * 100)}% of ${fmt(entry.price)}`}`
            : `Costs ${fmt(preview.cents)} so far · ${preview.missing.length} ${preview.missing.length === 1 ? 'thing' : 'things'} still missing`}
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
