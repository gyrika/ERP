import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { adjustStock } from '../services/inventoryStore.ts';
import { readAll } from './eventLog.ts';
import { WarehousesView } from './WarehousesView.tsx';

// SCRUM-184: Items › Warehouses, every raw and semi-processed item where it is kept.

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const section = (name: string) => within(screen.getByRole('region', { name }));

test('every item is listed in its home; stock shows where it is, with its value', () => {
  adjustStock('inv-0001', 2); // two 25 kg bags of Pizza Flour, recorded before warehouses: Warehouse 1
  render(<WarehousesView />);
  const one = section('Warehouse 1');
  expect(one.getByText('Next to the kitchen')).toBeTruthy();
  expect(one.getByRole('button', { name: 'Pizza Flour: 50 kg, kept here' })).toBeTruthy();
  expect(one.getByText('Rs 12,800')).toBeTruthy();
  expect(section('Warehouse 2').getByText(/Nothing kept here yet/)).toBeTruthy();
});

test('an item\'s home is one tap with Undo, and a move carries stock to another warehouse', async () => {
  const user = userEvent.setup();
  adjustStock('inv-0001', 2);
  render(<WarehousesView />);
  await user.click(section('Warehouse 1').getByRole('button', { name: /^Pizza Flour:/ }));
  const sheet = within(screen.getByRole('dialog', { name: 'Pizza Flour' }));
  await user.click(within(sheet.getByRole('group', { name: 'Home warehouse' })).getByRole('button', { name: 'Warehouse 3' }));
  expect(readAll().at(-1)).toMatchObject({ type: 'stock.home_set', stockKey: 'stock:inv-0001', before: null, after: 'wh-3' });

  await user.click(within(sheet.getByRole('group', { name: 'To' })).getByRole('button', { name: 'To Warehouse 2' }));
  await user.type(sheet.getByRole('textbox', { name: 'How much, in kg' }), '5');
  await user.click(sheet.getByRole('button', { name: 'Move' }));
  expect(readAll().at(-1)).toMatchObject({ type: 'stock.moved', stockKey: 'stock:inv-0001', from: 'wh-1', to: 'wh-2', qty: 5000 });
  expect(screen.getByRole('status').textContent).toMatch(/Pizza Flour: 5 kg moved from Warehouse 1 to Warehouse 2/);
  expect(section('Warehouse 2').getByRole('button', { name: /^Pizza Flour: 5 kg/ })).toBeTruthy();
  expect(section('Warehouse 1').getByRole('button', { name: /^Pizza Flour: 45 kg/ })).toBeTruthy();

  await user.click(within(screen.getByRole('status')).getByRole('button', { name: 'Undo' }));
  expect(readAll().at(-1)).toMatchObject({ type: 'stock.move_undone' });
  expect(section('Warehouse 1').getByRole('button', { name: /^Pizza Flour: 50 kg/ })).toBeTruthy();
});

test('only the owner, with his PIN, adds and renames warehouses; one Save, one Undo', async () => {
  const user = userEvent.setup();
  render(<WarehousesView />);
  await user.click(screen.getByRole('button', { name: 'Edit warehouses' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Warehouses' }));
  await user.type(sheet.getByLabelText('Owner PIN'), '2580'); // the manager's: refused
  expect(sheet.getByRole('alert').textContent).toBe('Only the owner changes the warehouses.');
  await user.type(sheet.getByLabelText('Owner PIN'), '9999');
  const name = sheet.getByRole('textbox', { name: 'Name of Warehouse 2' });
  await user.clear(name);
  await user.type(name, 'Cold room');
  await user.click(sheet.getByRole('button', { name: '+ Add warehouse' }));
  await user.clear(sheet.getByRole('textbox', { name: 'New warehouse name' }));
  await user.type(sheet.getByRole('textbox', { name: 'New warehouse name' }), 'Freezer');
  await user.click(sheet.getByRole('button', { name: 'Save warehouses' }));
  const sets = readAll().filter((e) => e.type === 'stock.warehouse_set');
  expect(sets.map((e) => e.type === 'stock.warehouse_set' && [e.before?.name ?? null, e.after.name])).toEqual([[null, 'Freezer'], ['Warehouse 2', 'Cold room']]);
  expect(sets.every((e) => e.actor.role === 'owner')).toBe(true);
  expect(screen.getByRole('region', { name: 'Cold room' })).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Freezer' })).toBeTruthy();

  await user.click(within(screen.getByRole('status')).getByRole('button', { name: 'Undo' }));
  expect(screen.getByRole('region', { name: 'Warehouse 2' })).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Freezer' })).toBeNull(); // archived, holding nothing
});

test('the warehouse next to the kitchen cannot be archived', async () => {
  const user = userEvent.setup();
  render(<WarehousesView />);
  await user.click(screen.getByRole('button', { name: 'Edit warehouses' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Warehouses' }));
  await user.type(sheet.getByLabelText('Owner PIN'), '9999');
  await user.click(sheet.getAllByRole('button', { name: 'Archive' })[0]);
  await user.click(sheet.getByRole('button', { name: 'Save warehouses' }));
  expect(sheet.getByRole('alert').textContent).toMatch(/next to the kitchen cannot be archived/);
  expect(readAll()).toHaveLength(0);
});
