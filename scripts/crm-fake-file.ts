/**
 * The fake customer list as files, to try the Import page by hand (CRM):
 *   npm run crm:fake-file
 * writes test-assets/crm/fake-customers.xlsx and fake-customers.csv (UTF-8, as Excel's "CSV UTF-8")
 * from FAKE_CUSTOMER_SHEET in src/fake/data.ts: 46 rows with every messy case, all numbers in the
 * obviously fake 07X 000 00XX block. Expected: 36 new (2 without a name), 2 duplicates, 6 that
 * cannot be used, 2 blank rows. Importing it a second time adds nobody.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { FAKE_CUSTOMER_SHEET } from '../src/fake/data.ts';

const out = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'test-assets', 'crm');
mkdirSync(out, { recursive: true });

const book = new ExcelJS.Workbook();
const sheet = book.addWorksheet('Customers');
FAKE_CUSTOMER_SHEET.forEach((row, i) => { sheet.getRow(i + 1).values = row.map((v) => v ?? null); });
sheet.getColumn(1).width = 28;
sheet.getColumn(2).width = 24;
writeFileSync(join(out, 'fake-customers.xlsx'), Buffer.from(await book.xlsx.writeBuffer()));

const cell = (v: string | number | null) => {
  const s = v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = FAKE_CUSTOMER_SHEET.map((r) => r.map(cell).join(',')).join('\r\n');
writeFileSync(join(out, 'fake-customers.csv'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csv, 'utf8')]));

console.log(`Written: ${join('test-assets', 'crm', 'fake-customers.xlsx')} and fake-customers.csv`);
