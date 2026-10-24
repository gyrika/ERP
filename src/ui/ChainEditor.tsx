import { useEffect, useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import { linesCost, stockLine, type Answer, type CostContext } from '../domain/costing.ts';
import { fmt } from '../domain/money.ts';
import type { BookLine } from '../domain/recipeBook.ts';
import { batchShare, madeFrom, madeFromAll, MAX_PER_BATCH, perBatch, prepKey, shareLine, type PrepItem } from '../domain/prep.ts';
import { NumberInput } from './NumberInput.tsx';
import { unitFor } from './RecipeLines.tsx';
import { lineName } from './RecipesView.tsx';

/**
 * A semi-processed item's ingredient flow, edited where it is read (SCRUM-146): the chain it
 * sits in (made from › this › made from it), a share of a batch as "one batch makes 12",
 * amounts typed in place, lines taken out with ×, and one search to add a line. Every change
 * is saved at once by the sheet, with Undo; nothing that would put the item inside itself
 * is offered.
 */

/** The semi-processed items some lines are made from, as keys, each once. */
const semiKeys = (lines: readonly BookLine[], answers: ReadonlyMap<string, Answer>): string[] =>
  [...new Set(lines.map((l) => prepKey(l.name, answers)).filter((k): k is string => k !== null))];

/**
 * Made from › this › made from it: each step opens its sheet. Up the chain while each step is
 * made from one item; nothing when the item stands alone (most of them).
 */
export function Chain({ item, items, answers, onOpen }: {
  item: PrepItem; items: readonly PrepItem[]; answers: ReadonlyMap<string, Answer>; onOpen: (key: string) => void;
}) {
  const up: PrepItem[][] = [];
  const seen = new Set([item.key]);
  let at: PrepItem | undefined = item;
  while (at && up.length < 4) {
    const parents: PrepItem[] = semiKeys(at.lines, answers).filter((k) => !seen.has(k))
      .map((k) => items.find((p) => p.key === k)).filter((p): p is PrepItem => p !== undefined);
    if (parents.length === 0) break;
    up.unshift(parents);
    for (const p of parents) seen.add(p.key);
    at = parents.length === 1 ? parents[0] : undefined;
  }
  const down = madeFrom(item.key, items, answers);
  if (up.length === 0 && down.length === 0) return null;
  const levels = [...up, [item], ...(down.length ? [down] : [])];
  return (
    <nav className="chain" aria-label="How it is made">
      <ol className="chain__levels">
        {levels.map((level, i) => (
          <li key={i} className="chain__level">
            {level.map((p) => (p.key === item.key
              ? <span key={p.key} className="chain__step chain__step--here" aria-current="page">{p.name}</span>
              : <button key={p.key} type="button" className="chain__step" onClick={() => onOpen(p.key)}>{p.name}</button>))}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** Enter saves what was typed; Escape puts it back (and keeps the sheet open). */
const keys = (save: () => void, reset: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
  if (e.key === 'Enter') { e.preventDefault(); save(); }
  if (e.key === 'Escape') { e.stopPropagation(); reset(); e.currentTarget.blur(); }
};

/**
 * What goes in, for the owner to change in place. `onSave` saves the item with these lines
 * and says what changed (for the notice with Undo); it returns why it could not, or null.
 */
export function LinesInPlace({ item, items, ctx, onOpen, onSave }: {
  item: PrepItem; items: readonly PrepItem[]; ctx: CostContext;
  onOpen: (key: string) => void;
  onSave: (lines: BookLine[], what: string) => string | null;
}) {
  const [error, setError] = useState('');
  const save = (lines: BookLine[], what: string) => {
    const wrong = onSave(lines, what);
    setError(wrong ?? '');
    return wrong === null;
  };
  const lines = item.lines;
  const swap = (i: number, line: BookLine) => lines.map((l, j) => (j === i ? line : l));

  return (
    <div className="chain-lines">
      {lines.map((l, i) => {
        const n = perBatch(l, ctx.answers);
        const from = lineName(l.name, ctx);
        return n === null ? null : (
          <PerBatch key={`${i}:${l.name}`} from={from} what={item.name} n={n}
            onSet={(m) => save(swap(i, shareLine(l, m)), `one batch of ${from} makes ${m}`)} />
        );
      })}
      <ul className="chain-lines__list" aria-label="What goes in">
        {lines.map((l, i) => (
          <Line key={`${i}:${l.name}`} line={l} ctx={ctx} canRemove={lines.length > 1} onOpen={onOpen}
            onQty={(qty) => save(swap(i, { ...l, qty }), `${lineName(l.name, ctx)} ${qty} ${l.unit}`)}
            onRemove={() => save(lines.filter((_, j) => j !== i), `${lineName(l.name, ctx)} taken out`)} />
        ))}
      </ul>
      <AddLine item={item} items={items} ctx={ctx}
        onAdd={(line, label) => save([...lines, line], `${label} added`)} />
      {error && <p className="inv-modal__error" role="alert">{error}</p>}
    </div>
  );
}

/** "One batch of Pizza Dough Batch makes [12] 12inch Dough Ball", with − and +. */
function PerBatch({ from, what, n, onSet }: { from: string; what: string; n: number; onSet: (n: number) => boolean }) {
  const id = useId();
  const [typed, setTyped] = useState(String(n));
  useEffect(() => setTyped(String(n)), [n]); // saved, or undone
  const set = (m: number) => {
    if (Number.isInteger(m) && m >= 1 && m <= MAX_PER_BATCH && m !== n && onSet(m)) return;
    setTyped(String(n));
  };
  return (
    <div className="per-batch">
      <label className="per-batch__label" htmlFor={id}>One batch of {from} makes</label>
      <div className="per-batch__row">
        <button type="button" className="per-batch__step" aria-label="One fewer" disabled={n <= 1} onClick={() => set(n - 1)}>−</button>
        <NumberInput id={id} className="per-batch__input" decimals={0} value={typed} onText={setTyped}
          onBlur={() => set(Number(typed))} onKeyDown={keys(() => set(Number(typed)), () => setTyped(String(n)))} />
        <button type="button" className="per-batch__step" aria-label="One more" disabled={n >= MAX_PER_BATCH} onClick={() => set(n + 1)}>+</button>
        <span className="per-batch__what">{what}</span>
      </div>
    </div>
  );
}

/** One line: its name (a kitchen item opens), its amount to type over, its cost, and ×. */
function Line({ line, ctx, canRemove, onOpen, onQty, onRemove }: {
  line: BookLine; ctx: CostContext; canRemove: boolean;
  onOpen: (key: string) => void; onQty: (qty: number) => boolean; onRemove: () => void;
}) {
  const key = prepKey(line.name, ctx.answers);
  const share = batchShare(line, ctx.answers);
  const name = lineName(line.name, ctx);
  const cost = linesCost([line], ctx);
  const [typed, setTyped] = useState(String(line.qty));
  useEffect(() => setTyped(String(line.qty)), [line.qty]);
  const commit = () => {
    const qty = Number(typed);
    if (qty > 0 && qty !== line.qty && onQty(qty)) return;
    setTyped(String(line.qty));
  };
  return (
    <li className="chain-line">
      {key
        ? <button type="button" className="linkbtn chain-line__name" aria-label={`Open ${name}`} onClick={() => onOpen(key)}>{name}</button>
        : <span className="chain-line__name">{name}</span>}
      {share
        ? <span className="num chain-line__share">{share}</span>
        : <NumberInput className="chain-line__input" aria-label={`${name}, how much`} unit={line.unit} value={typed} onText={setTyped}
            onBlur={commit} onKeyDown={keys(commit, () => setTyped(String(line.qty)))} />}
      <span className="num chain-line__cost">{cost.complete ? `Rs ${fmt(cost.cents)}` : ''}</span>
      {canRemove
        ? <button type="button" className="chain-line__remove" aria-label={`Take ${name} out`} onClick={onRemove}>×</button>
        : <span className="chain-line__remove" aria-hidden="true" />}
    </li>
  );
}

interface Pick { name: string; label: string; kind: string }

/** "+ Add an ingredient": one search over what his kitchen makes and his stock, then how much. */
function AddLine({ item, items, ctx, onAdd }: {
  item: PrepItem; items: readonly PrepItem[]; ctx: CostContext; onAdd: (line: BookLine, label: string) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Pick | null>(null);
  const [qty, setQty] = useState('');
  const close = () => { setOpen(false); setQuery(''); setPicked(null); setQty(''); };

  if (!open) return <button type="button" className="chain-add" onClick={() => setOpen(true)}>+ Add an ingredient</button>;

  if (picked) {
    const unit = unitFor(picked.name, ctx);
    const submit = (e: FormEvent) => {
      e.preventDefault();
      const n = Number(qty);
      if (n > 0 && onAdd({ name: picked.name, qty: n, unit }, picked.label)) close();
    };
    return (
      <form className="chain-add__how" onSubmit={submit} aria-label={`Add ${picked.label}`}>
        <span className="chain-line__name">{picked.label}</span>
        <NumberInput className="chain-line__input" aria-label={`${picked.label}, how much`} unit={unit} value={qty} onText={setQty} autoFocus
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }} />
        <button type="submit" className="chain-add__go" disabled={!(Number(qty) > 0)}>Add</button>
        <button type="button" className="linkbtn" onClick={close}>Cancel</button>
      </form>
    );
  }

  const inside = madeFromAll(item.key, items, ctx.answers);
  const present = new Set(item.lines.map((l) => prepKey(l.name, ctx.answers) ?? l.name));
  const q = query.trim().toLowerCase();
  const matches = (label: string) => !q || label.toLowerCase().includes(q);
  const kitchen: Pick[] = items
    .filter((p) => p.key !== item.key && !inside.has(p.key) && !present.has(p.key) && matches(p.name))
    .map((p) => ({ name: p.key, label: p.name, kind: 'Made in your kitchen' }));
  const stock: Pick[] = q ? ctx.items
    .filter((i) => !present.has(stockLine(i.id)) && matches(i.name))
    .map((i) => ({ name: stockLine(i.id), label: i.name, kind: 'Your stock' })) : [];
  const results = [...kitchen, ...stock].slice(0, 8);
  const hidden = items.filter((p) => inside.has(p.key) && matches(p.name)).map((p) => p.name);

  return (
    <div className="chain-add__search">
      <label className="sr-only" htmlFor="chain-add-find">Add an ingredient</label>
      <input id="chain-add-find" className="inv-modal__input" type="search" autoFocus autoComplete="off" spellCheck={false}
        placeholder="Search flour, sauce, dough…" value={query} onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.stopPropagation(); close(); }
          if (e.key === 'Enter' && results[0]) { e.preventDefault(); setPicked(results[0]); }
        }} />
      <ul className="chain-add__results" aria-label="Choose what goes in">
        {results.map((r) => (
          <li key={r.name}>
            <button type="button" className="chain-add__result" onClick={() => setPicked(r)}>
              <span>{r.label}</span><span className="chain-add__kind">{r.kind}</span>
            </button>
          </li>
        ))}
        {results.length === 0 && <li className="chain-add__none">{q ? `Nothing matches “${query.trim()}”.` : 'Type to search your stock.'}</li>}
      </ul>
      {hidden.length > 0 && (
        <p className="chain-add__note">{hidden.slice(0, 3).join(', ')}{hidden.length > 3 ? ` and ${hidden.length - 3} more` : ''} {hidden.length === 1 ? 'is' : 'are'} not shown: made from {item.name}.</p>
      )}
      <button type="button" className="linkbtn" onClick={close}>Cancel</button>
    </div>
  );
}
