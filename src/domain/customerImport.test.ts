import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAKE_CUSTOMER_SHEET } from '../fake/data.ts';
import { cleanName, MAX_IMPORT_ROWS, MAX_NAME_LENGTH, planImport, type Cell, type ImportPlan, type KnownCustomer, type RowPlan } from './customerImport.ts';

/** The shop's list before the import: one same name, one without a name, one named differently. */
const LIST = new Map<string, KnownCustomer>([
  ['+94770000003', { id: 'cus-0000000000000003', name: 'Chamara Silva' }],
  ['+94770000004', { id: 'cus-0000000000000004', name: null }],
  ['+94770000005', { id: 'cus-0000000000000005', name: 'Ruwan W' }],
]);

const at = (plan: ImportPlan, row: number): RowPlan => {
  const r = plan.rows.find((p) => p.row === row);
  assert.ok(r, `row ${row} is in the plan`);
  return r;
};

/** What saving a plan does to the list (the server does the same in one transaction). */
const saved = (list: ReadonlyMap<string, KnownCustomer>, plan: ImportPlan): Map<string, KnownCustomer> => {
  const next = new Map(list);
  for (const r of plan.rows) {
    if (r.kind === 'add') next.set(r.phone, { id: `cus-new-${r.row}`, name: r.name });
    if (r.kind === 'fill_name' || r.kind === 'rename') next.set(r.phone, { id: r.id, name: r.name });
  }
  return next;
};

test('the messy fake list: every row gets the outcome its comment says', () => {
  const plan = planImport(FAKE_CUSTOMER_SHEET, LIST);
  assert.equal(plan.error, null);
  assert.deepEqual(plan.columns, { phone: 1, name: 0 });
  assert.equal(plan.headerRow, 1);
  assert.deepEqual(plan.report, {
    rows: 44, blank: 2, added: 33, updated: 1, unchanged: 2, duplicates: 2, invalid: 6, noName: 2, nameConflicts: 1,
  });
  assert.deepEqual(plan.warnings, []);

  assert.deepEqual(at(plan, 2), { row: 2, kind: 'add', phone: '+94770000001', name: 'Kasun Perera', notes: [] });
  assert.equal((at(plan, 3) as { phone: string }).phone, '+94770000002');
  assert.equal(at(plan, 4).kind, 'unchanged');
  assert.deepEqual(at(plan, 5), { row: 5, kind: 'fill_name', phone: '+94770000004', name: 'Dilani Jayasinghe', id: 'cus-0000000000000004', notes: [] });
  assert.deepEqual(at(plan, 6), {
    row: 6, kind: 'unchanged', phone: '+94770000005', id: 'cus-0000000000000005', keptName: 'Ruwan W', fileName: 'Ruwan Wickramasinghe', notes: [],
  });
  assert.equal((at(plan, 7) as { phone: string }).phone, '+94770000006');
  assert.deepEqual(at(plan, 16), { row: 16, kind: 'add', phone: '+94770000015', name: null, notes: [] });
  assert.deepEqual(at(plan, 17), { row: 17, kind: 'add', phone: '+94770000016', name: null, notes: [] });
  assert.deepEqual(at(plan, 18), { row: 18, kind: 'duplicate', phone: '+94770000001', sameAs: 2 });
  assert.deepEqual(at(plan, 19), { row: 19, kind: 'duplicate', phone: '+94770000002', sameAs: 3 });
  assert.equal((at(plan, 3) as { name: string }).name, 'Nimali Fernando', 'the first row\'s name stays');

  const reasons = plan.rows.filter((r) => r.kind === 'invalid').map((r) => [r.row, r.kind === 'invalid' && r.reason]);
  assert.deepEqual(reasons.map(([row]) => row), [21, 22, 23, 24, 25, 26]);
  assert.match(String(reasons[0][1]), /landline/);
  assert.match(String(reasons[3][1]), /format the column as Text/);

  assert.deepEqual(at(plan, 28), { row: 28, kind: 'add', phone: '+94770000027', name: 'Dinesh Rajapaksha', notes: ['also in the cell, not imported: +94710000027'] });
  assert.equal((at(plan, 29) as { name: string }).name, 'Malsha de Silva');
  assert.ok(!plan.rows.some((r) => r.row === 20 || r.row === 27), 'blank rows are counted, not listed');
});

test('Sinhala and Tamil names come through exactly, joiners inside the word kept', () => {
  const plan = planImport(FAKE_CUSTOMER_SHEET, LIST);
  const name = (row: number) => (at(plan, row) as { name: string }).name;
  assert.equal(name(10), 'නිමල් පෙරේරා');
  assert.equal(name(11), 'කසුන් ප්‍රනාන්දු');
  assert.equal(name(12), 'சுரேஷ் குமார்');
  assert.equal(name(13), 'பிரியா செல்வம்');
  assert.equal(name(45), 'කමල් සිල්වා');
  assert.equal(name(46), 'லக்ஷ்மி ராஜா');
});

test('importing the same file again adds nobody', () => {
  const once = saved(LIST, planImport(FAKE_CUSTOMER_SHEET, LIST));
  assert.equal(once.size, 36);
  const again = planImport(FAKE_CUSTOMER_SHEET, once);
  assert.equal(again.report.added, 0);
  assert.equal(again.report.updated, 0);
  assert.equal(again.report.unchanged, 36);
  assert.equal(again.report.duplicates, 2);
  assert.equal(again.report.invalid, 6);
  assert.equal(saved(once, again).size, 36);
});

test('renaming is the owner\'s choice: off keeps the list\'s name, on replaces it', () => {
  const plan = planImport(FAKE_CUSTOMER_SHEET, LIST, { renameExisting: true });
  assert.deepEqual(at(plan, 6), {
    row: 6, kind: 'rename', phone: '+94770000005', name: 'Ruwan Wickramasinghe', before: 'Ruwan W', id: 'cus-0000000000000005', notes: [],
  });
  assert.equal(plan.report.updated, 2);
  assert.equal(plan.report.nameConflicts, 0);
  // The same name in other capitals is the same name.
  const caps = planImport([['Name', 'Mobile'], ['CHAMARA SILVA', '0770000003']], LIST, { renameExisting: true });
  assert.equal(caps.rows[0].kind, 'unchanged');
});

test('no header: the columns are found by what is in them, whatever language the header is in', () => {
  const noHeader = FAKE_CUSTOMER_SHEET.slice(1).map(([name, phone]) => [phone, name]);
  const plan = planImport(noHeader, LIST);
  assert.deepEqual(plan.columns, { phone: 0, name: 1 });
  assert.equal(plan.headerRow, null);
  assert.equal(plan.report.added, 33);

  const sinhalaHeader: Cell[][] = [['අංකය', 'නම', 'සටහන'], ['0770000001', 'Kasun', 'pizza'], ['0770000002', 'Nimali', 'burger'], ['0770000003', 'Chamara', '']];
  const p2 = planImport(sinhalaHeader, new Map());
  assert.equal(p2.headerRow, 1);
  assert.deepEqual(p2.columns, { phone: 0, name: 1 });
  assert.equal(p2.report.added, 3);
});

test('extra columns, leading blank rows and a phone-only file', () => {
  const sheet: Cell[][] = [[null], [], ['No.', 'Customer Name', 'Town', 'Phone No'], [1, 'Kasun', 'Thalwila', '0770000001'], [2, 'Nimali', 'Colombo', '0770000002']];
  const plan = planImport(sheet, new Map());
  assert.deepEqual(plan.columns, { phone: 3, name: 1 });
  assert.equal(plan.headerRow, 3);
  assert.equal(plan.report.blank, 2);
  assert.deepEqual(plan.rows.map((r) => r.kind === 'add' && r.name), ['Kasun', 'Nimali']);

  const phones = planImport([['0770000001'], ['0770000002']], new Map());
  assert.deepEqual(phones.columns, { phone: 0, name: null });
  assert.equal(phones.report.noName, 2);
});

test('a whole file that cannot be imported says why', () => {
  assert.equal(planImport([], new Map()).error, 'no column of phone numbers was found');
  assert.equal(planImport([['Name'], ['Kasun'], ['Nimali']], new Map()).error, 'no column of phone numbers was found');
  const big: Cell[][] = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => [`Name ${i}`, `077${String(i).padStart(7, '0')}`]);
  assert.match(String(planImport(big, new Map()).error), /more than 5000/);
});

test('a file saved in the wrong encoding is pointed out once', () => {
  const plan = planImport([['Name', 'Mobile'], ['????? ??????', '0770000001'], ['K�sun', '0770000002']], new Map());
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /CSV UTF-8/);
});

test('names: invisible marks and extra spaces go, placeholders are no name, long ones are cut between letters', () => {
  assert.deepEqual(cleanName('﻿ Kasun​  Perera\t'), { name: 'Kasun Perera', cut: false });
  for (const none of ['', '-', '---', 'N/A', 'n/a', 'none', '0', 12345, null, undefined, true]) {
    assert.equal(cleanName(none as Cell).name, null, JSON.stringify(none));
  }
  // Decomposed letters are stored composed, so the same name always compares equal.
  assert.equal(cleanName('José').name, 'José');
  const long = cleanName('ප්‍ර'.repeat(MAX_NAME_LENGTH + 5));
  assert.equal(long.cut, true);
  assert.ok('ප්‍ර'.repeat(MAX_NAME_LENGTH + 5).startsWith(long.name!), 'the start of the name');
  assert.ok(!/[්‍]$/.test(long.name!), 'cut after a whole letter, never on a half-made one');
  assert.equal([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(long.name!)].length, MAX_NAME_LENGTH);
  const plan = planImport([['Name', 'Mobile'], ['A'.repeat(100), '0770000001']], new Map());
  assert.deepEqual((plan.rows[0] as { notes: string[] }).notes, [`name cut to ${MAX_NAME_LENGTH} letters`]);
});
