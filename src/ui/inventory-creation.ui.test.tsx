import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readItems, readSuppliers } from '../services/inventoryStore.ts';
import { readAll } from './eventLog.ts';
import { InventoryView } from './InventoryView.tsx';
import { SupplierView } from './SupplierView.tsx';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

test('inventory items render as compact name, status, and supplier rows', () => {
  render(<InventoryView onFindSupplier={() => {}} />);

  const list = screen.getByRole('main', { name: 'Inventory' });
  const firstRow = list.querySelector<HTMLElement>('.inv-row')!;
  expect(firstRow.querySelector('.inv-row__name')?.textContent).toBe('Pizza Flour');
  expect(firstRow.querySelector('.inv-row__status')?.textContent).toBe('Not counted yet');
  expect(within(firstRow).getByRole('button', { name: 'Prima / David Stores (Wholesale)' })).toBeTruthy();
  expect(within(firstRow).queryByRole('button', { name: 'Order Pizza Flour' })).toBeNull(); // ordering is Purchase orders
});

test('new ingredient requires suppliers and saves as a stock event', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);

  await user.click(screen.getByRole('button', { name: '+ Add Ingredient' }));
  expect(screen.getByRole('button', { name: 'Save Ingredient' }).hasAttribute('disabled')).toBe(true);
  await user.type(screen.getByRole('textbox', { name: 'Ingredient name' }), 'Sea Salt');
  await user.click(screen.getByRole('searchbox', { name: 'Suppliers' }));
  await user.click(screen.getByRole('button', { name: '+ Prima / David Stores (Wholesale)' }));
  expect(screen.getByRole('button', { name: 'Save Ingredient' }).hasAttribute('disabled')).toBe(true); // no unit or price yet
  await user.click(within(screen.getByRole('group', { name: 'Unit' })).getByRole('button', { name: 'kg' }));
  await user.type(screen.getByRole('textbox', { name: 'Price per kg' }), '0');
  expect(screen.getByRole('button', { name: 'Save Ingredient' }).hasAttribute('disabled')).toBe(true); // a price above zero
  await user.clear(screen.getByRole('textbox', { name: 'Price per kg' }));
  await user.type(screen.getByRole('textbox', { name: 'Price per kg' }), '450');
  await user.click(screen.getByRole('button', { name: 'Save Ingredient' }));

  expect(await screen.findByRole('heading', { name: 'Sea Salt' })).toBeTruthy();
  expect(readItems().find((item) => item.name === 'Sea Salt')).toMatchObject({ baseUnit: 'g', packQty: 1000, workingPriceCents: 45000 });
  expect(readAll().some((event) => event.type === 'stock.item_added' && event.item.name === 'Sea Salt')).toBe(true);
  expect(readItems().find((item) => item.name === 'Sea Salt')?.supplierIds).toEqual(['sup_prima']);
}, 15_000);

test('ingredient can be removed from its sheet and restored with Undo', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);

  await user.click(screen.getByRole('button', { name: 'Pizza Flour' }));
  await user.click(screen.getByRole('button', { name: 'Remove Pizza Flour' }));
  expect(screen.queryByRole('heading', { name: 'Pizza Flour' })).toBeNull();
  expect(readItems().some((item) => item.id === 'inv-0001')).toBe(false);
  expect(readAll().some((event) => event.type === 'stock.item_archived' && event.itemId === 'inv-0001')).toBe(true);

  await user.click(screen.getByRole('button', { name: 'Undo' }));
  expect(screen.getByRole('heading', { name: 'Pizza Flour' })).toBeTruthy();
  expect(readAll().some((event) => event.type === 'stock.item_restored' && event.itemId === 'inv-0001')).toBe(true);
}, 15_000);

test('adding a supplier requires at least one existing or new ingredient', async () => {
  const user = userEvent.setup();
  render(<SupplierView />);

  await user.click(screen.getByRole('button', { name: '+ Add Supplier' }));
  await user.type(screen.getByRole('textbox', { name: 'Supplier name' }), 'Ingredients Required');
  const save = screen.getByRole('button', { name: 'Save Supplier' });
  expect(save.hasAttribute('disabled')).toBe(true);

  const ingredientSearch = screen.getByRole('searchbox', { name: 'Ingredients' });
  await user.type(ingredientSearch, 'Fresh Basil');
  await user.click(screen.getByRole('button', { name: '+ Add “Fresh Basil” as new ingredient' }));
  expect(save.hasAttribute('disabled')).toBe(true); // its unit and price first
  await user.click(within(screen.getByRole('group', { name: 'Fresh Basil unit' })).getByRole('button', { name: 'g' }));
  await user.type(screen.getByRole('textbox', { name: 'Fresh Basil price per g' }), '2.50');
  expect(save.hasAttribute('disabled')).toBe(false);

  await user.click(screen.getByRole('button', { name: 'Remove new ingredient Fresh Basil' }));
  expect(save.hasAttribute('disabled')).toBe(true);
  expect(readAll().some((event) => event.type === 'stock.supplier_added' && event.supplier.name === 'Ingredients Required')).toBe(false);
});

test('new supplier links selected ingredients independently and persists the creation event', async () => {
  const user = userEvent.setup();
  render(<SupplierView />);

  await user.click(screen.getByRole('button', { name: '+ Add Supplier' }));
  await user.type(screen.getByRole('textbox', { name: 'Supplier name' }), 'Fresh Farms');
  await user.type(screen.getByRole('textbox', { name: 'Phone Optional' }), '+94770000000');
  await user.click(screen.getByRole('searchbox', { name: 'Ingredients' }));
  await user.click(screen.getByRole('button', { name: '+ Pizza Flour' }));
  await user.type(screen.getByRole('searchbox', { name: 'Ingredients' }), 'Fresh Basil');
  await user.click(screen.getByRole('button', { name: '+ Add “Fresh Basil” as new ingredient' }));
  expect(screen.getByRole('button', { name: 'Remove new ingredient Fresh Basil' })).toBeTruthy();
  await user.click(within(screen.getByRole('group', { name: 'Fresh Basil unit' })).getByRole('button', { name: 'pcs' }));
  await user.type(screen.getByRole('textbox', { name: 'Fresh Basil price per pcs' }), '40');
  await user.click(screen.getByRole('button', { name: 'Save Supplier' }));

  const supplierToggle = await screen.findByRole('button', { name: 'Expand Fresh Farms' });
  await user.click(supplierToggle);
  expect(within(supplierToggle.closest('article')!).getByText('Pizza Flour')).toBeTruthy();
  const supplierEvent = readAll().find((event) =>
    event.type === 'stock.supplier_added' && event.supplier.name === 'Fresh Farms' &&
    event.linkedItemIds.includes('inv-0001'));
  expect(supplierEvent?.type).toBe('stock.supplier_added');
  const flour = readItems().find((item) => item.id === 'inv-0001')!;
  expect(flour.supplierIds).toContain('sup_prima');
  expect(flour.supplierIds).toContain(supplierEvent?.type === 'stock.supplier_added' ? supplierEvent.supplier.id : '');
  expect(flour.supplierIds).toHaveLength(3);
  const freshBasil = readItems().find((item) => item.name === 'Fresh Basil');
  expect(freshBasil).toMatchObject({ category: 'General', baseUnit: 'pcs', packQty: 1, workingPriceCents: 4000 });
  expect(freshBasil?.supplierIds).toContain(supplierEvent?.type === 'stock.supplier_added' ? supplierEvent.supplier.id : '');
  expect(supplierEvent?.type === 'stock.supplier_added' && supplierEvent.linkedItemIds).toContain(freshBasil?.id);

  cleanup();
  render(<InventoryView />);
  const inventoryFlour = screen.getByRole('heading', { name: 'Pizza Flour' }).parentElement!.parentElement!;
  expect(within(inventoryFlour!).getByText(/Fresh Farms/)).toBeTruthy();
  const inventoryBasil = screen.getByRole('heading', { name: 'Fresh Basil' }).parentElement!.parentElement!;
  expect(within(inventoryBasil!).getByText(/Fresh Farms/)).toBeTruthy();
}, 15_000);

test('supplier can be archived from its row and restored with Undo', async () => {
  const user = userEvent.setup();
  render(<SupplierView />);

  await user.click(screen.getByRole('button', { name: 'Remove Ajantha (Wholesale)' }));
  expect(readSuppliers().some((supplier) => supplier.id === 'sup_ajantha')).toBe(false);
  expect(readAll().some((event) => event.type === 'stock.supplier_archived' && event.supplierId === 'sup_ajantha')).toBe(true);

  await user.click(screen.getByRole('button', { name: 'Undo' }));
  expect(readSuppliers().some((supplier) => supplier.id === 'sup_ajantha')).toBe(true);
  expect(readAll().some((event) => event.type === 'stock.supplier_restored' && event.supplierId === 'sup_ajantha')).toBe(true);
}, 15_000);

test('supplier can be edited from its row, before Remove, and the edit undone', async () => {
  const user = userEvent.setup();
  render(<SupplierView />);

  const header = screen.getByRole('button', { name: 'Edit Ajantha (Wholesale)' }).parentElement!;
  const buttons = within(header).getAllByRole('button').map((b) => b.getAttribute('aria-label'));
  expect(buttons.indexOf('Edit Ajantha (Wholesale)')).toBeLessThan(buttons.indexOf('Remove Ajantha (Wholesale)'));

  await user.click(screen.getByRole('button', { name: 'Edit Ajantha (Wholesale)' }));
  const name = screen.getByRole('textbox', { name: 'Supplier name' });
  expect((name as HTMLInputElement).value).toBe('Ajantha (Wholesale)');
  await user.clear(name);
  await user.type(name, 'Ajantha Stores');
  await user.type(screen.getByRole('textbox', { name: /Phone/ }), '0771234567');
  await user.click(screen.getByRole('button', { name: 'Save Changes' }));

  expect(readSuppliers().find((s) => s.id === 'sup_ajantha')).toEqual({ id: 'sup_ajantha', name: 'Ajantha Stores', phone: '0771234567' });
  expect(readAll().some((e) => e.type === 'stock.supplier_edited' && e.before.name === 'Ajantha (Wholesale)')).toBe(true);
  expect(screen.getByRole('status').textContent).toContain('Ajantha Stores updated.');

  await user.click(screen.getByRole('button', { name: 'Undo' }));
  expect(readSuppliers().find((s) => s.id === 'sup_ajantha')?.name).toBe('Ajantha (Wholesale)');
}, 15_000);
