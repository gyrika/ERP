import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { appendEvent } from './eventLog.ts';
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

  await user.click(screen.getAllByRole('button', { name: 'Prima / David Stores (Wholesale)' })[0]);

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

  await user.click(await screen.findByRole('link', { name: 'Stock' }));
  const ingredientRow = screen.getByRole('heading', { name: 'End-to-end Flour' }).closest('.inv-row') as HTMLElement;
  expect(within(ingredientRow).getByText('End-to-end Supplier')).toBeTruthy();

  await user.click(within(ingredientRow).getByRole('button', { name: 'End-to-end Supplier' }));
  expect(await screen.findByRole('heading', { name: 'Targeted Suppliers' })).toBeTruthy();
  const supplierToggle = screen.getByRole('button', { name: 'Expand End-to-end Supplier' });
  await user.click(supplierToggle);
  expect(within(supplierToggle.closest('article') as HTMLElement).getByText('End-to-end Flour')).toBeTruthy();
});

test('one sidebar on every owner screen: the same parts, the current one marked, Register goes back (SCRUM-131)', async () => {
  const user = userEvent.setup();
  history.replaceState(null, '', '/#inventory');
  render(<Root />);
  const nav = () => within(screen.getByRole('navigation', { name: 'Owner sections' }));
  const names = () => nav().getAllByRole('link').map((a) => a.getAttribute('aria-label'));
  const current = () => nav().getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.getAttribute('aria-label'));
  const parts = ['Today', 'Stock', 'Menu', 'Recipes', 'Counts', 'Suppliers', 'Shop setup'];

  for (const [link, main] of [['Suppliers', 'Suppliers'], ['Today', 'Owner'], ['Menu', 'Menu'], ['Recipes', 'Recipes, locked'], ['Counts', 'Manager'], ['Shop setup', 'Shop setup'], ['Stock', 'Inventory']]) {
    await user.click(nav().getByRole('link', { name: link }));
    expect(await screen.findByRole('main', { name: main })).toBeTruthy();
    expect(names()).toEqual(parts);
    expect(current()).toEqual([link]);
  }
  // Each part says what is going on there (nothing sold, nothing counted yet).
  expect(await nav().findByText('No sales yet today')).toBeTruthy();
  expect(nav().getByText(/^0 of \d+ counted$/)).toBeTruthy();
  expect(nav().getByRole('heading', { name: 'Nothing needs you' })).toBeTruthy();
  await user.click(nav().getByRole('button', { name: 'Register' }));
  expect(await screen.findByRole('complementary', { name: 'Current order' })).toBeTruthy();
});

test('a part that needs a decision moves to Needs you with a badge; Ctrl K finds a part by what is going on there', async () => {
  const user = userEvent.setup();
  // Onion counted at a quarter of a pack: running low.
  appendEvent({ type: 'stock.adjusted', at: Date.now(), orderNumber: 0, actor: { id: 'o', name: 'Owner', role: 'owner' }, itemId: 'inv-0024', deltaPacks: 0.25, reason: 'audit' });
  history.replaceState(null, '', '/#menu');
  render(<Root />);
  const nav = within(screen.getByRole('navigation', { name: 'Owner sections' }));
  const needs = await nav.findByRole('heading', { name: 'Needs you' });
  const stock = nav.getByRole('link', { name: 'Stock' });
  expect(needs.nextElementSibling?.contains(stock)).toBe(true);
  expect(stock.textContent).toBe('StockOnion running low1');
  expect(nav.getByRole('heading', { name: 'All quiet' })).toBeTruthy();

  await user.keyboard('{Control>}k{/Control}');
  const ask = screen.getByRole('dialog', { name: 'Commands' });
  await user.type(within(ask).getByRole('textbox', { name: 'Ask or find…' }), 'onion{Enter}');
  expect(await screen.findByRole('main', { name: 'Inventory' })).toBeTruthy();
});

test('on a narrow screen the parts open as a drawer from the menu button', async () => {
  const user = userEvent.setup();
  history.replaceState(null, '', '/#menu');
  render(<Root />);
  const open = screen.getByRole('button', { name: 'Show the parts of the shop' });
  expect(open.getAttribute('aria-expanded')).toBe('false');
  await user.click(open);
  expect(open.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('navigation', { name: 'Owner sections' }).classList.contains('side--open')).toBe(true);
  await user.keyboard('{Escape}');
  expect(open.getAttribute('aria-expanded')).toBe('false');
  expect(screen.getByRole('main', { name: 'Menu' })).toBeTruthy(); // Esc closed the drawer, not the Menu
});

