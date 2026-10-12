import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InventoryView } from './InventoryView.tsx';
import { SupplierView } from './SupplierView.tsx';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

test('inventory filters and searches seeded items by category and name', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);

  await user.click(screen.getByRole('button', { name: 'Veg' }));
  expect(screen.getByText('Onion')).toBeTruthy();
  expect(screen.queryByText('Pizza Flour')).toBeNull();

  await user.type(screen.getByRole('searchbox'), 'tomato');
  expect(screen.getByText('Tomato')).toBeTruthy();
  expect(screen.queryByText('Onion')).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Packaging' }));
  expect(screen.getByText('No items match')).toBeTruthy();
});

test('stock stepper updates persistently and low-stock warning follows the threshold', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<InventoryView />);
  const flour = screen.getByText('Pizza Flour').closest('li')!;

  expect(within(flour).getByText('Low stock')).toBeTruthy();
  await user.click(within(flour).getByRole('button', { name: 'Add one pack of Pizza Flour' }));
  expect(within(flour).getByText('1')).toBeTruthy();
  expect(within(flour).getByText('Low stock')).toBeTruthy();

  await user.click(within(flour).getByRole('button', { name: 'Add one pack of Pizza Flour' }));
  expect(within(flour).getByText('2')).toBeTruthy();
  expect(within(flour).queryByText('Low stock')).toBeNull();

  unmount();
  render(<InventoryView />);
  const restored = screen.getByText('Pizza Flour').closest('li')!;
  expect(within(restored).getByText('2')).toBeTruthy();
});

test('price drawer reports invalid input and saves valid LKR cents', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);

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

  const primaHeading = screen.getByRole('heading', { name: 'Prima / David Stores' });
  const prima = within(primaHeading.closest('article')!);
  expect(prima.getByText('Primary items')).toBeTruthy();
  expect(prima.getByText('Backup items')).toBeTruthy();
  expect(prima.getByText('Wholesale')).toBeTruthy();
  expect(prima.getByText('No contact details on file')).toBeTruthy();

  const nimmiHeading = screen.getByRole('heading', { name: 'Nimmi veg shop' });
  expect(within(nimmiHeading.closest('article')!).getByText('Thalwila')).toBeTruthy();
});
