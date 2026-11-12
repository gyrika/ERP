import type { Cell } from '../../src/domain/customerImport.ts';

/**
 * The owner's customer file, as rows of cells (CRM import; customerImport.ts plans what to do with
 * them). .xlsx through exceljs (loaded only when a file arrives, so the server starts as fast as
 * before), .csv and .txt by hand: comma, semicolon or tab, quotes as Excel writes them, UTF-8 (with
 * or without its mark) or UTF-16 (Excel's "Unicode Text"). A file saved in another encoding still
 * reads; its Sinhala and Tamil show as ? or �, and the plan says so.
 */
export type SheetRead = { rows: Cell[][] } | { reason: string };

const XLSX_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK: a zip, which an .xlsx is
const XLS_MAGIC = [0xd0, 0xcf, 0x11, 0xe0]; // the old binary Excel
const starts = (b: Buffer, m: number[]) => m.every((x, i) => b[i] === x);

const extension = (name: string) => /\.([a-z0-9]{1,5})$/i.exec(name.trim())?.[1].toLowerCase() ?? '';

/** Text from a .csv or .txt, whatever Excel saved it as. */
const decode = (b: Buffer): string => {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  const text = new TextDecoder('utf-8').decode(b); // not fatal: bytes that are not UTF-8 become �, which the plan points out
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
};

/** The separator the first lines use most: comma, semicolon (Excel in some languages) or tab. */
const separatorOf = (text: string): string => {
  const head = text.split(/\r?\n/).slice(0, 5).join('\n');
  const count = (c: string) => head.split(c).length - 1;
  return [',', ';', '\t'].reduce((best, c) => (count(c) > count(best) ? c : best), ',');
};

/** RFC 4180 as Excel writes it: "quoted, with ""doubled"" quotes and line breaks inside". */
export const parseDelimited = (text: string, sep = separatorOf(text)): Cell[][] => {
  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
};

/** One exceljs cell value as plain text, a number, or nothing. */
const plain = (v: unknown): Cell => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v instanceof Date) return v;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text?: unknown }[]).map((r) => String(r.text ?? '')).join('');
    if ('result' in o) return plain(o.result); // a formula: what it shows
    if (typeof o.text === 'string') return o.text; // a link
    if ('error' in o) return null;
  }
  return null;
};

const readXlsx = async (bytes: Buffer): Promise<SheetRead> => {
  const { default: ExcelJS } = await import('exceljs');
  const book = new ExcelJS.Workbook();
  try { await book.xlsx.load(bytes as unknown as ArrayBuffer); } catch { return { reason: 'the file could not be opened as an Excel file' }; }
  // The first sheet with anything on it (a list often sits behind an empty "Sheet1").
  const sheet = book.worksheets.find((w) => w.actualRowCount > 0);
  if (!sheet) return { reason: 'the file has no rows' };
  const rows: Cell[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row, n) => {
    const values = Array.isArray(row.values) ? row.values.slice(1) : []; // exceljs counts columns from 1
    rows[n - 1] = values.map(plain);
  });
  for (let i = 0; i < rows.length; i++) rows[i] ??= []; // rows Excel never wrote are blank rows
  return { rows };
};

/** What is in the file, or why it cannot be read. `name`: the file's own name, for its kind. */
export const readSheet = async (name: string, bytes: Buffer): Promise<SheetRead> => {
  if (!bytes.length) return { reason: 'the file is empty' };
  const ext = extension(name);
  if (ext === 'xls' || starts(bytes, XLS_MAGIC)) return { reason: 'an old Excel file (.xls): open it in Excel and Save As .xlsx' };
  if (ext === 'xlsx' || starts(bytes, XLSX_MAGIC)) {
    if (!starts(bytes, XLSX_MAGIC)) return { reason: 'the file says .xlsx but is not an Excel file' };
    return readXlsx(bytes);
  }
  if (ext === 'csv' || ext === 'txt' || ext === 'tsv') return { rows: parseDelimited(decode(bytes)) };
  return { reason: 'pick an Excel (.xlsx) or CSV (.csv) file' };
};
