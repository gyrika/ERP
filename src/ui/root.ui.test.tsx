import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Root } from './Root.tsx';

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, '', '/');
});
afterEach(cleanup);

const panel = () => within(screen.getByRole('complementary', { name: 'Current order' }));
const kitchen = () => within(screen.getByRole('main', { name: 'Orders to make' }));

const sendOne = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: /^Devilled Chicken/ }));
  await user.click(screen.getByRole('button', { name: /Large/ }));
  await user.click(screen.getByRole('button', { name: /^Add ·/ }));
  await user.click(panel().getByRole('button', { name: 'Send to kitchen' }));
};

test('one counter PC: F2 flips Register ⇄ Kitchen, the chip shows what is cooking, Space bumps the oldest', async () => {
  const user = userEvent.setup();
  render(<Root />);
  expect(screen.getByRole('button', { name: 'Kitchen: nothing cooking' })).toBeTruthy();

  await sendOne(user);
  expect(screen.getByRole('button', { name: 'Kitchen: 1 cooking, oldest waiting 00:00' })).toBeTruthy();

  await user.keyboard('{F2}');
  expect(location.hash).toBe('#kitchen');
  expect(kitchen().getByRole('article', { name: 'Order 1001' })).toBeTruthy();

  await user.keyboard(' ');
  expect(kitchen().getByText('No orders waiting')).toBeTruthy();

  await user.keyboard('{Control>}z{/Control}');
  expect(kitchen().getByRole('article', { name: 'Order 1001' })).toBeTruthy();

  await user.keyboard('{F2}');
  expect(location.hash).toBe('');
  expect(screen.getByRole('complementary', { name: 'Current order' })).toBeTruthy();

  // Touch works too: the chip opens the Kitchen, the Register key (or Esc) comes back.
  await user.click(screen.getByRole('button', { name: /^Kitchen: 1 cooking/ }));
  await user.click(screen.getByRole('button', { name: /^Register/ }));
  expect(screen.getByRole('complementary', { name: 'Current order' })).toBeTruthy();
  await user.keyboard('{F2}{Escape}');
  expect(screen.getByRole('complementary', { name: 'Current order' })).toBeTruthy();
});

test('a kitchen device opened at /#kitchen has no Register key', () => {
  history.replaceState(null, '', '/#kitchen');
  render(<Root />);
  expect(kitchen().getByText('No orders waiting')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Register/ })).toBeNull();
});

test('inventory and supplier bookmarks open their respective views', () => {
  history.replaceState(null, '', '/#inventory');
  const { unmount } = render(<Root />);
  expect(screen.getByRole('main', { name: 'Inventory' })).toBeTruthy();

  unmount();
  history.replaceState(null, '', '/#suppliers');
  render(<Root />);
  expect(screen.getByRole('main', { name: 'Suppliers' })).toBeTruthy();
});

test('finding an ingredient supplier routes to the filtered supplier view', async () => {
  history.replaceState(null, '', '/#inventory');
  const user = userEvent.setup();
  render(<Root />);

  await user.click(screen.getAllByRole('button', { name: 'Find Supplier' })[0]);

  expect(location.hash).toBe('#suppliers');
  expect(screen.getByRole('heading', { name: 'Targeted Suppliers' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Expand Prima / David Stores (Wholesale)' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Expand Ajantha (Wholesale)' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Nimmi veg shop/ })).toBeNull();
});

test('adding a supplier with a new ingredient updates Inventory and Find Supplier', async () => {
  history.replaceState(null, '', '/#suppliers');
  const user = userEvent.setup();
  render(<Root />);

  await user.click(screen.getByRole('button', { name: '+ Add Supplier' }));
  await user.type(screen.getByRole('textbox', { name: 'Supplier name' }), 'End-to-end Supplier');
  await user.type(screen.getByRole('textbox', { name: 'Phone Optional' }), '+94770000000');
  await user.type(screen.getByRole('searchbox', { name: 'Ingredients' }), 'End-to-end Flour');
  await user.click(screen.getByRole('button', { name: '+ Add “End-to-end Flour” as new ingredient' }));
  await user.click(screen.getByRole('button', { name: 'Save Supplier' }));

  await user.click(await screen.findByRole('link', { name: 'Inventory' }));
  const ingredientRow = screen.getByRole('heading', { name: 'End-to-end Flour' }).closest('.inv-row')!;
  expect(within(ingredientRow).getByText('End-to-end Supplier')).toBeTruthy();

  await user.click(within(ingredientRow).getByRole('button', { name: 'Find Supplier' }));
  expect(await screen.findByRole('heading', { name: 'Targeted Suppliers' })).toBeTruthy();
  const supplierToggle = screen.getByRole('button', { name: 'Expand End-to-end Supplier' });
  await user.click(supplierToggle);
  expect(within(supplierToggle.closest('article')!).getByText('End-to-end Flour')).toBeTruthy();
});

test('inventory and suppliers link to each other and to the Owner view', async () => {
  const user = userEvent.setup();
  history.replaceState(null, '', '/#inventory');
  render(<Root />);

  await user.click(screen.getByRole('link', { name: 'Suppliers' }));
  expect(await screen.findByRole('main', { name: 'Suppliers' })).toBeTruthy();
  await user.click(screen.getByRole('link', { name: 'Inventory' }));
  expect(await screen.findByRole('main', { name: 'Inventory' })).toBeTruthy();
  await user.click(screen.getByRole('link', { name: 'Suppliers' }));
  await user.click(await screen.findByRole('button', { name: 'Owner view' }));

  expect(await screen.findByRole('main', { name: 'Owner' })).toBeTruthy();
});
