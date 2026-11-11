import { toLkMobile } from './phone.ts';

/**
 * The owner's customer list from a spreadsheet (CRM import), planned before anything is saved.
 * Pure: the shop server reads the file into rows of cells and hands over the numbers it already
 * knows; this says, row by row, what would happen and why, and adds it up for the report. The
 * preview shows the plan; saving applies the same plan, so what was previewed is what is saved.
 *
 * One customer per mobile number. Importing the same file again adds nobody: every row is then
 * "unchanged". A name already on the list is never overwritten unless the owner asks for it.
 */

export type Cell = string | number | boolean | Date | null | undefined;

/** A customer the shop already has, by number (+947XXXXXXXX). */
export interface KnownCustomer { id: string; name: string | null }

export interface ImportOptions {
  /** Replace a name already on the list with the file's, when they differ. Off: the list's name stays. */
  renameExisting?: boolean;
}

/** Spreadsheet rows count from 1, as Excel shows them. */
export type RowPlan =
  | { row: number; kind: 'add'; phone: string; name: string | null; notes: string[] }
  | { row: number; kind: 'fill_name'; phone: string; name: string; id: string; notes: string[] }
  | { row: number; kind: 'rename'; phone: string; name: string; before: string; id: string; notes: string[] }
  | { row: number; kind: 'unchanged'; phone: string; id: string; keptName: string | null; fileName: string | null; notes: string[] }
  | { row: number; kind: 'duplicate'; phone: string; sameAs: number }
  | { row: number; kind: 'invalid'; reason: string; raw: string };

export interface ImportReport {
  /** Rows with something in them (the header and blank rows not counted). */
  rows: number;
  blank: number;
  added: number;
  /** A name filled in or replaced. */
  updated: number;
  unchanged: number;
  /** The same number again further down the file. */
  duplicates: number;
  invalid: number;
  /** Added without a name. */
  noName: number;
  /** The file and the list name the same number differently; the list's name was kept. */
  nameConflicts: number;
}

export interface ImportPlan {
  /** Why the whole file cannot be imported (nothing else is then filled in). */
  error: string | null;
  /** Which columns were read (0-based), and which row was the header, if any. */
  columns: { phone: number; name: number | null } | null;
  headerRow: number | null;
  rows: RowPlan[];
  report: ImportReport;
  /** About the whole file, said once (a file saved in the wrong encoding). */
  warnings: string[];
}

/** A shop's list fits easily; anything bigger is not a customer list. */
export const MAX_IMPORT_ROWS = 5000;
export const MAX_NAME_LENGTH = 80;

const EMPTY_REPORT: ImportReport = { rows: 0, blank: 0, added: 0, updated: 0, unchanged: 0, duplicates: 0, invalid: 0, noName: 0, nameConflicts: 0 };

const text = (c: Cell): string => {
  if (c === null || c === undefined || typeof c === 'boolean') return '';
  if (c instanceof Date) return '';
  return String(c).trim();
};
const isBlank = (row: readonly Cell[]) => row.every((c) => text(c).replace(/[\s ​﻿]/g, '') === '');

/** English column names only: a Sinhala or Tamil header is found by what is under it instead. */
const PHONE_HEADER = /^(mobile|phone|tel|telephone|contact|number|cell|whatsapp)( ?(no\.?|number|#))?$/i;
const NAME_HEADER = /^((customer|full|first) ?)?name$|^customer$/i;

/**
 * Sinhala and Tamil need the joiners (U+200C, U+200D) inside words; every other invisible mark,
 * control character and run of spaces goes.
 */
const INVISIBLE = /[\p{Cc}​‎‏‪-‮⁠-⁤﻿]/gu;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** A person's name as it should be kept, or null when there is none. Long names are cut between letters, never inside one. */
export const cleanName = (c: Cell): { name: string | null; cut: boolean } => {
  const s = text(c).normalize('NFC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  if (!/\p{L}/u.test(s)) return { name: null, cut: false }; // no letters ("-", "0", ""): no name
  if (/^(n\/?a|none|nil|null|unknown|-+)$/i.test(s)) return { name: null, cut: false };
  const graphemes = [...segmenter.segment(s)].map((g) => g.segment);
  if (graphemes.length <= MAX_NAME_LENGTH) return { name: s, cut: false };
  return { name: graphemes.slice(0, MAX_NAME_LENGTH).join('').trim(), cut: true };
};

const sameName = (a: string, b: string) => a.normalize('NFC').toLocaleLowerCase() === b.normalize('NFC').toLocaleLowerCase();

/**
 * Which column holds the numbers and which the names: an English header if there is one, else
 * the column where most cells are mobile numbers, and the column where most cells have letters.
 */
const findColumns = (rows: readonly (readonly Cell[])[]): { phone: number; name: number | null; header: boolean } | null => {
  const first = rows.find((r) => !isBlank(r));
  if (!first) return null;
  const width = Math.max(...rows.map((r) => r.length));
  const sample = rows.filter((r) => !isBlank(r)).slice(0, 200);

  let phone = first.findIndex((c) => PHONE_HEADER.test(text(c)));
  let name = first.findIndex((c, i) => i !== phone && NAME_HEADER.test(text(c)));
  if (phone < 0) {
    let best = { col: -1, good: 0, digits: 0 };
    for (let col = 0; col < width; col++) {
      let good = 0;
      let digits = 0;
      for (const r of sample) {
        if ('phone' in toLkMobile(r[col])) good++;
        if (/\d{5}/.test(text(r[col]).replace(/[\s-]/g, ''))) digits++;
      }
      if (good > best.good || (good === best.good && digits > best.digits)) best = { col, good, digits };
    }
    if (best.digits === 0 && best.good === 0) return null;
    phone = best.col;
  }
  if (name < 0) {
    let best = { col: -1, letters: 0 };
    for (let col = 0; col < width; col++) {
      if (col === phone) continue;
      const letters = sample.filter((r) => /\p{L}/u.test(text(r[col])) && !('phone' in toLkMobile(r[col]))).length;
      if (letters > best.letters) best = { col, letters };
    }
    name = best.col;
  }
  // The first row is a header when its "number" has no digits in it ("Mobile", "ජංගම දුරකථන").
  const header = !/\d/.test(text(first[phone]));
  return { phone, name: name >= 0 ? name : null, header };
};

/**
 * What importing these rows would do, given the numbers the shop already has.
 * `rows`: the first sheet as read from the file, one array of cells per spreadsheet row.
 */
export const planImport = (
  rows: readonly (readonly Cell[])[],
  known: ReadonlyMap<string, KnownCustomer>,
  options: ImportOptions = {},
): ImportPlan => {
  const fail = (error: string): ImportPlan => ({ error, columns: null, headerRow: null, rows: [], report: { ...EMPTY_REPORT }, warnings: [] });
  const cols = findColumns(rows);
  if (!cols) return fail('no column of phone numbers was found');
  const headerRow = cols.header ? rows.findIndex((r) => !isBlank(r)) + 1 : null;
  const report = { ...EMPTY_REPORT };
  const warnings = new Set<string>();

  // Pass 1: each row on its own, and the same number again in the file.
  type Kept = { row: number; phone: string; name: string | null; notes: string[] };
  const kept = new Map<string, Kept>();
  const out: (RowPlan | Kept)[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = i + 1;
    if (row === headerRow) continue;
    const cells = rows[i];
    if (isBlank(cells)) { report.blank++; continue; }
    report.rows++;
    if (report.rows > MAX_IMPORT_ROWS) return fail(`more than ${MAX_IMPORT_ROWS} customers: split the file`);
    const raw = text(cells[cols.phone]);
    const check = toLkMobile(cells[cols.phone]);
    if (!('phone' in check)) {
      report.invalid++;
      out.push({ row, kind: 'invalid', reason: check.reason, raw });
      continue;
    }
    const nameCell = cols.name === null ? null : cells[cols.name];
    const { name, cut } = cleanName(nameCell);
    if (/�|\?{2,}/.test(text(nameCell))) {
      warnings.add('Some names show as ? or �: the file was not saved as UTF-8. In Excel choose Save As › "CSV UTF-8", or import the .xlsx itself.');
    }
    const notes: string[] = [];
    if (cut) notes.push(`name cut to ${MAX_NAME_LENGTH} letters`);
    if (check.others?.length) notes.push(`also in the cell, not imported: ${check.others.join(', ')}`);
    const first = kept.get(check.phone);
    if (first) {
      report.duplicates++;
      if (!first.name && name) first.name = name; // the first row with a name gives it
      out.push({ row, kind: 'duplicate', phone: check.phone, sameAs: first.row });
      continue;
    }
    const k: Kept = { row, phone: check.phone, name, notes };
    kept.set(check.phone, k);
    out.push(k);
  }

  // Pass 2: against the list the shop already has.
  const plans = out.map((p): RowPlan => {
    if ('kind' in p) return p;
    const { row, phone, name, notes } = p;
    const have = known.get(phone);
    if (!have) {
      report.added++;
      if (!name) report.noName++;
      return { row, kind: 'add', phone, name, notes };
    }
    if (name && !have.name) { report.updated++; return { row, kind: 'fill_name', phone, name, id: have.id, notes }; }
    if (name && have.name && !sameName(name, have.name)) {
      if (options.renameExisting) { report.updated++; return { row, kind: 'rename', phone, name, before: have.name, id: have.id, notes }; }
      report.nameConflicts++;
    }
    report.unchanged++;
    return { row, kind: 'unchanged', phone, id: have.id, keptName: have.name, fileName: name, notes };
  });

  return { error: null, columns: { phone: cols.phone, name: cols.name }, headerRow, rows: plans, report, warnings: [...warnings] };
};
