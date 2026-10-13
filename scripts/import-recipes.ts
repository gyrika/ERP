/**
 * Copies the owner's recipes from his "Cheesy Beez System V1" workbook into
 * src/domain/recipeBook.ts (SCRUM-77). Run again whenever he updates the sheet:
 *
 *   node --experimental-strip-types scripts/import-recipes.ts "excel/Cheesy Beez System V1.xlsx"
 *
 * Copied as written: product and component names, quantities and units. Only rows
 * he marked Active. A prep batch whose output he has not confirmed (his own note:
 * "Confirm batch output qty") is written with an unknown yield, for him to answer in
 * the app; nothing is estimated here. The workbook itself is never committed
 * (excel/ is git-ignored: it holds customers' names and phone numbers).
 */
import { writeFileSync } from 'node:fs';
import { readWorkbook, records } from './xlsx.ts';

const source = process.argv[2];
if (!source) throw new Error('usage: import-recipes.ts <path to Cheesy Beez System V1.xlsx>');
const out = new URL('../src/domain/recipeBook.ts', import.meta.url);

const book = readWorkbook(source);
const sheet = (name: string) => {
  const rows = book.get(name);
  if (!rows) throw new Error(`sheet ${name} not found`);
  return records(rows);
};

const unit = (u: string) => (u.toLowerCase() === 'ml' ? 'ml' : u);
const qty = (raw: string, where: string) => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${where}: quantity "${raw}" is not a positive number`);
  return n;
};
const UNCONFIRMED = /confirm batch output qty/i;

type Line = { name: string; qty: number; unit: string };
const products = new Map<string, Line[]>();
for (const r of sheet('Recipe_BOM')) {
  if (r.Status !== 'Active') continue;
  const lines = products.get(r.Product_Name) ?? [];
  lines.push({ name: r.Component_Name, qty: qty(r.Qty, r.BOM_ID), unit: unit(r.Unit) });
  products.set(r.Product_Name, lines);
}

const preps = new Map<string, { makes: { qty: number; unit: string } | null; lines: Line[] }>();
for (const r of sheet('Production_BOM')) {
  if (r.Status !== 'Active') continue;
  const prep = preps.get(r.Output_Item) ?? {
    makes: UNCONFIRMED.test(r.Prep_Notes) ? null : { qty: qty(r.Output_Qty, r.Production_BOM_ID), unit: unit(r.Output_Unit) },
    lines: [],
  };
  if (UNCONFIRMED.test(r.Prep_Notes)) prep.makes = null;
  prep.lines.push({ name: r.Component_Name, qty: qty(r.Component_Qty, r.Production_BOM_ID), unit: unit(r.Component_Unit) });
  preps.set(r.Output_Item, prep);
}

const line = (l: Line) => `{ name: ${JSON.stringify(l.name)}, qty: ${l.qty}, unit: ${JSON.stringify(l.unit)} }`;
const block = (lines: Line[]) => lines.map((l) => `    ${line(l)},`).join('\n');
const sorted = <T>(m: Map<string, T>) => [...m].sort(([a], [b]) => a.localeCompare(b));

writeFileSync(out, `/**
 * The owner's recipes, copied from his "Cheesy Beez System V1" workbook
 * (Recipe_BOM and Production_BOM, Active rows) by scripts/import-recipes.ts.
 * GENERATED: do not edit by hand; change the sheet and run the script again.
 * Tests lock the numbers (recipeBook.test.ts), like the menu.
 *
 * PRODUCTS: what one sold item uses. PREPS: what the kitchen makes in-house, and
 * how much one batch makes. makes: null = the owner has not confirmed the output
 * yet ("Confirm batch output qty" in his sheet): he answers it in the app.
 */
export interface BookLine { name: string; qty: number; unit: string }
export interface Prep { makes: { qty: number; unit: string } | null; lines: BookLine[] }

export const PRODUCTS: Readonly<Record<string, readonly BookLine[]>> = {
${sorted(products).map(([name, lines]) => `  ${JSON.stringify(name)}: [\n${block(lines)}\n  ],`).join('\n')}
};

export const PREPS: Readonly<Record<string, Prep>> = {
${sorted(preps).map(([name, p]) => `  ${JSON.stringify(name)}: {\n    makes: ${p.makes ? `{ qty: ${p.makes.qty}, unit: ${JSON.stringify(p.makes.unit)} }` : 'null'},\n    lines: [\n${p.lines.map((l) => `      ${line(l)},`).join('\n')}\n    ],\n  },`).join('\n')}
};
`);
console.log(`recipeBook.ts: ${products.size} products, ${preps.size} preps (${[...preps.values()].filter((p) => !p.makes).length} with unconfirmed output)`);
