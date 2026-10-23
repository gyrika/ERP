import { useEffect, useState } from 'react';
import { PIN_LENGTH, type Actor } from '../domain/auth.ts';
import { linesCost, recipeUnit, sourceOf, STOCK_LINE, stockLine, type CostContext } from '../domain/costing.ts';
import type { Supplier } from '../domain/inventoryData.ts';
import { fmt } from '../domain/money.ts';
import { PREPS, type BookLine } from '../domain/recipeBook.ts';
import { requireOwner } from '../services/auth.ts';
import { recipesViewed } from '../services/inventoryStore.ts';
import { splitSupplierName } from './supplierName.ts';

/**
 * What goes in one dish, line by line: shared by the Recipes screen and adding a dish on
 * the Menu screen. Each line says quietly where it comes from (made in his kitchen, or the
 * stock item and its supplier) and what it costs, so menu → recipe → stock → supplier is
 * one picture, not four screens.
 */
export interface Draft { name: string; qty: string; unit: string }

export const EMPTY_ROW: Draft = { name: '', qty: '', unit: 'g' };

export const toDraft = (lines: readonly BookLine[]): Draft[] => lines.map((l) => ({ name: l.name, qty: String(l.qty), unit: l.unit }));

/** The lines written so far that have a name and an amount (for a live cost). */
export const draftLines = (rows: readonly Draft[]): BookLine[] =>
  rows.filter((r) => r.name && Number(r.qty) > 0).map((r) => ({ name: r.name, qty: Number(r.qty), unit: r.unit }));

/** Every row filled in properly, or what to fix. */
export const readRows = (rows: readonly Draft[]): BookLine[] | string => {
  const filled = rows.filter((r) => r.name || r.qty.trim());
  if (filled.some((r) => !/^\d+(\.\d{1,4})?$/.test(r.qty.trim()))) return 'Type each amount as a number, like 90 or 0.5.';
  return filled.map((r) => ({ name: r.name, qty: Number(r.qty.trim()), unit: r.unit }));
};

const unitFor = (name: string, ctx: CostContext, fallback = 'g'): string =>
  name.startsWith(STOCK_LINE)
    ? ctx.items.find((i) => i.id === name.slice(STOCK_LINE.length))?.baseUnit ?? fallback
    : recipeUnit(name) ?? fallback;

/** "Eastwest · Rs 58", "Made in your kitchen · Rs 112", "Not on your stock list". */
export const lineSource = (line: Draft, ctx: CostContext, suppliers: readonly Supplier[]): string => {
  if (!line.name) return '';
  const qty = Number(line.qty);
  const cost = qty > 0 ? linesCost([{ name: line.name, qty, unit: line.unit }], ctx) : null;
  const price = cost?.complete ? `Rs ${fmt(cost.cents)}` : '';
  if (PREPS[line.name]) return ['Made in your kitchen', price].filter(Boolean).join(' · ');
  const source = sourceOf(line.name, ctx.answers);
  const item = source && ctx.items.find((i) => i.id === source.inventoryId);
  if (!item) return 'Not on your stock list yet';
  const from = item.supplierIds.map((id) => suppliers.find((s) => s.id === id)?.name).find(Boolean);
  return [from ? splitSupplierName(from).title : '', price || 'no price yet'].filter(Boolean).join(' · ');
};

export function LinesEditor({ rows, onChange, ctx, suppliers }: {
  rows: Draft[]; onChange: (rows: Draft[]) => void; ctx: CostContext; suppliers: readonly Supplier[];
}) {
  // What a line can be: his batches, then his stock. Names copied from his sheet stay choosable.
  const preps = Object.keys(PREPS).sort();
  const stock = [...ctx.items].sort((a, b) => a.name.localeCompare(b.name));
  const known = new Set([...preps, ...stock.map((i) => stockLine(i.id))]);
  const set = (i: number, patch: Partial<Draft>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <>
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
              onClick={() => onChange(rows.length > 1 ? rows.filter((_, j) => j !== i) : [EMPTY_ROW])}>×</button>
            {r.name && <span className="redit__src num">{lineSource(r, ctx, suppliers)}</span>}
          </li>
        ))}
      </ul>
      <button type="button" className="linkbtn redit__add" onClick={() => onChange([...rows, EMPTY_ROW])}>Add a line</button>
    </>
  );
}

/** Recipes close after this long untouched (the Recipes screen and adding a dish). */
export const RECIPES_IDLE_MS = 60_000;

/** The owner, while he is active; null after a minute untouched, so the recipes close again. */
export function useOwnerSession(): [Actor | null, (owner: Actor | null) => void] {
  const [owner, setOwner] = useState<Actor | null>(null);
  useEffect(() => {
    if (!owner) return;
    let t = setTimeout(() => setOwner(null), RECIPES_IDLE_MS);
    const awake = () => { clearTimeout(t); t = setTimeout(() => setOwner(null), RECIPES_IDLE_MS); };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, awake, { passive: true });
    return () => { clearTimeout(t); for (const e of events) window.removeEventListener(e, awake); };
  }, [owner]);
  return [owner, setOwner];
}

/** The owner's PIN, asked every time the recipes open; each opening is audited (recipe.viewed). */
export function OwnerPin({ onOpen }: { onOpen: (owner: Actor) => void }) {
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
    if (owner) { recipesViewed(owner); onOpen(owner); return; }
    setError(true);
    setPin('');
  };

  return (
    <div className="dish__pin">
      <input
        className={`pin${error ? ' pin--error' : ''}`} type="password" inputMode="numeric" autoComplete="off"
        value={pin} readOnly={checking} autoFocus aria-label="Owner PIN" aria-invalid={error} aria-describedby="dish-pin-msg"
        onChange={(e) => void onChange(e.target.value)}
      />
      <p id="dish-pin-msg" className="dish__hint" role={error ? 'alert' : undefined}>
        {error ? 'Only the owner can open the recipes.' : 'Your recipes are the shop\'s secret: owner PIN to open them.'}
      </p>
    </div>
  );
}
