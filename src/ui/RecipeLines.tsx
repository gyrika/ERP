import { useSyncExternalStore } from 'react';
import type { Actor } from '../domain/auth.ts';
import { kitchenLine, linesCost, ownPrepOf, ownPreps, prepOf, recipeUnit, sourceOf, STOCK_LINE, stockLine, type CostContext } from '../domain/costing.ts';
import type { Supplier } from '../domain/inventoryData.ts';
import { fmt } from '../domain/money.ts';
import { PREPS, type BookLine } from '../domain/recipeBook.ts';
import { currentOwner } from '../services/auth.ts';
import { subscribeAuth } from '../services/serverAuth.ts';
import { splitSupplierName } from './supplierName.ts';
import { NumberInput } from './NumberInput.tsx';

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
    : recipeUnit(name) ?? prepOf(name, ctx.answers)?.makes?.unit ?? fallback;

/** "Eastwest · Rs 58", "Made in your kitchen · Rs 112", "Not on your stock list". */
export const lineSource = (line: Draft, ctx: CostContext, suppliers: readonly Supplier[]): string => {
  if (!line.name) return '';
  const qty = Number(line.qty);
  const cost = qty > 0 ? linesCost([{ name: line.name, qty, unit: line.unit }], ctx) : null;
  const price = cost?.complete ? `Rs ${fmt(cost.cents)}` : '';
  if (prepOf(line.name, ctx.answers)) return ['Made in your kitchen', price].filter(Boolean).join(' · ');
  const source = sourceOf(line.name, ctx.answers);
  const item = source && ctx.items.find((i) => i.id === source.inventoryId);
  if (!item) return 'Not on your stock list yet';
  const from = item.supplierIds.map((id) => suppliers.find((s) => s.id === id)?.name).find(Boolean);
  return [from ? splitSupplierName(from).title : '', price || 'no price yet'].filter(Boolean).join(' · ');
};

export function LinesEditor({ rows, onChange, ctx, suppliers, ownPrepsToo = true }: {
  rows: Draft[]; onChange: (rows: Draft[]) => void; ctx: CostContext; suppliers: readonly Supplier[];
  /** False inside a semi-processed item of his own: it takes his stock and his sheet's batches only. */
  ownPrepsToo?: boolean;
}) {
  // What a line can be: his batches and semi-processed items, then his stock. Names copied from his sheet stay choosable.
  const preps = [
    ...Object.keys(PREPS).map((p) => ({ value: p, label: p })),
    ...(ownPrepsToo ? ownPreps(ctx.answers).map((p) => ({ value: kitchenLine(p.id), label: p.name })) : []),
  ].sort((a, b) => a.label.localeCompare(b.label));
  const stock = [...ctx.items].sort((a, b) => a.name.localeCompare(b.name));
  const known = new Set([...preps.map((p) => p.value), ...stock.map((i) => stockLine(i.id))]);
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
              {r.name && !known.has(r.name) && (
                <option value={r.name}>{ownPrepOf(r.name, ctx.answers)?.name ?? `${r.name} (your sheet)`}</option>
              )}
              <optgroup label="Made in your kitchen">
                {preps.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </optgroup>
              <optgroup label="Your stock">
                {stock.map((s) => <option key={s.id} value={stockLine(s.id)}>{s.name}</option>)}
              </optgroup>
            </select>
            <NumberInput
              aria-label={`Line ${i + 1}: how much`} value={r.qty}
              onText={(text) => set(i, { qty: text })}
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

/** The owner as signed in: the recipes are open to him, with no PIN; null for anyone else. */
export function useOwner(): Actor | null {
  return useSyncExternalStore(subscribeAuth, currentOwner);
}
