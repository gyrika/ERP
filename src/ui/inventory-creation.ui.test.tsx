import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readItems } from '../services/inventoryStore.ts';
import { readAll } from './eventLog.ts';
import { InventoryView } from './InventoryView.tsx';
import { SupplierView } from './SupplierView.tsx';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

test('inventory items render as compact name, status, and supplier rows', () => {
  render(<InventoryView onFindSupplier={() => {}} />);

  const list = screen.getByRole('main', { name: 'Inventory' });
  const firstRow = list.querySelector('.inv-row')!;
  expect(firstRow.querySelector('.inv-row__name')?.textContent).toBe('Pizza Flour');
  expect(firstRow.querySelector('.dot')).toBeTruthy();
  expect(within(firstRow).getByRole('button', { name: 'Find Supplier' })).toBeTruthy();
});

test('new ingredient requires suppliers and saves as a stock event', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);

  await user.click(screen.getByRole('button', { name: '+ Add Ingredient' }));
  expect(screen.getByRole('button', { name: 'Save Ingredient' }).hasAttribute('disabled')).toBe(true);
  await user.type(screen.getByRole('textbox', { name: 'Ingredient name' }), 'Sea Salt');
  await user.click(screen.getByRole('searchbox', { name: 'Suppliers' }));
  await user.click(screen.getByRole('button', { name: '+ Prima / David Stores (Wholesale)' }));
  await user.click(screen.getByRole('button', { name: 'Save Ingredient' }));

  expect(await screen.findByRole('heading', { name: 'Sea Salt' })).toBeTruthy();
  expect(readAll().some((event) => event.type === 'stock.item_added' && event.item.name === 'Sea Salt')).toBe(true);
  expect(readItems().find((item) => item.name === 'Sea Salt')?.supplierIds).toEqual(['sup_prima']);
}, 15_000);

test('new supplier links selected ingredients independently and persists the creation event', async () => {
  const user = userEvent.setup();
  render(<SupplierView />);

  await user.click(screen.getByRole('button', { name: '+ Add Supplier' }));
  await user.type(screen.getByRole('textbox', { name: 'Supplier name' }), 'Fresh Farms');
  await user.type(screen.getByRole('textbox', { name: 'Phone Optional' }), '+94770000000');
  await user.click(screen.getByRole('searchbox', { name: 'Ingredients' }));
  await user.click(screen.getByRole('button', { name: '+ Pizza Flour' }));
  await user.click(screen.getByRole('button', { name: 'Save Supplier' }));

  const supplierToggle = await screen.findByRole('button', { name: /Fresh Farms/ });
  await user.click(supplierToggle);
  expect(screen.getByText('Pizza Flour')).toBeTruthy();
  const supplierEvent = readAll().find((event) =>
    event.type === 'stock.supplier_added' && event.supplier.name === 'Fresh Farms' &&
    event.linkedItemIds.includes('inv-0001'));
  expect(supplierEvent?.type).toBe('stock.supplier_added');
  const flour = readItems().find((item) => item.id === 'inv-0001')!;
  expect(flour.supplierIds).toContain('sup_prima');
  expect(flour.supplierIds).toContain(supplierEvent?.type === 'stock.supplier_added' ? supplierEvent.supplier.id : '');
  expect(flour.supplierIds).toHaveLength(3);
}, 15_000);
