import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as inventoryStore from '../services/inventoryStore.ts';
import { readAll } from './eventLog.ts';
import { SEED_INVENTORY } from '../domain/inventoryData.ts';
import { InventoryView } from './InventoryView.tsx';
import { SupplierView } from './SupplierView.tsx';

beforeEach(() => localStorage.clear());

/** A stock row as the screens get it. */
const stocked = (item: (typeof SEED_INVENTORY)[number], packs: number): inventoryStore.InventoryRow =>
  ({ ...item, onHandPacks: packs, onHandBaseUnits: packs * item.packQty, archived: false, counted: true, usedPerDay: 0, lastsDays: null, missedSales: 0, lastCountedAt: null, units: [], tier: null });
afterEach(cleanup);

test('every seeded ingredient is listed once, with all of its suppliers', () => {
  render(<InventoryView />);

  const rows = within(screen.getByRole('main', { name: 'Inventory' })).getAllByRole('article');
  expect(rows).toHaveLength(SEED_INVENTORY.length);
  const flour = screen.getByRole('heading', { name: 'Pizza Flour' }).closest('article')!;
  expect(within(flour).getByLabelText('Suppliers').textContent).toBe('Prima / David Stores (Wholesale), Ajantha (Wholesale)');
});

test("the supplier's name hands the ingredient to the supplier board, and is plain text without one", async () => {
  const user = userEvent.setup();
  const onFindSupplier = vi.fn();
  const { unmount } = render(<InventoryView onFindSupplier={onFindSupplier} />);

  const flour = screen.getByRole('heading', { name: 'Pizza Flour' }).closest('article')!;
  await user.click(within(flour).getByRole('button', { name: 'Ajantha (Wholesale)' }));
  expect(onFindSupplier).toHaveBeenCalledExactlyOnceWith('inv-0001');

  unmount();
  render(<InventoryView />);
  expect(screen.queryByRole('button', { name: 'Ajantha (Wholesale)' })).toBeNull();
});

test('the stock status follows the low-stock threshold live as packs are counted', () => {
  render(<InventoryView />);
  const flour = screen.getByRole('heading', { name: 'Pizza Flour' }).closest('article')!;
  const status = () => flour.querySelector('.inv-row__status')!.textContent;

  expect(status()).toBe('Not counted yet'); // unknown, never shown as out
  act(() => inventoryStore.adjustStock('inv-0001', 1));
  act(() => inventoryStore.adjustStock('inv-0001', -1));
  expect(status()).toBe('Out of stock');
  act(() => inventoryStore.adjustStock('inv-0001', 1));
  expect(status()).toBe('Low stock');
  act(() => inventoryStore.adjustStock('inv-0001', 1));
  expect(status()).toBe('In stock');
  expect(within(flour).getByLabelText('Available stock and pack size').textContent).toContain('50 kg / 25 kg');
});

test('counted stock survives a reload', () => {
  inventoryStore.adjustStock('inv-0001', 2);
  const { unmount } = render(<InventoryView />);
  unmount();
  render(<InventoryView />);

  const flour = screen.getByRole('heading', { name: 'Pizza Flour' }).closest('article')!;
  expect(within(flour).getByLabelText('Available stock and pack size').textContent).toContain('50 kg / 25 kg');
  expect(within(flour).getByText('In stock')).toBeTruthy();
});

test('an ingredient whose only supplier is removed says it has no active suppliers', () => {
  inventoryStore.archiveSupplier('sup_ajantha');
  render(<InventoryView />);

  const tomato = screen.getByRole('heading', { name: 'Peeled Tomato / Sugo' }).closest('article')!;
  expect(within(tomato).getByLabelText('Suppliers').textContent).toBe('No active suppliers');
  const flour = screen.getByRole('heading', { name: 'Pizza Flour' }).closest('article')!;
  expect(within(flour).getByLabelText('Suppliers').textContent).toBe('Prima / David Stores (Wholesale)');
});

test('supplier list expands to show linked ingredients and contact actions', async () => {
  const user = userEvent.setup();
  render(<SupplierView />);

  const main = screen.getByRole('main', { name: 'Suppliers' });
  expect(main.classList.contains('supplier-grid')).toBe(true);
  const ajantha = screen.getByRole('button', { name: 'Expand Ajantha (Wholesale)' });
  const secondSupplier = screen.getByRole('button', { name: 'Expand Prima / David Stores (Wholesale)' });
  const details = ajantha.closest('article')!.querySelector('.sup-card__expand');
  const secondDetails = secondSupplier.closest('article')!.querySelector('.sup-card__expand');
  expect(details?.hasAttribute('hidden')).toBe(true);
  expect(ajantha.closest('article')!.classList.contains('supplier-card--expanded')).toBe(false);
  await user.click(ajantha);
  expect(details?.hasAttribute('hidden')).toBe(false);
  expect(ajantha.closest('article')!.classList.contains('supplier-card--expanded')).toBe(true);
  await user.click(secondSupplier);
  expect(secondDetails?.hasAttribute('hidden')).toBe(false);
  expect(secondSupplier.closest('article')!.classList.contains('supplier-card--expanded')).toBe(true);
  const rows = [...main.querySelectorAll('article')];
  expect(rows).toContain(ajantha.closest('article'));
  expect(rows).toContain(secondSupplier.closest('article'));
  expect(within(ajantha.closest('article')!).getByText('Pizza Flour')).toBeTruthy();
  expect(within(ajantha.closest('article')!).getByText('No phone on file')).toBeTruthy(); // never made up
});

test('a supplier number the manager typed the local way calls, and opens WhatsApp with the country code', async () => {
  const user = userEvent.setup();
  inventoryStore.addSupplier({ id: 'sup_farm', name: 'Fresh Farms', phone: '077 123 4567' }, ['inv-0001']);
  render(<SupplierView />);
  await user.click(screen.getByRole('button', { name: 'Expand Fresh Farms' }));
  const card = within(screen.getByRole('button', { name: 'Collapse Fresh Farms' }).closest('article')!);
  expect(card.getByRole('link', { name: 'Call' }).getAttribute('href')).toBe('tel:077 123 4567');
  expect(card.getByRole('link', { name: 'WhatsApp' }).getAttribute('href')).toBe('https://wa.me/94771234567');
});

test('supplier cards show the name only, no status dot or plus mark', () => {
  const lowItem = { ...stocked(SEED_INVENTORY[0], 1), supplierIds: ['sup-low'] };
  const outItem = { ...stocked(SEED_INVENTORY[1], 0), supplierIds: ['sup-out'] };
  const spy = vi.spyOn(inventoryStore, 'useInventory').mockReturnValue({
    items: [lowItem, outItem],
    suppliers: [
      { id: 'sup-low', name: 'Low Supplier' },
      { id: 'sup-out', name: 'Out Supplier' },
    ],
    untrackedSold: 0,
  });
  render(<SupplierView />);

  const lowSupplier = screen.getByRole('button', { name: 'Expand Low Supplier' }).closest('article');
  const outSupplier = screen.getByRole('button', { name: 'Expand Out Supplier' }).closest('article');
  for (const card of [lowSupplier!, outSupplier!]) {
    expect(within(card).queryByRole('img')).toBeNull();
    expect(card.textContent).not.toMatch(/[+−]/);
  }
  spy.mockRestore();
});

test('inventory rows show available base quantity against the plan pack size', () => {
  const flour = { ...stocked(SEED_INVENTORY[0], 0), onHandPacks: 12400 / 25000, onHandBaseUnits: 12400 };
  const spy = vi.spyOn(inventoryStore, 'useInventory').mockReturnValue({
    items: [flour],
    suppliers: [],
    untrackedSold: 0,
  });
  render(<InventoryView />);

  const row = screen.getByRole('heading', { name: 'Pizza Flour' }).closest('article')!;
  expect(within(row).getByLabelText('Available stock and pack size').textContent).toContain('12.4 kg / 25 kg');
  spy.mockRestore();
});

test('an item with sales it could not take says Check shelf, and sales with no recipe are named once', () => {
  const flour = { ...stocked(SEED_INVENTORY[0], 3), missedSales: 4 };
  const spy = vi.spyOn(inventoryStore, 'useInventory').mockReturnValue({ items: [flour], suppliers: [], untrackedSold: 2 });
  render(<InventoryView />);

  const row = screen.getByRole('heading', { name: 'Pizza Flour' }).closest('article')!;
  expect(within(row).getByText('Check shelf')).toBeTruthy();
  expect(within(row).getByText('4 sold since the last count not taken off')).toBeTruthy();
  expect(screen.getByText(/2 items sold this week took no stock/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Answer on Menu' }).getAttribute('href')).toBe('#menu');
  spy.mockRestore();
});

test('a low item stays Low stock even with missed sales: the shelf can only be lower', () => {
  const flour = { ...stocked(SEED_INVENTORY[0], 1), missedSales: 4 };
  const spy = vi.spyOn(inventoryStore, 'useInventory').mockReturnValue({ items: [flour], suppliers: [], untrackedSold: 0 });
  render(<InventoryView />);
  const row = screen.getByRole('heading', { name: 'Pizza Flour' }).closest('article')!;
  expect(within(row).getByText('Low stock')).toBeTruthy();
  expect(screen.queryByText(/took no stock/)).toBeNull();
  spy.mockRestore();
});

test('supplier cards render fallback message when phone is missing', () => {
  const spy = vi.spyOn(inventoryStore, 'useInventory').mockReturnValue({
    items: [],
    suppliers: [{ id: 'sup_nophone', name: 'No Phone Store (Direct)' }],
    untrackedSold: 0,
  });
  render(<SupplierView />);
  fireEvent.click(screen.getByRole('button', { name: 'Expand No Phone Store (Direct)' }));
  expect(screen.getByText('No phone on file')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Call Supplier' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'WhatsApp' })).toBeNull();
  spy.mockRestore();
});

const flourRow = () => screen.getByRole('heading', { name: 'Pizza Flour' }).closest('article')!;
const amount = () => within(flourRow()).getByLabelText('Available stock and pack size').textContent;

test('a delivery: packs in and the new price in one go, saved at once; Undo takes both back', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  await user.click(within(flourRow()).getByRole('button', { name: 'Pizza Flour' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Pizza Flour' }));
  await user.type(sheet.getByRole('textbox', { name: /Packs received/ }), '2');
  const price = sheet.getByRole('textbox', { name: /Price per pack/ });
  await user.clear(price);
  await user.type(price, '6,550{Enter}');

  expect(screen.queryByRole('dialog')).toBeNull();
  expect(amount()).toContain('50 kg / 25 kg');
  expect(amount()).toContain('Rs 6,550 a pack');
  expect(screen.getByRole('status').textContent).toContain('Received 2 packs of Pizza Flour, price now Rs 6,550 a pack.');
  const events = readAll().filter((e) => e.type.startsWith('stock.'));
  expect(events.map((e) => e.type)).toEqual(['stock.adjusted', 'stock.price_set']);
  expect(events[0]).toMatchObject({ itemId: 'inv-0001', deltaPacks: 2, reason: 'receive' });
  expect(events[1]).toMatchObject({ before: 640000, after: 655000 });

  await user.click(within(screen.getByRole('status')).getByRole('button', { name: 'Undo' }));
  expect(amount()).toContain('0 g / 25 kg');
  expect(amount()).toContain('Rs 6,400 a pack');
});

test('Count opens the blind count: the gap shows only after counting, then the shelf is what was counted', async () => {
  const user = userEvent.setup();
  inventoryStore.adjustStock('inv-0001', 2);
  render(<InventoryView />);
  await user.click(within(flourRow()).getByRole('button', { name: 'Pizza Flour' }));
  await user.click(within(screen.getByRole('dialog', { name: 'Pizza Flour' })).getByRole('button', { name: 'Count' }));
  const form = within(screen.getByRole('form', { name: 'Count Pizza Flour' }));
  expect(screen.queryByText(/expects/)).toBeNull();
  await user.type(form.getByRole('textbox', { name: 'Full packs' }), '1.5');
  await user.click(form.getByRole('button', { name: 'Next' }));
  expect(screen.getByText(/^12.5 kg short · Rs /)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Delivery was short' }));
  await user.click(screen.getByRole('button', { name: 'Close' }));

  expect(amount()).toContain('37.5 kg / 25 kg');
  expect(readAll().at(-1)).toMatchObject({ type: 'stock.counted', counted: 37500, expected: 50000, reason: 'delivery-short' });
});

test('nothing typed, nothing saved: the sheet says what is missing', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  await user.click(within(flourRow()).getByRole('button', { name: 'Pizza Flour' }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByRole('alert').textContent).toContain('Type the packs received, or a new price.');
  expect(readAll()).toHaveLength(0);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('search finds by ingredient, category or supplier; Escape clears it', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  const search = screen.getByRole('searchbox', { name: 'Search inventory' });
  await user.type(search, 'mozz');
  const names = () => within(screen.getByRole('main', { name: 'Inventory' })).getAllByRole('heading').map((h) => h.textContent);
  expect(names().every((n) => /mozzarella/i.test(n ?? ''))).toBe(true);
  await user.clear(search);
  await user.type(search, 'nothing like this');
  expect(screen.getByText(/No ingredients match/)).toBeTruthy();
  await user.keyboard('{Escape}');
  expect(names()).toHaveLength(SEED_INVENTORY.length);
});

// ----- fewer buttons (SCRUM-92) -----

test('Delivery came: pick the supplier, +1 or type each line, one Save; Undo takes the whole delivery back', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  await user.click(screen.getByRole('button', { name: 'Delivery came' }));
  await user.click(within(screen.getByRole('group', { name: 'Supplier' })).getByRole('button', { name: 'Ajantha (Wholesale)' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Delivery from Ajantha (Wholesale)' }));
  expect(sheet.queryByText('Mushrooms')).toBeNull(); // only what this supplier brings
  await user.click(sheet.getByRole('button', { name: 'One more pack of Pizza Flour' }));
  await user.click(sheet.getByRole('button', { name: 'One more pack of Pizza Flour' }));
  expect(sheet.getByRole('textbox', { name: 'Packs of Pizza Flour' })).toHaveProperty('value', '2');
  const second = sheet.getAllByRole('textbox').find((t) => t.getAttribute('aria-label') !== 'Packs of Pizza Flour')!;
  await user.type(second, '1');
  await user.click(sheet.getByRole('button', { name: 'Save delivery' }));

  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('Delivery from Ajantha (Wholesale): 2 items in.');
  expect(amount()).toContain('50 kg / 25 kg');
  expect(readAll().filter((e) => e.type === 'stock.adjusted')).toHaveLength(2);
  await user.click(within(screen.getByRole('status')).getByRole('button', { name: 'Undo' }));
  expect(amount()).toContain('0 g / 25 kg');
});

test('Order shows only on a low item: the message is written, packs change, WhatsApp opens with it', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  expect(within(flourRow()).queryByRole('button', { name: 'Order Pizza Flour' })).toBeNull();
  act(() => inventoryStore.adjustStock('inv-0001', 1)); // 1 pack: low
  await user.click(within(flourRow()).getByRole('button', { name: 'Order Pizza Flour' }));
  const sheet = within(screen.getByRole('dialog', { name: /^Order from / }));
  await user.click(sheet.getByRole('button', { name: 'One pack more of Pizza Flour' }));
  expect(sheet.getByLabelText('Message').textContent).toBe('Hi, this is CheesyBeez. Please send:\n2 × Pizza Flour (25 kg packs)\nThank you.');
  expect(sheet.getByText(/^No phone saved for /)).toBeTruthy();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('a tap anywhere on the row opens the item', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  await user.click(flourRow().querySelector('.inv-row__price')!);
  expect(screen.getByRole('dialog', { name: 'Pizza Flour' })).toBeTruthy();
});
