import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as inventoryStore from '../services/inventoryStore.ts';
import { InventoryView } from './InventoryView.tsx';
import { SupplierView } from './SupplierView.tsx';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

test('inventory filters and searches seeded items by category and name', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);

  await user.click(screen.getByRole('button', { name: 'Audit' }));
  await user.click(screen.getByRole('button', { name: 'Veg' }));
  expect(screen.getByText('Onion')).toBeTruthy();
  expect(screen.queryByText('Pizza Flour')).toBeNull();

  await user.type(screen.getByRole('searchbox'), 'tomato');
  expect(screen.getByText('Tomato')).toBeTruthy();
  expect(screen.queryByText('Onion')).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Packaging' }));
  expect(screen.getByText('No items match')).toBeTruthy();
});

test('inventory filters hide while scrolling down and return while scrolling up', () => {
  render(<InventoryView />);
  const scrollArea = screen.getByRole('region', { name: 'Inventory list' });
  const header = screen.getByRole('searchbox').closest('.inv-command-bar')!;

  scrollArea.scrollTop = 120;
  fireEvent.scroll(scrollArea);
  expect(header.classList.contains('inv-command-bar--hidden')).toBe(true);

  scrollArea.scrollTop = 80;
  fireEvent.scroll(scrollArea);
  expect(header.classList.contains('inv-command-bar--hidden')).toBe(false);

  scrollArea.scrollTop = 0;
  fireEvent.scroll(scrollArea);
  expect(header.classList.contains('inv-command-bar--hidden')).toBe(false);
});

test('stock stepper updates persistently and low-stock warning follows the threshold', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<InventoryView />);
  await user.click(screen.getByRole('button', { name: 'Audit' }));
  const flour = screen.getByText('Pizza Flour').closest('li')!;

  expect(within(flour).getByRole('img', { name: 'Out of stock' })).toBeTruthy();
  expect(flour.classList.contains('inv-row--out')).toBe(true);
  await user.click(within(flour).getByRole('button', { name: 'Add one pack of Pizza Flour' }));
  expect(within(flour).getByText('1')).toBeTruthy();
  expect(within(flour).getByRole('img', { name: 'Low stock' })).toBeTruthy();
  expect(within(flour).queryByRole('img', { name: 'Out of stock' })).toBeNull();

  await user.click(within(flour).getByRole('button', { name: 'Add one pack of Pizza Flour' }));
  expect(within(flour).getByText('2')).toBeTruthy();
  expect(within(flour).getByRole('img', { name: 'In stock' })).toBeTruthy();
  expect(within(flour).queryByRole('img', { name: 'Low stock' })).toBeNull();
  expect(within(flour).queryByRole('img', { name: 'Out of stock' })).toBeNull();

  unmount();
  render(<InventoryView />);
  await user.click(screen.getByRole('button', { name: 'Audit' }));
  const restored = screen.getByText('Pizza Flour').closest('li')!;
  expect(within(restored).getByText('2')).toBeTruthy();
});

test('metrics bar distinguishes between out of stock and low stock counts', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  await user.click(screen.getByRole('button', { name: 'Audit' }));

  expect(screen.getByText((_, element) => element?.textContent?.replace(/\s+/g, ' ').trim() === '59 out')).toBeTruthy();
  expect(screen.getByText((_, element) => element?.textContent?.replace(/\s+/g, ' ').trim() === '0 low')).toBeTruthy();

  const flour = screen.getByText('Pizza Flour').closest('li')!;
  await user.click(within(flour).getByRole('button', { name: 'Add one pack of Pizza Flour' }));

  expect(screen.getByText((_, element) => element?.textContent?.replace(/\s+/g, ' ').trim() === '58 out')).toBeTruthy();
  expect(screen.getByText((_, element) => element?.textContent?.replace(/\s+/g, ' ').trim() === '1 low')).toBeTruthy();
});

test('price drawer reports invalid input and saves valid LKR cents', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  await user.click(screen.getByRole('button', { name: 'Audit' }));

  await user.click(screen.getByRole('button', { name: /Edit price for Pizza Flour/ }));
  const price = screen.getByRole('textbox', { name: 'Price' });
  await user.clear(price);
  await user.type(price, '1,,25');
  await user.click(screen.getByRole('button', { name: 'Save price' }));

  expect(screen.getByRole('alert').textContent).toContain('valid LKR price');
  expect(screen.getByRole('dialog', { name: 'Price · Pizza Flour' })).toBeTruthy();

  await user.clear(price);
  await user.type(price, '1,250.25');
  await user.click(screen.getByRole('button', { name: 'Save price' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('button', { name: /Edit price for Pizza Flour, Rs 1,250.25/ })).toBeTruthy();
});

test('supplier cards show primary and backup counts without inventing contact details', () => {
  render(<SupplierView />);

  expect(screen.getByRole('main', { name: 'Suppliers' }).classList.contains('inv-shell')).toBe(true);
  expect(screen.getByRole('heading', { name: 'Suppliers' }).classList.contains('supplier-heading')).toBe(true);

  const ajanthaHeading = screen.getByRole('heading', { name: 'Ajantha' });
  expect(ajanthaHeading.closest('article')?.classList.contains('sup-card')).toBe(true);
  const ajantha = within(ajanthaHeading.closest('article')!);
  expect(ajantha.getByText('Primary items')).toBeTruthy();
  expect(ajantha.getByText('Backup items')).toBeTruthy();
  expect(ajantha.getByText('Wholesale')).toBeTruthy();
  const callLink = ajantha.getByRole('link', { name: 'Call Ajantha' });
  expect(callLink.getAttribute('href')).toBe('tel:+94773456789');
  const waLink = ajantha.getByRole('link', { name: 'WhatsApp Ajantha' });
  expect(waLink.getAttribute('href')).toBe('https://wa.me/94773456789');

  const nimmiHeading = screen.getByRole('heading', { name: 'Nimmi veg shop' });
  expect(within(nimmiHeading.closest('article')!).getByText('Thalwila')).toBeTruthy();
});

test('supplier cards render fallback message when phone is missing', () => {
  const spy = vi.spyOn(inventoryStore, 'useInventory').mockReturnValue({
    items: [],
    suppliers: [{ id: 'sup_nophone', name: 'No Phone Store (Direct)' }],
  });
  render(<SupplierView />);
  expect(screen.getByText('No phone on file')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Call Supplier' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'WhatsApp' })).toBeNull();
  spy.mockRestore();
});

