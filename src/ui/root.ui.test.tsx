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

test('one counter PC: F2 flips Register ⇄ Kitchen, the chip shows what is left to make, Space bumps the oldest', async () => {
  const user = userEvent.setup();
  render(<Root />);
  expect(screen.getByRole('button', { name: 'Kitchen: nothing to make' })).toBeTruthy();

  await sendOne(user);
  expect(screen.getByRole('button', { name: 'Kitchen: 1 to make, oldest waiting 00:00' })).toBeTruthy();

  await user.keyboard('{F2}');
  expect(location.hash).toBe('#kitchen');
  expect(kitchen().getByRole('article', { name: 'Order 1001' })).toBeTruthy();

  await user.keyboard(' '); // Start
  expect(kitchen().getByRole('button', { name: 'Done: Order 1001' })).toBeTruthy();
  await user.keyboard(' '); // Done
  expect(kitchen().getByText('No orders waiting')).toBeTruthy();

  await user.keyboard('{Control>}z{/Control}');
  expect(kitchen().getByRole('article', { name: 'Order 1001' })).toBeTruthy();

  await user.keyboard('{F2}');
  expect(location.hash).toBe('');
  expect(screen.getByRole('complementary', { name: 'Current order' })).toBeTruthy();

  // Touch works too: the chip opens the Kitchen, the Register key (or Esc) comes back.
  await user.click(screen.getByRole('button', { name: /^Kitchen: 1 to make/ }));
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
  await user.click(within(screen.getByRole('group', { name: 'End-to-end Flour unit' })).getByRole('button', { name: 'kg' }));
  await user.type(screen.getByRole('textbox', { name: 'End-to-end Flour price per kg' }), '300');
  await user.click(screen.getByRole('button', { name: 'Save Supplier' }));

  await user.click(await screen.findByRole('link', { name: 'Items' }));
  const ingredientRow = screen.getByRole('heading', { name: 'End-to-end Flour' }).closest('.inv-row') as HTMLElement;
  expect(within(ingredientRow).getByText('End-to-end Supplier')).toBeTruthy();

  await user.click(within(ingredientRow).getByRole('button', { name: 'End-to-end Supplier' }));
  expect(await screen.findByRole('heading', { name: 'Targeted Suppliers' })).toBeTruthy();
  const supplierToggle = screen.getByRole('button', { name: 'Expand End-to-end Supplier' });
  await user.click(supplierToggle);
  expect(within(supplierToggle.closest('article') as HTMLElement).getByText('End-to-end Flour')).toBeTruthy();
});

test('the shop\'s day: the work first, then Items, then Settings; every part keeps its place; Sell goes to the register', async () => {
  const user = userEvent.setup();
  history.replaceState(null, '', '/#items');
  render(<Root />);
  const nav = () => within(screen.getByRole('navigation', { name: 'Owner sections' }));
  const names = () => nav().getAllByRole('link').map((a) => a.getAttribute('aria-label'));
  const current = () => nav().getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.getAttribute('aria-label'));
  const parts = ['Sell', 'Receive', 'Order', 'Count', 'Today', 'Items', 'Visual Flow', 'Computer vision', 'Settings'];
  expect(nav().getAllByRole('heading').map((h) => h.textContent)).toEqual(['Work', 'Things']);

  for (const [link, main] of [['Receive', 'Receive'], ['Order', 'Order'], ['Count', 'Manager'], ['Today', 'Owner'], ['Settings', 'Shop setup'], ['Visual Flow', 'Visual Flow'], ['Computer vision', 'Computer vision'], ['Items', 'Inventory']]) {
    await user.click(nav().getByRole('link', { name: link }));
    expect(await screen.findByRole('main', { name: main })).toBeTruthy();
    expect(names()).toEqual(parts);
    expect(current()).toEqual([link]);
  }
  // Items: raw materials, semi-processed, finished, all under Items.
  const tabs = () => within(screen.getByRole('navigation', { name: 'Items' }));
  expect(tabs().getAllByRole('link').map((a) => a.firstChild?.textContent)).toEqual(['Raw materials', 'Semi-processed', 'Finished']);
  await user.click(tabs().getByRole('link', { name: /^Finished/ }));
  expect(await screen.findByRole('main', { name: 'Menu' })).toBeTruthy();
  expect(current()).toEqual(['Items']);
  expect(tabs().getByRole('link', { name: /^Finished/ }).getAttribute('aria-current')).toBe('page');
  // Each part says what is going on there.
  expect(await nav().findByText('No sales yet today')).toBeTruthy();
  expect(nav().getByText('The register')).toBeTruthy();
  expect(nav().getByText('No deliveries expected')).toBeTruthy();
  await user.click(nav().getByRole('link', { name: 'Sell' }));
  expect(await screen.findByRole('complementary', { name: 'Current order' })).toBeTruthy();
});

test('a badge marks the part where a decision waits, without moving it; Ctrl K finds a part by what is going on there', async () => {
  const user = userEvent.setup();
  // Onion counted and found empty: out.
  appendEvent({ type: 'stock.adjusted', at: Date.now(), orderNumber: 0, actor: { id: 'o', name: 'Owner', role: 'owner' }, itemId: 'inv-0024', deltaPacks: 1, reason: 'audit' });
  appendEvent({ type: 'stock.adjusted', at: Date.now(), orderNumber: 0, actor: { id: 'o', name: 'Owner', role: 'owner' }, itemId: 'inv-0024', deltaPacks: -1, reason: 'audit' });
  history.replaceState(null, '', '/#menu');
  render(<Root />);
  const nav = within(screen.getByRole('navigation', { name: 'Owner sections' }));
  const items = nav.getByRole('link', { name: 'Items' });
  expect(await within(items).findByText('Onion out')).toBeTruthy();
  expect(items.textContent).toBe('ItemsOnion out1');
  expect(nav.getAllByRole('link').map((a) => a.getAttribute('aria-label'))).toEqual(['Sell', 'Receive', 'Order', 'Count', 'Today', 'Items', 'Visual Flow', 'Computer vision', 'Settings']); // still in its place

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

