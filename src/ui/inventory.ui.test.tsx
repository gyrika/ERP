import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as inventoryStore from '../services/inventoryStore.ts';
import { addEvents, appendEvent, markRejected, readAll } from './eventLog.ts';
import * as authService from '../services/auth.ts';
import { SEED_INVENTORY } from '../domain/inventoryData.ts';
import { InventoryView } from './InventoryView.tsx';
import { SupplierView } from './SupplierView.tsx';

beforeEach(() => localStorage.clear());

/** A stock row as the screens get it. */
const stocked = (item: (typeof SEED_INVENTORY)[number], packs: number): inventoryStore.InventoryRow =>
  ({ ...item, onHandPacks: packs, onHandBaseUnits: packs * item.packQty, archived: false, counted: true, usedPerDay: 0, suggestedPacks: 0, suggestedSupplierId: null, lastsDays: null, missedSales: 0, lastCountedAt: null, units: [], tier: null, receiveUnit: null });
afterEach(cleanup);

/** The last thing the shop did: not the number the server gives it afterwards. */
const lastEvent = () => readAll().filter((e) => e.type !== 'stock.numbered').at(-1);
const DAY = 24 * 60 * 60 * 1000;
/** Yesterday's sales: `qty` large margheritas, 222 g of flour each, so flour has a rate of use (7.9 kg a day for 500). */
const sellPizzas = (qty: number) => appendEvent({
  type: 'order.sent', at: Date.now() - DAY, orderNumber: 1001, actor: { id: 'n', name: 'Nimal', role: 'cashier' }, ticketId: 't-sales', addOn: false,
  lines: [{ id: 'l-sales', itemId: 'margherita', qty, size: 'L', adds: [], outs: [], sent: true }],
});
/** Puts exactly this many packs of flour on the shelf, whatever the sales took off. */
const shelfPacks = (packs: number) => {
  const flour = inventoryStore.readItems().find((i) => i.id === 'inv-0001')!;
  inventoryStore.adjustStock('inv-0001', packs - flour.onHandBaseUnits / flour.packQty);
};

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

test('the stock status follows the reorder rule live as packs are counted', () => {
  sellPizzas(500); // flour: 7.9 kg a day, so it is Low until 5 days of it (39.7 kg) are in hand
  render(<InventoryView />);
  const flour = screen.getByRole('heading', { name: 'Pizza Flour' }).closest('article')!;
  const status = () => flour.querySelector('.inv-row__status')!.textContent;

  expect(status()).toBe('Not counted yet'); // unknown, never shown as out
  act(() => shelfPacks(1));
  act(() => shelfPacks(0));
  expect(status()).toBe('Out of stock');
  act(() => shelfPacks(1));
  expect(status()).toBe('Low stock');
  act(() => shelfPacks(2));
  expect(status()).toBe('In stock');
  expect(within(flour).getByLabelText('Available stock and pack size').textContent).toContain('2 packs · 50 kg');
});

test('counted stock survives a reload', () => {
  inventoryStore.adjustStock('inv-0001', 2);
  const { unmount } = render(<InventoryView />);
  unmount();
  render(<InventoryView />);

  const flour = screen.getByRole('heading', { name: 'Pizza Flour' }).closest('article')!;
  expect(within(flour).getByLabelText('Available stock and pack size').textContent).toContain('2 packs · 50 kg');
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
  expect(within(row).getByLabelText('Available stock and pack size').textContent).toContain('½ pack · 12.4 kg');
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
  const flour = { ...stocked(SEED_INVENTORY[0], 1), missedSales: 4, suggestedPacks: 2 };
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

const flourRow = () => within(screen.getByRole('main', { name: 'Inventory' })).getByRole('heading', { name: 'Pizza Flour' }).closest('article')!;
const amount = () => within(flourRow()).getByLabelText('Available stock and pack size').textContent;

test("the item's Order tab is the same purchase order: Place order makes a PO, then the item shows it is on order", async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  await user.click(within(flourRow()).getByRole('button', { name: 'Pizza Flour' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Pizza Flour' }));
  await user.click(sheet.getByRole('tab', { name: 'Order' }));
  expect(sheet.queryByRole('textbox', { name: /Packs received/ })).toBeNull(); // stock comes in only by GRN
  const card = within(sheet.getByRole('region', { name: 'Order from Prima / David Stores (Wholesale)' }));
  expect(card.getByLabelText('Packs of Pizza Flour').textContent).toBe('1');
  await user.click(card.getByRole('button', { name: 'One pack more of Pizza Flour' }));
  await user.click(card.getByRole('button', { name: 'Place order' }));

  expect(lastEvent()).toMatchObject({ type: 'stock.ordered', lines: [{ itemId: 'inv-0001', packs: 2 }] });
  expect(readAll().find((e) => e.type === 'stock.numbered')).toMatchObject({ docId: lastEvent()!.id, kind: 'PO', number: 'PO-0001' }); // no server here: this device numbers it
  expect(sheet.getByLabelText('Message').textContent).toContain('2 × Pizza Flour (25 kg packs)');
  expect(sheet.getByRole('status').textContent).toContain('PO-0001 placed with Prima / David Stores (Wholesale).');
  await user.keyboard('{Escape}');
  expect(within(flourRow()).getByText('On order 2 · PO-0001')).toBeTruthy();

  // Opened again: the open PO, not a second order.
  await user.click(within(flourRow()).getByRole('button', { name: 'Pizza Flour' }));
  await user.click(screen.getByRole('tab', { name: 'Order' }));
  expect(screen.queryByRole('button', { name: 'Place order' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Cancel PO-0001' })).toBeTruthy();
});

test('the price the supplier charges is changed on the Order tab, audited, with Undo', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  await user.click(within(flourRow()).getByRole('button', { name: 'Pizza Flour' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Pizza Flour' }));
  await user.click(sheet.getByRole('tab', { name: 'Order' }));
  const price = sheet.getByRole('textbox', { name: /Price per pack/ });
  await user.clear(price);
  await user.type(price, '6,550{Enter}');
  expect(lastEvent()).toMatchObject({ type: 'stock.price_set', before: 640000, after: 655000 });
  expect(sheet.getByRole('status').textContent).toContain('Pizza Flour: price now Rs 6,550 a pack.');
  await user.click(within(sheet.getByRole('status')).getByRole('button', { name: 'Undo' }));
  expect(lastEvent()).toMatchObject({ type: 'stock.price_set', before: 655000, after: 640000 });
});

test('Count opens the blind count: the gap shows only after counting, then the shelf is what was counted', async () => {
  const user = userEvent.setup();
  inventoryStore.adjustStock('inv-0001', 2);
  render(<InventoryView />);
  await user.click(within(flourRow()).getByRole('button', { name: 'Pizza Flour' }));
  const form = within(screen.getByRole('form', { name: 'Count Pizza Flour' }));
  expect(screen.queryByText(/expects/)).toBeNull();
  await user.type(form.getByRole('textbox', { name: 'Full packs' }), '1.5');
  await user.click(form.getByRole('button', { name: 'Next' }));
  expect(screen.getByText(/^12.5 kg short · Rs /)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Wrong entry' }));
  await user.click(screen.getByRole('button', { name: 'Close' }));

  expect(amount()).toContain('1½ packs · 37.5 kg');
  expect(lastEvent()).toMatchObject({ type: 'stock.counted', counted: 37500, expected: 50000, reason: 'wrong-entry' });
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

test('Purchase orders: a draft per supplier from what runs low; Place order saves the PO; Cancel has Undo', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  expect(within(flourRow()).queryByRole('button', { name: /^Order/ })).toBeNull(); // no Order button on rows
  sellPizzas(500);
  act(() => shelfPacks(1)); // 25 kg against 7.9 kg a day: 5 days need 39.7 kg, so it is low
  await user.click(screen.getByRole('button', { name: /^Purchase orders/ }));
  const card = within(screen.getByRole('region', { name: 'Order from Prima / David Stores (Wholesale)' }));
  expect(card.getByLabelText('Packs of Pizza Flour').textContent).toBe('3'); // 10 days of use (79.5 kg) less 25 kg = 2.2 packs, rounded up
  await user.click(card.getByRole('button', { name: 'One pack less of Pizza Flour' }));
  await user.click(card.getByRole('button', { name: 'Place order' }));

  expect(lastEvent()).toMatchObject({ type: 'stock.ordered', supplierId: expect.any(String), lines: [{ itemId: 'inv-0001', packs: 2 }] });
  expect(readAll().find((e) => e.type === 'stock.numbered')).toMatchObject({ kind: 'PO', number: 'PO-0001' });
  const placed = within(screen.getByRole('region', { name: /^PO-0001 / }));
  expect(placed.getByLabelText('Message').textContent).toBe('Hi, this is CheesyBeez. Please send:\n2 × Pizza Flour (25 kg packs)\nThank you.');
  await user.click(screen.getByRole('button', { name: 'Cancel PO-0001' }));
  expect(lastEvent()).toMatchObject({ type: 'stock.ordered' }); // a reason first: nothing cancelled yet
  await user.click(within(screen.getByRole('group', { name: 'Why cancel PO-0001' })).getByRole('button', { name: 'Ordered by mistake' }));
  expect(lastEvent()).toMatchObject({ type: 'stock.order_cancelled', reason: 'Ordered by mistake' });
  await user.keyboard('{Escape}');
  await user.click(within(screen.getByRole('status')).getByRole('button', { name: 'Undo' }));
  expect(lastEvent()).toMatchObject({ type: 'stock.order_reopened' });
  expect(within(flourRow()).getByText('On order 2 · PO-0001')).toBeTruthy();
});

test('an item already on an open order is added to it, not ordered twice; the card shows the amount too', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  orderFlour(2);
  await user.click(screen.getByRole('button', { name: /^Purchase orders/ }));
  await user.click(screen.getByRole('button', { name: '+ Prima / David Stores (Wholesale)' }));
  const card = within(screen.getByRole('region', { name: 'Order from Prima / David Stores (Wholesale)' }));
  await user.selectOptions(card.getByRole('combobox', { name: /^Add an item from/ }), 'inv-0001');
  expect(card.getByText('1 × 25 kg = 25 kg')).toBeTruthy(); // packs and what they come to
  expect(card.getByText('On order · PO-0001')).toBeTruthy();
  expect(card.queryByRole('button', { name: 'Place order' })).toBeNull();
  await user.click(card.getByRole('button', { name: 'Add to PO-0001' }));

  expect(readAll().filter((e) => e.type === 'stock.ordered')).toHaveLength(1); // no second order
  expect(lastEvent()).toMatchObject({ type: 'stock.order_edited', orderId: expect.any(String), lines: [{ itemId: 'inv-0001', packs: 3, stockQty: 75000 }] });
  expect(screen.getByLabelText('Message').textContent).toContain('Please add to PO-0001:\n1 × Pizza Flour');
  await user.click(within(screen.getByRole('status')).getByRole('button', { name: 'Undo' }));
  expect(lastEvent()).toMatchObject({ type: 'stock.order_edited', lines: [{ itemId: 'inv-0001', packs: 2, stockQty: 50000 }] });
});

test('an open order can be changed in its list until goods come; then it is locked', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  orderFlour(2);
  await user.click(screen.getByRole('button', { name: /^Purchase orders/ }));
  await user.click(screen.getByRole('button', { name: 'Edit PO-0001' }));
  await user.click(screen.getByRole('button', { name: 'One pack more of Pizza Flour on PO-0001' }));
  await user.click(screen.getByRole('button', { name: 'Save PO-0001' }));
  expect(lastEvent()).toMatchObject({ type: 'stock.order_edited', lines: [{ itemId: 'inv-0001', packs: 3 }] });
  const onOrder = within(screen.getByRole('region', { name: 'On order' }));
  expect(onOrder.getByText(/3 × Pizza Flour/)).toBeTruthy();
  expect(onOrder.getByText('Open')).toBeTruthy();

  // Goods came (a GRN that waits for the rest): Partly received, and locked.
  const po = readAll().find((e) => e.type === 'stock.ordered')!;
  act(() => {
    appendEvent({
      type: 'stock.grn', at: Date.now(), orderNumber: 0, actor: { id: 'm', name: 'Ravi', role: 'manager' }, orderId: po.id,
      supplierId: 'sup_prima', lines: [{ itemId: 'inv-0001', ordered: 3, received: 1 }], approvedBy: { id: 'm', name: 'Ravi', role: 'manager' }, shortDecision: 'wait',
    });
  });
  expect(onOrder.getByText('Partly received')).toBeTruthy();
  expect(onOrder.getByText(/3 × Pizza Flour \(1 received\)/)).toBeTruthy();
  expect(onOrder.getByText('Goods came: finish it with GRN.')).toBeTruthy();
  expect(onOrder.queryByRole('button', { name: 'Edit PO-0001' })).toBeNull();
  expect(onOrder.queryByRole('button', { name: 'Cancel PO-0001' })).toBeNull();
});

test('a paired device shows "PO (pending)" until the shop server numbers it, then the number', async () => {
  const spy = vi.spyOn(authService, 'numbersLocally').mockReturnValue(false); // a server will number it
  const user = userEvent.setup();
  render(<InventoryView />);
  act(() => { inventoryStore.placeOrder('sup_prima', [{ itemId: 'inv-0001', packs: 2 }]); });
  await user.click(screen.getByRole('button', { name: /^Purchase orders/ }));
  const onOrder = within(screen.getByRole('region', { name: 'On order' }));
  expect(onOrder.getByText(/^PO \(pending\) · Prima/)).toBeTruthy();
  expect(readAll().some((e) => e.type === 'stock.numbered')).toBe(false);

  const po = readAll().find((e) => e.type === 'stock.ordered')!;
  act(() => { // the server's record arrives with the next pull
    addEvents([{ id: `num-${po.id}`, shopId: po.shopId, at: Date.now(), orderNumber: 0, actor: { id: 'shop-server', name: 'Shop server', role: 'owner' }, type: 'stock.numbered', docId: po.id, kind: 'PO', number: 'PO-0042' }]);
  });
  expect(onOrder.getByText(/^PO-0042 · Prima/)).toBeTruthy();
  expect(within(flourRow()).getByText('On order 2 · PO-0042')).toBeTruthy();
  spy.mockRestore();
});

test('the shop server refused a GRN: it stops counting, the order is waiting again, and the person is told what to do', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  orderFlour(2);
  await user.click(screen.getByRole('button', { name: 'GRN' }));
  await user.click(screen.getByRole('button', { name: 'Save GRN' }));
  await user.keyboard('{Escape}');
  expect(amount()).toContain('2 packs · 50 kg');

  // Another device had already received that order: the server's answer comes back with the next push.
  const grn = readAll().find((e) => e.type === 'stock.grn')!;
  act(() => markRejected([{ id: grn.id, reason: 'PO-0001 is closed: nothing more can be received on it.' }]));
  expect(screen.getByRole('alert').textContent).toBe('The GRN was not saved: PO-0001 is closed: nothing more can be received on it.OK');
  expect(amount()).toContain('Not counted yet'); // its stock never happened
  expect(screen.getByRole('button', { name: /^Purchase orders/ })).toBeTruthy();

  await user.click(within(screen.getByRole('alert')).getByRole('button', { name: 'OK' }));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(amount()).toContain('Not counted yet'); // reading it does not bring it back
  await user.click(screen.getByRole('button', { name: 'GRN' }));
  expect(screen.getByRole('dialog', { name: /PO-0001$/ })).toBeTruthy(); // the order is waiting again
});

test('the stock area opens on four big buttons: Inventory, Purchase orders, GRN, Count — each says what waits', async () => {
  const user = userEvent.setup();
  sellPizzas(500);
  render(<InventoryView />);
  const tiles = within(screen.getByRole('navigation', { name: 'Stock' }));
  expect(tiles.getAllByRole('button').map((b) => b.getAttribute('aria-label')?.replace(/\(\d+/, '(n'))).toEqual(['Inventory', 'Purchase orders', 'GRN', 'Count (n due)']);
  expect(tiles.getByRole('button', { name: 'Inventory' }).getAttribute('aria-current')).toBe('page');
  expect(tiles.getByRole('button', { name: 'GRN' }).textContent).toContain('None waiting');
  expect(tiles.getByRole('button', { name: 'Purchase orders' }).textContent).toContain('Nothing to order');

  act(() => shelfPacks(1)); // low: flour needs ordering
  expect(tiles.getByRole('button', { name: 'Purchase orders (1)' }).textContent).toContain('1 to order');
  await user.click(tiles.getByRole('button', { name: 'Purchase orders (1)' }));
  expect(screen.getByRole('dialog', { name: 'Purchase orders' })).toBeTruthy();
  await user.keyboard('{Escape}');
  orderFlour(3);
  expect(tiles.getByRole('button', { name: 'GRN' }).textContent).toContain('1 waiting');
  await user.click(tiles.getByRole('button', { name: /^Count/ }));
  expect(screen.getByRole('dialog')).toBeTruthy(); // the count flow, for what is due
});

test('filter chips: All, Low, Out, On order show only what needs a look', async () => {
  const user = userEvent.setup();
  sellPizzas(500);
  render(<InventoryView />);
  act(() => shelfPacks(1)); // flour: low
  const names = () => within(screen.getByRole('main', { name: 'Inventory' })).queryAllByRole('heading').map((h) => h.textContent);
  const chips = within(screen.getByRole('group', { name: 'Show' }));
  expect(chips.getAllByRole('button').map((b) => b.textContent)).toEqual(['All', 'Low', 'Out', 'On order']);
  expect(chips.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
  expect(names().length).toBe(SEED_INVENTORY.length);

  await user.click(chips.getByRole('button', { name: 'Low' }));
  expect(names()).toEqual(['Pizza Flour']);
  await user.click(chips.getByRole('button', { name: 'Out' }));
  expect(names()).toEqual([]);
  expect(screen.getByText('Nothing here. Everything is fine, or choose All.')).toBeTruthy();
  act(() => shelfPacks(0));
  expect(names()).toEqual(['Pizza Flour']);
  await user.click(chips.getByRole('button', { name: 'On order' }));
  expect(names()).toEqual([]);
  orderFlour(2);
  expect(names()).toEqual(['Pizza Flour']);
  // A filter and the search work together.
  await user.type(screen.getByRole('searchbox', { name: 'Search inventory' }), 'mozz');
  expect(names()).toEqual([]);
  await user.click(chips.getByRole('button', { name: 'All' }));
  expect(names().every((n) => /mozzarella/i.test(n ?? ''))).toBe(true);
});

test('an item opens on Details, or on Order when it needs ordering; the tabs are Details, Order, History', async () => {
  const user = userEvent.setup();
  sellPizzas(500);
  render(<InventoryView />);
  await user.click(within(flourRow()).getByRole('button', { name: 'Pizza Flour' }));
  let sheet = within(screen.getByRole('dialog', { name: 'Pizza Flour' }));
  expect(sheet.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Details', 'Order', 'History']);
  expect(sheet.getByRole('tab', { name: 'Details' }).getAttribute('aria-selected')).toBe('true');
  expect(sheet.getByLabelText('About this item')).toBeTruthy(); // the story is on Details
  expect(sheet.getByRole('form', { name: 'Count Pizza Flour' })).toBeTruthy(); // and so is counting it
  await user.click(sheet.getByRole('tab', { name: 'Order' }));
  expect(sheet.queryByLabelText('About this item')).toBeNull();
  await user.keyboard('{Escape}');

  act(() => shelfPacks(1)); // low: it needs ordering
  await user.click(within(flourRow()).getByRole('button', { name: 'Pizza Flour' }));
  sheet = within(screen.getByRole('dialog', { name: 'Pizza Flour' }));
  expect(sheet.getByRole('tab', { name: 'Order' }).getAttribute('aria-selected')).toBe('true');
});

/** Orders 2 packs of flour from its first supplier. */
const orderFlour = (packs = 2) => act(() => { inventoryStore.placeOrder('sup_prima', [{ itemId: 'inv-0001', packs }]); });

test('Goods receiving offers only open orders and only what was ordered; as ordered saves without a PIN', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  await user.click(screen.getByRole('button', { name: 'GRN' }));
  expect(screen.getByText(/^Nothing on order/)).toBeTruthy();
  await user.keyboard('{Escape}');

  orderFlour();
  await user.click(screen.getByRole('button', { name: 'GRN' }));
  const sheet = within(screen.getByRole('dialog', { name: /^Goods from .* · PO-0001$/ }));
  expect(within(sheet.getByRole('list', { name: 'What came' })).getAllByRole('listitem')).toHaveLength(1);
  expect(sheet.getByRole('textbox', { name: 'Packs of Pizza Flour' })).toHaveProperty('value', '2');
  await user.click(sheet.getByRole('button', { name: 'Save GRN' }));
  expect(within(screen.getByRole('dialog', { name: 'GRN' })).getByRole('status').textContent).toMatch(/^GRN-0001 from .* saved\./);
  await user.keyboard('{Escape}');

  expect(screen.getByRole('status').textContent).toMatch(/^GRN-0001 from .* saved\./);
  const grn = readAll().find((e) => e.type === 'stock.grn')!;
  // One record carries what was owed, what came and what went into stock; no separate movement.
  expect(grn).toMatchObject({ type: 'stock.grn', approvedBy: null, lines: [{ itemId: 'inv-0001', ordered: 2, received: 2, accepted: 2, returned: 0 }] });
  expect(readAll().some((e) => e.type === 'stock.movement')).toBe(false);
  expect(readAll().find((e) => e.type === 'stock.numbered' && e.kind === 'GRN')).toMatchObject({ docId: grn.id, number: 'GRN-0001' });
  expect(amount()).toContain('2 packs · 50 kg');
  await user.click(screen.getByRole('button', { name: 'GRN' }));
  expect(screen.getByText(/^Nothing on order/)).toBeTruthy(); // the order is closed
  await user.keyboard('{Escape}');

  // Undo: a manager's PIN (a cashier's is refused), then why. The GRN stays listed, marked undone.
  await user.click(screen.getByRole('button', { name: 'GRN' }));
  await user.click(screen.getByRole('button', { name: 'Undo GRN-0001' }));
  await user.type(screen.getByLabelText('Manager PIN', { selector: 'input' }), '1111');
  expect(screen.getByRole('alert').textContent).toContain('PIN not accepted');
  await user.type(screen.getByLabelText('Manager PIN', { selector: 'input' }), '2580');
  expect(readAll().some((e) => e.type === 'stock.grn_undone')).toBe(false); // the PIN alone undoes nothing
  await user.click(within(screen.getByRole('group', { name: 'Reason' })).getByRole('button', { name: 'Entered by mistake' }));
  expect(lastEvent()).toMatchObject({ type: 'stock.grn_undone', grnId: grn.id, reason: 'Entered by mistake', approvedBy: { name: 'Ravi', role: 'manager' } });
  await user.keyboard('{Escape}');
  expect(amount()).toContain('Empty');
  await user.click(screen.getByRole('button', { name: 'GRN' }));
  await user.click(screen.getByRole('button', { name: 'Recent GRNs' })); // one open order: straight into it; the list is a tap away
  expect(screen.getByText(/· Undone: Entered by mistake/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Undo GRN-0001' })).toBeNull(); // once
  await user.click(screen.getByRole('button', { name: /PO-0001 · expected/ })); // the order is open again
  expect(screen.getByRole('dialog', { name: /PO-0001$/ })).toBeTruthy();
});

test('a short delivery shows as short and needs a manager PIN; a wrong PIN saves nothing', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  orderFlour();
  await user.click(screen.getByRole('button', { name: 'GRN' }));
  const field = screen.getByRole('textbox', { name: 'Packs of Pizza Flour' });
  await user.clear(field);
  await user.type(field, '1');
  expect(screen.getByLabelText('Pizza Flour: short').textContent).toBe('short −1');
  await user.click(screen.getByRole('button', { name: 'Manager approves' }));

  await user.type(screen.getByLabelText('Manager PIN', { selector: 'input' }), '1111');
  expect(screen.getByRole('alert').textContent).toContain('PIN not accepted');
  expect(readAll().some((e) => e.type === 'stock.grn')).toBe(false);

  await user.type(screen.getByLabelText('Manager PIN', { selector: 'input' }), '2580');
  // The PIN alone saves nothing: the manager sees the difference and decides.
  expect(readAll().some((e) => e.type === 'stock.grn')).toBe(false);
  const decide = within(screen.getByRole('region', { name: 'Manager decision' }));
  expect(decide.getByText('short −1')).toBeTruthy();

  // Don't approve: nothing saved, back to the amounts, with what to do next.
  await user.click(decide.getByRole('button', { name: "Don't approve" }));
  expect(readAll().some((e) => e.type === 'stock.grn')).toBe(false);
  expect(screen.getByRole('alert').textContent).toContain('Not approved: nothing was saved.');
  expect(screen.getByRole('textbox', { name: 'Packs of Pizza Flour' })).toHaveProperty('value', '1');

  // Approve: saved with the approver on the record, never on the screen; back to the GRN list.
  await user.click(screen.getByRole('button', { name: 'Manager approves' }));
  await user.type(screen.getByLabelText('Manager PIN', { selector: 'input' }), '2580');
  // The manager must choose what happens to the short line before Approve works.
  expect(screen.getByRole('button', { name: 'Approve' })).toHaveProperty('disabled', true);
  await user.click(within(screen.getByRole('group', { name: 'Short lines' })).getByRole('button', { name: 'Close order' }));
  await user.click(screen.getByRole('button', { name: 'Approve' }));
  expect(readAll().find((e) => e.type === 'stock.grn')).toMatchObject({ approvedBy: { name: 'Ravi', role: 'manager' }, shortDecision: 'close', lines: [{ ordered: 2, received: 1, accepted: 1 }] });
  const grn = screen.getByRole('dialog', { name: 'GRN' });
  expect(within(grn).getByText(/^Nothing on order/)).toBeTruthy();
  expect(within(grn).getByRole('status').textContent).toBe('GRN-0001 from Prima / David Stores (Wholesale) saved, approved by a manager.Undo');
  expect(document.body.textContent).not.toContain('Ravi');
  await user.keyboard('{Escape}');
  expect(amount()).toContain('1 pack');
});

test('Received everything fills every line with what is still owed', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  orderFlour(3);
  await user.click(screen.getByRole('button', { name: 'GRN' }));
  const field = screen.getByRole('textbox', { name: 'Packs of Pizza Flour' });
  await user.clear(field);
  await user.type(field, '1');
  expect(screen.getByRole('button', { name: 'Manager approves' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Received everything' }));
  expect(field).toHaveProperty('value', '3');
  expect(screen.getByRole('button', { name: 'Save GRN' })).toBeTruthy();
});

test('short + wait: the rest stays on order; the next GRN expects only what is left; only the latest GRN can be undone', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  orderFlour(4);
  await user.click(screen.getByRole('button', { name: 'GRN' }));
  const field = screen.getByRole('textbox', { name: 'Packs of Pizza Flour' });
  await user.clear(field);
  await user.type(field, '1');
  await user.click(screen.getByRole('button', { name: 'Manager approves' }));
  await user.type(screen.getByLabelText('Manager PIN', { selector: 'input' }), '2580');
  await user.click(screen.getByRole('button', { name: 'Wait for the rest' }));
  await user.click(screen.getByRole('button', { name: 'Approve' }));
  expect(readAll().find((e) => e.type === 'stock.grn')).toMatchObject({ shortDecision: 'wait', lines: [{ ordered: 4, received: 1, accepted: 1 }] });

  // Still on the list, now Partly received; the rest (3) is what the next GRN expects.
  await user.click(screen.getByRole('button', { name: /PO-0001 · expected .* · partly received/ }));
  expect(screen.getByRole('textbox', { name: 'Packs of Pizza Flour' })).toHaveProperty('value', '3');
  expect(screen.getByText('expected 3 packs')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Save GRN' }));
  expect(amount()).toContain('4 packs · 100 kg');
  expect(screen.getByText(/^Nothing on order/)).toBeTruthy(); // everything came: closed

  // Two GRNs stand against PO-0001: only the latest has an Undo.
  expect(screen.queryByRole('button', { name: 'Undo GRN-0001' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Undo GRN-0002' })).toBeTruthy();
});

test('over + return: only what was owed goes into stock, the extra is recorded as returned', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  orderFlour(2);
  await user.click(screen.getByRole('button', { name: 'GRN' }));
  const field = screen.getByRole('textbox', { name: 'Packs of Pizza Flour' });
  await user.clear(field);
  await user.type(field, '3');
  await user.click(screen.getByRole('button', { name: 'Manager approves' }));
  await user.type(screen.getByLabelText('Manager PIN', { selector: 'input' }), '2580');
  expect(screen.getByRole('button', { name: 'Approve' })).toHaveProperty('disabled', true);
  await user.click(within(screen.getByRole('group', { name: 'Extra lines' })).getByRole('button', { name: 'Return extra' }));
  await user.click(screen.getByRole('button', { name: 'Approve' }));
  expect(readAll().find((e) => e.type === 'stock.grn')).toMatchObject({ overDecision: 'return', lines: [{ ordered: 2, received: 3, accepted: 2, returned: 1 }] });
  await user.keyboard('{Escape}');
  expect(amount()).toContain('2 packs · 50 kg');
});

test('more than ordered shows as over', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  orderFlour();
  await user.click(screen.getByRole('button', { name: 'GRN' }));
  const field = screen.getByRole('textbox', { name: 'Packs of Pizza Flour' });
  await user.clear(field);
  await user.type(field, '4');
  expect(screen.getByLabelText('Pizza Flour: over').textContent).toBe('over +2');
});

test('a tap anywhere on the row opens the item', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  await user.click(flourRow().querySelector('.inv-row__quantity')!);
  expect(screen.getByRole('dialog', { name: 'Pizza Flour' })).toBeTruthy();
});

// ----- the item's story (SCRUM-93) -----

test('never a fake zero: an item not counted yet shows no amount, only its pack size', () => {
  render(<InventoryView />);
  const text = within(flourRow()).getByLabelText('Available stock and pack size').textContent;
  expect(text).toBe('Not counted yet25 kg a pack');
  expect(within(flourRow()).getByText(/never counted/)).toBeTruthy();
});

test("the sheet tells the item's whole story: shelf, last delivery, price change, what uses it", async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  await user.click(within(flourRow()).getByRole('button', { name: 'Pizza Flour' }));
  let story = within(screen.getByRole('dialog', { name: 'Pizza Flour' }).querySelector('dl')!);
  expect(story.getByText('Not counted yet: count it once to start')).toBeTruthy();
  expect(story.getByText('Never')).toBeTruthy();
  expect(story.getByText('None recorded yet')).toBeTruthy();
  expect(story.getByText(/^\d+ menu items: /)).toBeTruthy();

  await user.keyboard('{Escape}');
  act(() => { inventoryStore.adjustStock('inv-0001', 2, 'receive'); inventoryStore.setWorkingPrice('inv-0001', 655000); });
  await user.click(within(flourRow()).getByRole('button', { name: 'Pizza Flour' }));
  story = within(screen.getByRole('dialog', { name: 'Pizza Flour' }).querySelector('dl')!);
  expect(story.getByText('2 packs · 50 kg')).toBeTruthy();
  expect(story.getByText(/^today · 2 packs · /)).toBeTruthy();
  expect(story.getByText('↑ Rs 150 today')).toBeTruthy();
});

// ----- what receiving is counted in (SCRUM-96) -----

test('the owner, with his PIN, makes flour received in kg; the sheet and the price follow', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  await user.click(within(flourRow()).getByRole('button', { name: 'Pizza Flour' }));
  let sheet = within(screen.getByRole('dialog', { name: 'Pizza Flour' }));
  await user.click(sheet.getByRole('tab', { name: 'Order' }));
  expect(sheet.getByText('packs of 25 kg')).toBeTruthy();
  await user.click(sheet.getByRole('button', { name: 'Change' }));
  await user.type(sheet.getByLabelText('Owner PIN'), '2580'); // the manager's: refused
  expect(sheet.getByRole('alert').textContent).toBe('Only the owner chooses how it is received.');
  await user.type(sheet.getByLabelText('Owner PIN'), '9999');
  await user.click(within(sheet.getByRole('group', { name: 'Received in' })).getByRole('button', { name: 'kg' }));
  expect(lastEvent()).toMatchObject({ type: 'stock.receive_unit_set', unit: 'kg', actor: { role: 'owner' } });

  sheet = within(screen.getByRole('dialog', { name: 'Pizza Flour' }));
  expect(sheet.getByRole('textbox', { name: /Price per kg/ })).toHaveProperty('value', '256');
  await user.keyboard('{Escape}');

  // The GRN takes flour in kg: 2 packs ordered is 50 kg; 12.5 kg came, short, approved.
  orderFlour();
  await user.click(screen.getByRole('button', { name: 'GRN' }));
  const field = screen.getByRole('textbox', { name: 'kg of Pizza Flour' });
  expect(field).toHaveProperty('value', '50');
  await user.clear(field);
  await user.type(field, '12.5');
  await user.click(screen.getByRole('button', { name: 'Manager approves' }));
  await user.type(screen.getByLabelText('Manager PIN', { selector: 'input' }), '2580');
  await user.click(screen.getByRole('button', { name: 'Close order' }));
  await user.click(screen.getByRole('button', { name: 'Approve' }));
  await user.keyboard('{Escape}');
  expect(readAll().find((e) => e.type === 'stock.grn')).toMatchObject({ lines: [{ ordered: 2, received: 0.5, accepted: 0.5 }] });
  expect(amount()).toContain('½ pack · 12.5 kg');
});

// ----- the sheet's tabs stay in the sheet; history (SCRUM-97) -----

test('Count happens inside the item sheet, then History shows it with the delivery before it', async () => {
  const user = userEvent.setup();
  inventoryStore.adjustStock('inv-0001', 2, 'receive');
  render(<InventoryView />);
  await user.click(within(flourRow()).getByRole('button', { name: 'Pizza Flour' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Pizza Flour' }));
  await user.type(sheet.getByRole('textbox', { name: 'Full packs' }), '1.5');
  await user.click(sheet.getByRole('button', { name: 'Next' }));
  await user.click(sheet.getByRole('button', { name: 'Spoiled or expired' }));

  // Still the same sheet: now on History, newest first.
  expect(screen.getByRole('dialog', { name: 'Pizza Flour' })).toBeTruthy();
  expect(sheet.getByRole('tab', { name: 'History' }).getAttribute('aria-selected')).toBe('true');
  expect(sheet.getByRole('status').textContent).toMatch(/^Counted: gap of Rs [\d,]+ saved\./);
  const items = within(sheet.getByRole('list', { name: 'History of Pizza Flour' })).getAllByRole('listitem');
  expect(items.map((li) => li.textContent?.replace(/^today · [A-Z][a-z]+/, ''))).toEqual([
    'Counted 37.5 kg · expected 50 kg · 12.5 kg short (Rs 3,200) · Spoiled or expired',
    'Received 2 packs (50 kg)',
  ]);
  // Undo the count: back on Details, and it leaves the history.
  await user.click(within(sheet.getByRole('status')).getByRole('button', { name: 'Undo' }));
  expect(sheet.getByRole('tab', { name: 'Details' }).getAttribute('aria-selected')).toBe('true');
  await user.click(sheet.getByRole('tab', { name: 'History' }));
  expect(within(sheet.getByRole('list', { name: 'History of Pizza Flour' })).getAllByRole('listitem')).toHaveLength(1);
});
