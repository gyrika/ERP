import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { FAKE_CUSTOMER_SHEET } from '../../src/fake/data.ts';
import { planImport } from '../../src/domain/customerImport.ts';
import { parseDelimited, readSheet } from './importFile.ts';

/** The fake list as Excel would save it: the numbers as typed (text), the one number cell as a number. */
export const fakeXlsx = async (rows = FAKE_CUSTOMER_SHEET): Promise<Buffer> => {
  const book = new ExcelJS.Workbook();
  book.addWorksheet('Empty'); // a list often sits behind an empty first sheet
  const sheet = book.addWorksheet('Customers');
  rows.forEach((r, i) => { sheet.getRow(i + 1).values = r.map((v) => v ?? null); });
  sheet.getRow(1).commit();
  return Buffer.from(await book.xlsx.writeBuffer());
};

const csvOf = (rows: (string | number | null)[][], sep = ',') =>
  rows.map((r) => r.map((v) => {
    const s = v === null ? '' : String(v);
    return /[",;\t\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(sep)).join('\r\n');

const sameOutcome = (rows: Parameters<typeof planImport>[0]) => {
  const plan = planImport(rows, new Map());
  assert.equal(plan.error, null);
  assert.deepEqual(plan.report, { rows: 44, blank: 2, added: 36, updated: 0, unchanged: 0, duplicates: 2, invalid: 6, noName: 2, nameConflicts: 0 });
  return plan;
};

test('an .xlsx: the first sheet with rows, numbers as text and as a number cell, Sinhala and Tamil exact', async () => {
  const read = await readSheet('customers.xlsx', await fakeXlsx());
  assert.ok('rows' in read);
  const plan = sameOutcome(read.rows);
  const name = (row: number) => (plan.rows.find((r) => r.row === row) as { name: string }).name;
  assert.equal(name(11), 'කසුන් ප්‍රනාන්දු');
  assert.equal(name(46), 'லக்ஷ்மி ராஜா');
  assert.equal((plan.rows.find((r) => r.row === 7) as { phone: string }).phone, '+94770000006', 'the number cell');
});

test('formulas, links and rich text read as what the cell shows', async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('List');
  sheet.addRow(['Name', 'Mobile']);
  sheet.addRow([{ richText: [{ text: 'Kasun ' }, { font: { bold: true }, text: 'Perera' }] }, { formula: '"077"&"0000001"', result: '0770000001' }]);
  sheet.addRow([{ text: 'Nimali', hyperlink: 'mailto:n@example.com' }, '0770000002']);
  const read = await readSheet('list.xlsx', Buffer.from(await book.xlsx.writeBuffer()));
  assert.ok('rows' in read);
  assert.deepEqual(read.rows.slice(1), [['Kasun Perera', '0770000001'], ['Nimali', '0770000002']]);
});

test('CSV as Excel saves it: UTF-8 with its mark, semicolons, tabs (UTF-16 "Unicode Text"), quotes and line breaks', async () => {
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csvOf(FAKE_CUSTOMER_SHEET), 'utf8')]);
  const utf8 = await readSheet('customers.csv', bom);
  assert.ok('rows' in utf8);
  sameOutcome(utf8.rows);

  const semi = await readSheet('customers.csv', Buffer.from(csvOf(FAKE_CUSTOMER_SHEET, ';'), 'utf8'));
  assert.ok('rows' in semi);
  sameOutcome(semi.rows);

  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csvOf(FAKE_CUSTOMER_SHEET, '\t'), 'utf16le')]);
  const tabs = await readSheet('customers.txt', utf16);
  assert.ok('rows' in tabs);
  sameOutcome(tabs.rows);

  assert.deepEqual(parseDelimited('Name,Mobile\n"Perera, Kasun ""KP""","077 000 0001"\n"two\nlines",0770000002\n'), [
    ['Name', 'Mobile'], ['Perera, Kasun "KP"', '077 000 0001'], ['two\nlines', '0770000002'],
  ]);
});

test('a CSV saved in the old Windows encoding still reads, and the plan says the names were lost', async () => {
  // Excel's plain "CSV (Comma delimited)" writes ? for every Sinhala letter.
  const ansi = await readSheet('customers.csv', Buffer.from('Name,Mobile\r\n????? ??????,0770000001\r\n', 'latin1'));
  assert.ok('rows' in ansi);
  assert.match(planImport(ansi.rows, new Map()).warnings[0], /CSV UTF-8/);
  // Bytes that are not UTF-8 at all show as �: the same warning.
  const broken = await readSheet('customers.csv', Buffer.from([...Buffer.from('Name,Mobile\nK'), 0xe9, ...Buffer.from('sun,0770000001\n')]));
  assert.ok('rows' in broken);
  assert.match(planImport(broken.rows, new Map()).warnings[0], /CSV UTF-8/);
});

test('files that are not a customer list say what to do', async () => {
  const why = async (name: string, bytes: Buffer) => { const r = await readSheet(name, bytes); return 'reason' in r ? r.reason : 'read'; };
  assert.match(await why('old.xls', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3])), /Save As \.xlsx/);
  assert.match(await why('fake.xlsx', Buffer.from('Name,Mobile')), /not an Excel file/);
  assert.match(await why('broken.xlsx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 9, 9, 9, 9])), /could not be opened/);
  assert.match(await why('photo.jpg', Buffer.from([0xff, 0xd8, 0xff])), /\.xlsx\) or CSV/);
  assert.match(await why('empty.csv', Buffer.alloc(0)), /empty/);
  const book = new ExcelJS.Workbook();
  book.addWorksheet('Sheet1');
  assert.match(await why('blank.xlsx', Buffer.from(await book.xlsx.writeBuffer())), /no rows/);
});
