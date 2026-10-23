import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as inventoryStore from '../services/inventoryStore.ts';
import { addEvents, appendEvent, markRejected, readAll } from './eventLog.ts';
import * as authService from '../services/auth.ts';
import { SEED_INVENTORY } from '../domain/inventoryData.ts';
import { InventoryView } from './InventoryView.tsx';
import { SupplierView } from './SupplierView.tsx';
import { OrderView, ReceiveView } from './WorkViews.tsx';

beforeEach(() => localStorage.clear());

/** A stock row as the screens get it. */
const stocked = (item: (typeof SEED_INVENTORY)[number], packs: number): inventoryStore.InventoryRow =>
  ({ ...item, onHandPacks: packs, onHandBaseUnits: packs * item.packQty, archived: false, counted: true, usedPerDay: 0, suggestedPacks: 0, suggestedSupplierId: null, lastsDays: null, missedSales: 0, lastCountedAt: null, units: [], tier: null, receiveUnit: null, orderBelowPacks: null });
afterEach(() => { cleanup(); vi.restoreAllMocks(); receivePage = null; orderPage = null; });

/**
 * Receive and Order are places of their own in the menu (Shop Day Navigation), with the flow in
 * the page. These open them beside the stock list, fresh each time, as a click on the menu would.
 */
let receivePage: ReturnType<typeof render> | null = null;
let orderPage: ReturnType<typeof render> | null = null;
const openGrn = async (_user: ReturnType<typeof userEvent.setup>) => {
  receivePage?.unmount();
  receivePage = render(<ReceiveView />);
};
const openOrders = async (_user: ReturnType<typeof userEvent.setup>) => {
  orderPage?.unmount();
  orderPage = render(<OrderView />);
};

/** The last thing the shop did: not the number the server gives it afterwards. */
const lastEvent = () => readAll().filter((e) => e.type !== 'stock.numbered' && e.type !== 'stock.draft_set').at(-1);
/** Each supplier's draft order as the events leave it. */
const drafts = () => inventoryStore.readDrafts();
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
  // Take the screen off before the real hook comes back: the shop's shared history can re-render it at any moment.
  cleanup();
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
  // Take the screen off before the real hook comes back: the shop's shared history can re-render it at any moment.
  cleanup();
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
  // Take the screen off before the real hook comes back: the shop's shared history can re-render it at any moment.
  cleanup();
  spy.mockRestore();
});

test('a low item stays Low stock even with missed sales: the shelf can only be lower', () => {
  const flour = { ...stocked(SEED_INVENTORY[0], 1), missedSales: 4, suggestedPacks: 2 };
  const spy = vi.spyOn(inventoryStore, 'useInventory').mockReturnValue({ items: [flour], suppliers: [], untrackedSold: 0 });
  render(<InventoryView />);
  const row = screen.getByRole('heading', { name: 'Pizza Flour' }).closest('article')!;
  expect(within(row).getByText('Low stock')).toBeTruthy();
  expect(screen.queryByText(/took no stock/)).toBeNull();
  // Take the screen off before the real hook comes back: the shop's shared history can re-render it at any moment.
  cleanup();
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
  // Take the screen off before the real hook comes back: the shop's shared history can re-render it at any moment.
  cleanup();
  spy.mockRestore();
});

const flourRow = () => within(screen.getByRole('main', { name: 'Inventory' })).getByRole('heading', { name: 'Pizza Flour' }).closest('article')!;
const amount = () => within(flourRow()).getByLabelText('Available stock and pack size').textContent;

test("the item's Order tab only puts it in a supplier's cart; the Order page edits and places the cart", async () => {
  const user = userEvent.setup();
  const items = render(<InventoryView />);
  await user.click(within(flourRow()).getByRole('button', { name: 'Pizza Flour' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Pizza Flour' }));
  await user.click(sheet.getByRole('tab', { name: 'Order' }));
  expect(sheet.queryByRole('textbox', { name: /Packs received/ })).toBeNull(); // stock comes in only by GRN
  expect(sheet.queryByRole('button', { name: 'Place order' })).toBeNull(); // items only collect; the Order page places
  expect(sheet.getByRole('textbox', { name: 'Packs of Pizza Flour' })).toHaveProperty('value', '1');
  await user.click(sheet.getByRole('button', { name: 'One pack more of Pizza Flour' }));
  await user.click(sheet.getByRole('button', { name: 'Add to cart' }));

  expect(readAll().some((e) => e.type === 'stock.ordered')).toBe(false);
  const prima = 'sup_prima';
  expect(drafts().get(prima)).toEqual({ 'inv-0001': 2 });
  expect(sheet.getByRole('status').textContent).toContain("Added to Prima / David Stores (Wholesale)'s cart · 1 item.");
  expect(within(sheet.getByRole('status')).getByRole('link', { name: 'Open cart' }).getAttribute('href')).toBe(`#order/${prima}`);
  await user.click(within(sheet.getByRole('status')).getByRole('button', { name: 'Undo' }));
  expect(drafts().has(prima)).toBe(false);
  await user.click(sheet.getByRole('button', { name: 'One pack more of Pizza Flour' }));
  await user.click(sheet.getByRole('button', { name: 'Add to cart' }));
  await user.keyboard('{Escape}');

  // Opened again: one line says which cart it is in; nothing to edit here.
  await user.click(within(flourRow()).getByRole('button', { name: 'Pizza Flour' }));
  await user.click(screen.getByRole('tab', { name: 'Order' }));
  expect(screen.getByText(/In Prima \/ David Stores \(Wholesale\)'s cart · 2 packs/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Add to cart' })).toBeNull();
  await user.keyboard('{Escape}');
  expect(within(flourRow()).getByRole('link', { name: 'In cart · Prima / David Stores (Wholesale)' })).toBeTruthy();
  items.unmount();

  // The Order page: the cart is listed, its bill holds the item; a change is kept on leaving.
  await openOrders(user);
  expect(within(screen.getByRole('group', { name: 'Suppliers that need ordering' })).getByRole('listitem').textContent).toContain('Cart · 1 item');
  await user.click(screen.getByRole('button', { name: 'Order from Prima / David Stores (Wholesale)' }));
  const bill = () => within(screen.getByRole('region', { name: 'Order from Prima / David Stores (Wholesale)' }));
  expect(bill().getByRole('textbox', { name: 'Packs of Pizza Flour' })).toHaveProperty('value', '2');
  await user.click(bill().getByRole('button', { name: 'One pack more of Pizza Flour' }));
  expect(drafts().get(prima)).toEqual({ 'inv-0001': 3 });
  await user.click(screen.getByRole('button', { name: 'Back' }));
  await user.click(screen.getByRole('button', { name: 'Order from Prima / David Stores (Wholesale)' }));
  expect(bill().getByRole('textbox', { name: 'Packs of Pizza Flour' })).toHaveProperty('value', '3');

  // Placing it makes the PO and empties the cart; Undo takes the PO back and the cart returns.
  await user.click(screen.getByRole('button', { name: 'Place order' }));
  expect(lastEvent()).toMatchObject({ type: 'stock.ordered', lines: [{ itemId: 'inv-0001', packs: 3 }] });
  expect(drafts().has(prima)).toBe(false);
  await user.click(within(screen.getAllByRole('status').at(-1)!).getByRole('button', { name: 'Undo' }));
  expect(lastEvent()).toMatchObject({ type: 'stock.order_cancelled' });
  expect(drafts().get(prima)).toEqual({ 'inv-0001': 3 });
});

test("a line moves to the item's other supplier's cart, never comes back to the first, and Undo puts both back", async () => {
  const user = userEvent.setup();
  sellPizzas(500);
  render(<InventoryView />);
  act(() => shelfPacks(1)); // flour runs low: it is in Prima's cart by itself
  await openOrders(user);
  await user.click(screen.getByRole('button', { name: 'Order from Prima / David Stores (Wholesale)' }));
  const bill = within(screen.getByRole('region', { name: 'Order from Prima / David Stores (Wholesale)' }));
  expect(bill.getByRole('textbox', { name: 'Packs of Pizza Flour' })).toHaveProperty('value', '3');
  await user.click(bill.getByRole('button', { name: "Move to Ajantha (Wholesale)'s cart" }));

  expect(drafts().get('sup_ajantha')).toEqual({ 'inv-0001': 3 });
  expect(drafts().has('sup_prima')).toBe(false);
  expect(bill.queryByRole('textbox', { name: 'Packs of Pizza Flour' })).toBeNull();
  expect(screen.getByText("Pizza Flour: moved to Ajantha (Wholesale)'s cart.")).toBeTruthy();
  // It is in one cart only: Prima's suggestions no longer hold it.
  await user.click(screen.getByRole('button', { name: "Open Ajantha (Wholesale)'s cart" }));
  expect(within(screen.getByRole('region', { name: 'Order from Ajantha (Wholesale)' })).getByRole('textbox', { name: 'Packs of Pizza Flour' })).toHaveProperty('value', '3');
  await user.click(screen.getByRole('button', { name: 'Back' }));
  const carts = within(screen.getByRole('group', { name: 'Suppliers that need ordering' }));
  expect(carts.getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringContaining('Ajantha')]);

  // Undo, from the bill it left: back in Prima's cart, out of Ajantha's.
  await user.click(screen.getByRole('button', { name: 'Order from Ajantha (Wholesale)' }));
  await user.click(screen.getByRole('button', { name: "Move to Prima / David Stores (Wholesale)'s cart" }));
  await user.click(within(screen.getByText("Pizza Flour: moved to Prima / David Stores (Wholesale)'s cart.")).getByRole('button', { name: 'Undo' }));
  expect(drafts().get('sup_ajantha')).toEqual({ 'inv-0001': 3 });
  expect(within(screen.getByRole('region', { name: 'Order from Ajantha (Wholesale)' })).getByRole('textbox', { name: 'Packs of Pizza Flour' })).toHaveProperty('value', '3');
});

test('+ Cart on a low row puts it in its supplier\'s cart, with Undo; #order/<supplier> opens that cart', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  act(() => {
    // Counted, and empty, with no sales: Out, but the reorder rule has nothing to suggest, so in no cart yet.
    shelfPacks(1);
    const flour = inventoryStore.readItems().find((i) => i.id === 'inv-0001')!;
    inventoryStore.addStockMovement('COUNT_ADJUST', flour.id, -flour.onHandBaseUnits, 'test');
  });
  await user.click(within(flourRow()).getByRole('button', { name: 'Add Pizza Flour to its cart' }));
  expect(drafts().get('sup_prima')).toEqual({ 'inv-0001': 1 });
  const notice = within(screen.getByText(/Pizza Flour: added to Prima \/ David Stores \(Wholesale\)'s cart · 1 item\./));
  expect(notice.getByRole('link', { name: 'Open cart' }).getAttribute('href')).toBe('#order/sup_prima');
  expect(within(flourRow()).getByRole('link', { name: 'In cart · Prima / David Stores (Wholesale)' })).toBeTruthy();
  await user.click(notice.getByRole('button', { name: 'Undo' }));
  expect(drafts().has('sup_prima')).toBe(false);
  expect(within(flourRow()).getByRole('button', { name: 'Add Pizza Flour to its cart' })).toBeTruthy();

  await user.click(within(flourRow()).getByRole('button', { name: 'Add Pizza Flour to its cart' }));
  orderPage?.unmount();
  orderPage = render(<OrderView supplierId="sup_prima" />);
  expect(within(screen.getByRole('region', { name: 'Order from Prima / David Stores (Wholesale)' })).getByRole('textbox', { name: 'Packs of Pizza Flour' })).toHaveProperty('value', '1');
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

test('Purchase orders: a cart per supplier from what runs low; Place order saves the PO; Cancel has Undo', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  expect(within(flourRow()).queryByRole('button', { name: /^Order/ })).toBeNull(); // no Order button on rows
  sellPizzas(500);
  act(() => shelfPacks(1)); // 25 kg against 7.9 kg a day: 5 days need 39.7 kg, so it is low
  await openOrders(user);
  // Step 1: who. The supplier that needs ordering is listed with how many; only its + starts the order.
  const needs = within(screen.getByRole('group', { name: 'Suppliers that need ordering' }));
  expect(needs.getByRole('listitem').textContent).toContain('1 low item');
  expect(needs.getAllByRole('button').map((b) => b.textContent)).toEqual(['+']);
  await user.click(screen.getByRole('button', { name: 'Order from Prima / David Stores (Wholesale)' }));
  // Step 2: what. The suggested packs are in; the one main button is at the bottom.
  const card = within(screen.getByRole('region', { name: 'Order from Prima / David Stores (Wholesale)' }));
  expect(card.getByRole('textbox', { name: 'Packs of Pizza Flour' })).toHaveProperty('value', '3'); // 10 days of use (79.5 kg) less 25 kg = 2.2 packs, rounded up
  expect(card.getByText(/uses about .* a day/)).toBeTruthy();
  await user.click(card.getByRole('button', { name: 'One pack less of Pizza Flour' }));
  await user.click(screen.getByRole('button', { name: 'Place order' }));

  expect(lastEvent()).toMatchObject({ type: 'stock.ordered', supplierId: expect.any(String), lines: [{ itemId: 'inv-0001', packs: 2 }] });
  expect(readAll().find((e) => e.type === 'stock.numbered')).toMatchObject({ kind: 'PO', number: 'PO-0001' });
  // Step 3: send. The message is ready; WhatsApp is the big thing to do.
  const placed = within(screen.getByRole('region', { name: /^PO-0001 / }));
  expect(placed.getByLabelText('Message').textContent).toBe('Hi, this is CheesyBeez. Please send:\n2 × Pizza Flour (25 kg packs)\nThank you.');
  await user.click(screen.getByRole('button', { name: 'Done' }));
  // On order: cancel it, with a reason.
  await openOrders(user);
  // Open orders are first on the Order page, above the suppliers to order from.
  expect(screen.getByRole('region', { name: 'On order' }).compareDocumentPosition(screen.getByRole('group', { name: 'Order from another supplier' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Cancel PO-0001' }));
  expect(lastEvent()).toMatchObject({ type: 'stock.ordered' }); // a reason first: nothing cancelled yet
  await user.click(within(screen.getByRole('group', { name: 'Why cancel PO-0001' })).getByRole('button', { name: 'Ordered by mistake' }));
  expect(lastEvent()).toMatchObject({ type: 'stock.order_cancelled', reason: 'Ordered by mistake' });
  await user.keyboard('{Escape}{Escape}');
  await user.click(within(screen.getByRole('status')).getByRole('button', { name: 'Undo' }));
  expect(lastEvent()).toMatchObject({ type: 'stock.order_reopened' });
  expect(within(flourRow()).getByText('On order 2 · PO-0001')).toBeTruthy();
});

test('several suppliers to order from: one at a time, with how far along you are, then Next supplier', async () => {
  const user = userEvent.setup();
  sellPizzas(500); // flour and sunflower oil (another supplier) both have a rate of use
  render(<InventoryView />);
  act(() => {
    shelfPacks(1);
    const oil = inventoryStore.readItems().find((i) => i.id === 'inv-0022')!;
    inventoryStore.addStockMovement('COUNT_ADJUST', oil.id, -oil.onHandBaseUnits, 'test'); // counted, and empty
  });
  await openOrders(user);
  expect(screen.getByText('Step 1 of 3 · 0 of 2 suppliers done')).toBeTruthy();
  const cards = within(screen.getByRole('group', { name: 'Suppliers that need ordering' })).getAllByRole('button');
  expect(cards).toHaveLength(2);

  await user.click(cards[0]);
  expect(screen.getByText('Step 2 of 3 · What to order')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Place order' }));
  expect(screen.getByText('Step 3 of 3 · Send')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Next supplier' })); // straight to the other one
  expect(screen.getByText('Step 2 of 3 · What to order')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Place order' }));
  expect(readAll().filter((e) => e.type === 'stock.ordered')).toHaveLength(2);
  expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy(); // nobody left
  await user.keyboard('{Enter}');
  // Done starts the page over: everything ordered, nothing waits.
  expect(await screen.findByText('Nothing needs ordering now.')).toBeTruthy();
  expect(screen.getByText('Step 1 of 3 · Who?')).toBeTruthy();
});

test('an item already on an open order is added to it, not ordered twice; the card shows the amount too', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  orderFlour(2);
  await openOrders(user);
  await user.click(screen.getByRole('button', { name: '+ Prima / David Stores (Wholesale)' }));
  const card = within(screen.getByRole('region', { name: 'Order from Prima / David Stores (Wholesale)' }));
  await addItem(user, card, 'Pizza Flour', '1');
  expect(card.getByText('1 × 25 kg = 25 kg')).toBeTruthy(); // packs and what they come to
  expect(card.getByText('On order · PO-0001')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Place order' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Add to PO-0001' }));

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
  await openOrders(user);
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
  await openOrders(user);
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
  await openGrn(user);
  await toReview(user);
  await user.click(screen.getByRole('button', { name: 'Save GRN' }));
  await user.keyboard('{Escape}');
  expect(amount()).toContain('2 packs · 50 kg');

  // Another device had already received that order: the server's answer comes back with the next push.
  const grn = readAll().find((e) => e.type === 'stock.grn')!;
  act(() => markRejected([{ id: grn.id, reason: 'PO-0001 is closed: nothing more can be received on it.' }]));
  // The notice shows on every page that is open (the Receive flow and Items), the same words on each.
  const notices = screen.getAllByRole('alert');
  for (const n of notices) expect(n.textContent).toBe('The GRN was not saved: PO-0001 is closed: nothing more can be received on it.OK');
  expect(amount()).toContain('Not counted yet'); // its stock never happened

  await user.click(within(notices[0]).getByRole('button', { name: 'OK' }));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(amount()).toContain('Not counted yet'); // reading it does not bring it back
  await openGrn(user);
  expect(screen.getByRole('region', { name: /PO-0001$/ })).toBeTruthy(); // the order is waiting again
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

test('the order is a bill (add item, qty, price, totals) and the GRN steps have big − / + buttons and one main button', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  await openOrders(user);
  await user.click(screen.getByRole('button', { name: '+ Prima / David Stores (Wholesale)' }));
  const card = within(screen.getByRole('region', { name: 'Order from Prima / David Stores (Wholesale)' }));
  expect(screen.getByRole('button', { name: 'Place order' })).toHaveProperty('disabled', true); // nothing on it yet
  // + Add item opens the supplier's items; one tap puts it on the bill at 1 pack, nothing more to press.
  await user.click(card.getByRole('button', { name: /^Add an item from/ }));
  await user.click(within(card.getByRole('list', { name: /^Items from/ })).getByRole('button', { name: /^Pizza Flour/ }));
  expect(card.getByRole('textbox', { name: 'Packs of Pizza Flour' })).toHaveProperty('value', '1');
  expect(card.getByLabelText('Total for Pizza Flour').textContent).toBe('Rs 6,400'); // the price of one pack
  expect(screen.getByRole('button', { name: 'Place order' })).toHaveProperty('disabled', false);
  await user.click(card.getByRole('button', { name: 'One pack more of Pizza Flour' }));
  expect(card.getByLabelText('Total for Pizza Flour').textContent).toBe('Rs 12,800');
  await user.click(card.getByRole('button', { name: 'One pack more of Pizza Flour' }));
  expect(card.getByLabelText('Total for Pizza Flour').textContent).toBe('Rs 19,200');
  expect(card.getByLabelText('Order total').textContent).toBe('Rs 19,200');
  expect(card.getByText('1 item · 3 packs')).toBeTruthy();
  // The price is typed over on the line: the total follows; Enter saves the supplier's new price, audited, with Undo.
  const price = card.getByRole('textbox', { name: 'Price of one pack of Pizza Flour' });
  expect(price).toHaveProperty('value', '6,400');
  await user.clear(price);
  await user.type(price, '6550');
  expect(card.getByLabelText('Total for Pizza Flour').textContent).toBe('Rs 19,650');
  await user.keyboard('{Enter}');
  expect(lastEvent()).toMatchObject({ type: 'stock.price_set', itemId: 'inv-0001', before: 640000, after: 655000 });
  expect(card.getByLabelText('Order total').textContent).toBe('Rs 19,650');
  expect(card.getByRole('status').textContent).toContain('Pizza Flour: price now Rs 6,550 a pack.');
  await user.click(within(card.getByRole('status')).getByRole('button', { name: 'Undo' }));
  expect(lastEvent()).toMatchObject({ type: 'stock.price_set', before: 655000, after: 640000 });
  expect(card.getByLabelText('Order total').textContent).toBe('Rs 19,200');
  await user.click(card.getByRole('button', { name: 'Remove Pizza Flour' }));
  expect(card.getByLabelText('Order total').textContent).toBe('Rs 0');
  await addItem(user, card, 'Pizza Flour', '2');
  await user.click(screen.getByRole('button', { name: 'Place order' }));
  await user.click(screen.getByRole('button', { name: 'Done' }));

  await openGrn(user);
  const grn = within(screen.getByRole('region', { name: /PO-0001$/ }));
  expect(grn.getByRole('button', { name: 'One less of Pizza Flour' }).className).toContain('qty__btn');
  await user.click(grn.getByRole('button', { name: 'One less of Pizza Flour' }));
  expect(grn.getByRole('textbox', { name: 'Packs of Pizza Flour' })).toHaveProperty('value', '1');
  expect(grn.getByLabelText('Pizza Flour: short').textContent).toContain('short −1');
  await user.click(grn.getByRole('button', { name: 'One more of Pizza Flour' }));
  await user.click(grn.getByRole('button', { name: 'One more of Pizza Flour' }));
  expect(grn.getByLabelText('Pizza Flour: over').textContent).toContain('over +1');
  await user.click(grn.getByRole('button', { name: 'One less of Pizza Flour' }));
  expect(grn.getByRole('checkbox', { name: 'Pizza Flour came' })).toHaveProperty('ariaChecked', 'true'); // changing it ticked it
  // All ticked: the one main button saves, the totals right under the list.
  expect(grn.getByLabelText('Final total price').textContent).toBe('Rs 12,800');
  expect(grn.getByRole('button', { name: 'Save GRN' })).toBeTruthy();
});

/** Adds an item to the purchase order's bill (one tap) and sets its packs on its line. */
const addItem = async (user: ReturnType<typeof userEvent.setup>, card: ReturnType<typeof within>, name: string, packs: string) => {
  const open = card.getByRole('button', { name: /^Add an item from/ });
  if (open.getAttribute('aria-expanded') !== 'true') await user.click(open); // the list stays open between items
  await user.click(within(card.getByRole('list', { name: /^Items from/ })).getByRole('button', { name: new RegExp(`^${name}`) }));
  const qty = card.getByRole('textbox', { name: `Packs of ${name}` });
  await user.clear(qty);
  await user.type(qty, packs);
};

/** Orders 2 packs of flour from its first supplier. */
const orderFlour = (packs = 2) => act(() => { inventoryStore.placeOrder('sup_prima', [{ itemId: 'inv-0001', packs }]); });

/** Ticks the GRN's items one by one, then reviews (the step with Save GRN / Manager approves). */
const toReview = async (user: ReturnType<typeof userEvent.setup>) => {
  for (let i = 0; i < 20 && !screen.queryByRole('button', { name: /^(Save GRN|Manager approves)$/ }); i++) {
    await user.click(screen.getByRole('button', { name: /^✓ .+ came$/ }));
  }
};
/** Opens the GRN and sets the first item's amount. */
const receive = async (user: ReturnType<typeof userEvent.setup>, amountText: string, name = 'Packs of Pizza Flour') => {
  await openGrn(user);
  const field = screen.getByRole('textbox', { name });
  await user.clear(field);
  await user.type(field, amountText);
  return field;
};

test('GRN: a list ticked one by one; only open orders and only what was ordered; as ordered saves without a PIN', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  await openGrn(user);
  expect(screen.getByText(/^Nothing on order/)).toBeTruthy();
  await user.keyboard('{Escape}');

  orderFlour();
  await openGrn(user);
  const sheet = within(screen.getByRole('region', { name: /^Goods from .* · PO-0001$/ }));
  // Step 2: a list of what was ordered, ticked one by one.
  expect(sheet.getByText('Step 2 of 2 · Check and save')).toBeTruthy();
  expect(within(sheet.getByRole('table', { name: 'Delivery bill' })).getAllByRole('checkbox')).toHaveLength(1);
  expect(sheet.getByText('0 of 1 checked')).toBeTruthy();
  expect(sheet.queryByRole('button', { name: 'Received everything' })).toBeNull(); // every item is checked, no skipping
  expect(sheet.getByRole('textbox', { name: 'Packs of Pizza Flour' })).toHaveProperty('value', '2');
  await user.click(sheet.getByRole('button', { name: '✓ Pizza Flour came' })); // the big button ticks the next item
  expect(sheet.getByRole('checkbox', { name: 'Pizza Flour came' })).toHaveProperty('ariaChecked', 'true');
  expect(sheet.getByText('1 of 1 checked')).toBeTruthy();
  expect(sheet.getByLabelText('Pizza Flour: as ordered')).toBeTruthy();
  // All checked: the bill under the list and Save GRN on the same step.
  expect(sheet.getByRole('table', { name: 'Delivery bill' })).toBeTruthy();
  expect(sheet.getByLabelText('Final total price').textContent).toBe('Rs 12,800');
  await user.click(sheet.getByRole('button', { name: 'Save GRN' }));
  // Done: a tick and what to do next.
  expect(within(screen.getByRole('region', { name: 'GRN' })).getByRole('status').textContent).toContain('GRN-0001 saved');
  await user.keyboard('{Escape}');

  expect(screen.getByRole('status').textContent).toMatch(/^GRN-0001 from .* saved\./);
  const grn = readAll().find((e) => e.type === 'stock.grn')!;
  // One record carries what was owed, what came and what went into stock; no separate movement.
  expect(grn).toMatchObject({ type: 'stock.grn', approvedBy: null, lines: [{ itemId: 'inv-0001', ordered: 2, received: 2, accepted: 2, returned: 0 }] });
  expect(readAll().some((e) => e.type === 'stock.movement')).toBe(false);
  expect(readAll().find((e) => e.type === 'stock.numbered' && e.kind === 'GRN')).toMatchObject({ docId: grn.id, number: 'GRN-0001' });
  expect(amount()).toContain('2 packs · 50 kg');
  await openGrn(user);
  expect(screen.getByText(/^Nothing on order/)).toBeTruthy(); // the order is closed
  await user.keyboard('{Escape}');

  // Undo: a manager's PIN (a cashier's is refused), then why. The GRN stays listed, marked undone.
  await openGrn(user);
  await user.click(screen.getByRole('button', { name: 'Open GRN-0001' })); // GRN history: the document has the Undo
  await user.click(screen.getByRole('button', { name: 'Undo GRN-0001' }));
  await user.type(screen.getByLabelText('Manager PIN', { selector: 'input' }), '1111');
  expect(screen.getByRole('alert').textContent).toContain('PIN not accepted');
  await user.type(screen.getByLabelText('Manager PIN', { selector: 'input' }), '2580');
  expect(readAll().some((e) => e.type === 'stock.grn_undone')).toBe(false); // the PIN alone undoes nothing
  await user.click(within(screen.getByRole('group', { name: 'Reason' })).getByRole('button', { name: 'Entered by mistake' }));
  expect(lastEvent()).toMatchObject({ type: 'stock.grn_undone', grnId: grn.id, reason: 'Entered by mistake', approvedBy: { name: 'Ravi', role: 'manager' } });
  expect(amount()).toContain('Empty');
  expect(screen.getByText(/· Undone: Entered by mistake/)).toBeTruthy(); // the GRN stays listed, marked undone
  expect(screen.queryByRole('button', { name: 'Undo GRN-0001' })).toBeNull(); // once
  await user.keyboard('{Escape}'); // back to the list: the order is open again
  await user.click(screen.getByRole('button', { name: /PO-0001 · expected/ }));
  expect(screen.getByRole('region', { name: /PO-0001$/ })).toBeTruthy();
});

test('GRN step 2 has Back to the list of deliveries, even with one open order', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  orderFlour();
  await openGrn(user);
  expect(screen.getByText('Step 2 of 2 · Check and save')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(screen.getByText('Which delivery came?')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: /PO-0001 · expected/ }));
  expect(screen.getByText('Step 2 of 2 · Check and save')).toBeTruthy();
});

test('GRN shows the order and delivered prices; a changed price is reviewed and approved by a manager', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  orderFlour();
  expect(lastEvent()).toMatchObject({ type: 'stock.ordered', lines: [{ itemId: 'inv-0001', unitPriceCents: 640000 }] });

  await openGrn(user);
  expect(screen.getByText(/Ordered at/)).toBeTruthy();
  const deliveredPrice = screen.getByRole('textbox', { name: 'Delivered price per pack of Pizza Flour' });
  expect(deliveredPrice).toHaveProperty('value', '6,400');
  await user.clear(deliveredPrice);
  await user.type(deliveredPrice, '6500');
  await toReview(user);
  expect(screen.getByRole('button', { name: 'Manager approves' })).toBeTruthy();
  expect(screen.getByLabelText('Final total price').textContent).toBe('Rs 13,000');
  expect(screen.getByLabelText('Pizza Flour: price differs')).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Manager approves' }));
  await user.type(screen.getByLabelText('Manager PIN', { selector: 'input' }), '2580');
  expect(screen.getByRole('table', { name: 'Delivery bill' })).toBeTruthy();
  expect(screen.getByRole('cell', { name: 'Rs 13,000' })).toBeTruthy();
  const managerPrice = screen.getByRole('textbox', { name: 'Delivered price per pack of Pizza Flour' });
  await user.clear(managerPrice);
  await user.type(managerPrice, '6600');
  await user.click(screen.getByRole('button', { name: 'Approve' }));
  const grn = readAll().find((e) => e.type === 'stock.grn')!;
  expect(grn).toMatchObject({ approvedBy: { role: 'manager' }, lines: [{ unitPriceCents: 660000 }] });
  // What it came at is now its price: audited, marked with the GRN; food costs and the next order use it.
  expect(readAll().filter((e) => e.type === 'stock.price_set')).toMatchObject([{ itemId: 'inv-0001', before: 640000, after: 660000, grnId: grn.id }]);
  expect(inventoryStore.readItems().find((i) => i.id === 'inv-0001')!.workingPriceCents).toBe(660000);
  expect(screen.getByText(/1 price updated to what it came at\./)).toBeTruthy();

  // Undoing the GRN puts the old price back.
  await user.keyboard('{Escape}');
  await openGrn(user);
  await user.click(screen.getByRole('button', { name: 'Open GRN-0001' }));
  await user.click(screen.getByRole('button', { name: 'Undo GRN-0001' }));
  await user.type(screen.getByLabelText('Manager PIN', { selector: 'input' }), '2580');
  await user.click(within(screen.getByRole('group', { name: 'Reason' })).getByRole('button', { name: 'Entered by mistake' }));
  expect(readAll().filter((e) => e.type === 'stock.price_set').at(-1)).toMatchObject({ before: 660000, after: 640000, grnId: grn.id });
  expect(inventoryStore.readItems().find((i) => i.id === 'inv-0001')!.workingPriceCents).toBe(640000);
});

test('GRN history: every GRN opens as its document, and Export PDF prints only that document, named after it', async () => {
  const user = userEvent.setup();
  const print = vi.spyOn(window, 'print').mockImplementation(() => {
    expect(document.body.classList.contains('print-grn')).toBe(true);
    expect(document.title).toMatch(/^GRN-0001 /);
  });
  render(<InventoryView />);
  orderFlour();
  await openGrn(user);
  await toReview(user);
  await user.click(screen.getByRole('button', { name: 'Save GRN' }));
  await user.click(screen.getByRole('button', { name: 'View GRN' })); // straight from Done
  const doc = within(screen.getByRole('article', { name: 'GRN-0001 document' }));
  expect(doc.getByText('PO-0001')).toBeTruthy();
  expect(doc.getByRole('cell', { name: 'Pizza Flour' })).toBeTruthy();
  expect(doc.getByLabelText('GRN-0001 final total').textContent).toBe('Rs 12,800');
  const title = document.title;
  await user.click(screen.getByRole('button', { name: 'Export PDF' }));
  expect(print).toHaveBeenCalledOnce();
  window.dispatchEvent(new Event('afterprint'));
  expect(document.body.classList.contains('print-grn')).toBe(false);
  expect(document.title).toBe(title);
  await user.click(screen.getByRole('button', { name: 'Back' })); // to GRN history, with the value on each
  expect(within(screen.getByRole('region', { name: 'GRN history' })).getByRole('button', { name: 'Open GRN-0001' }).textContent).toContain('Rs 12,800');
  print.mockRestore();
});

test('a short delivery shows as short and needs a manager PIN; a wrong PIN saves nothing', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  orderFlour();
  await receive(user, '1');
  expect(screen.getByLabelText('Pizza Flour: short').textContent).toContain('short −1');
  await toReview(user);
  await user.click(screen.getByRole('button', { name: 'Manager approves' }));

  await user.type(screen.getByLabelText('Manager PIN', { selector: 'input' }), '1111');
  expect(screen.getByRole('alert').textContent).toContain('PIN not accepted');
  expect(readAll().some((e) => e.type === 'stock.grn')).toBe(false);

  await user.type(screen.getByLabelText('Manager PIN', { selector: 'input' }), '2580');
  // The PIN alone saves nothing: the manager sees the difference and decides.
  expect(readAll().some((e) => e.type === 'stock.grn')).toBe(false);
  const decide = within(screen.getByRole('region', { name: 'Manager decision' }));
  expect(decide.getByText(/short −1/)).toBeTruthy();
  expect(screen.getByText('Step 3 of 3 · Manager decides')).toBeTruthy();

  // Don't approve: nothing saved, back to the amounts, with what to do next.
  await user.click(screen.getByRole('button', { name: "Don't approve" }));
  expect(readAll().some((e) => e.type === 'stock.grn')).toBe(false);
  expect(screen.getByRole('alert').textContent).toContain('Not approved: nothing was saved.');
  expect(screen.getByRole('textbox', { name: 'Packs of Pizza Flour' })).toHaveProperty('value', '1');

  // Approve: saved with the approver on the record, never on the screen.
  await toReview(user);
  await user.click(screen.getByRole('button', { name: 'Manager approves' }));
  await user.type(screen.getByLabelText('Manager PIN', { selector: 'input' }), '2580');
  // The manager must choose what happens to the short line before Approve works.
  expect(screen.getByRole('button', { name: 'Approve' })).toHaveProperty('disabled', true);
  await user.click(within(screen.getByRole('group', { name: 'Short lines' })).getByRole('button', { name: /^Close order/ }));
  await user.click(screen.getByRole('button', { name: 'Approve' }));
  expect(readAll().find((e) => e.type === 'stock.grn')).toMatchObject({ approvedBy: { name: 'Ravi', role: 'manager' }, shortDecision: 'close', lines: [{ ordered: 2, received: 1, accepted: 1 }] });
  const done = within(screen.getByRole('region', { name: 'GRN' })).getByRole('status').textContent;
  expect(done).toContain('GRN-0001 saved');
  expect(done).toContain('approved by a manager');
  expect(document.body.textContent).not.toContain('Ravi');
  await user.keyboard('{Escape}');
  expect(amount()).toContain('1 pack');
});

test('GRN by keyboard: Enter does the big button, Esc goes back to the deliveries', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  orderFlour(2);
  await openGrn(user);
  expect(screen.getByText('Step 2 of 2 · Check and save')).toBeTruthy();
  await user.keyboard('{Enter}'); // ✓ Pizza Flour came
  expect(screen.getByText('1 of 1 checked')).toBeTruthy();
  await user.keyboard('{Escape}'); // back to the list of deliveries
  expect(screen.getByText('Which delivery came?')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: /PO-0001 · expected/ })); // the delivery again, fresh
  expect(screen.getByText('0 of 1 checked')).toBeTruthy();
  await user.keyboard('{Enter}{Enter}'); // ✓ Pizza Flour came, then Save GRN
  expect(readAll().find((e) => e.type === 'stock.grn')).toMatchObject({ approvedBy: null, lines: [{ received: 2, accepted: 2 }] });
  await user.keyboard('{Enter}'); // Done: the page starts over, and nothing else waits
  expect(within(screen.getByRole('region', { name: 'GRN' })).getByText(/^Nothing on order/)).toBeTruthy();
});

test('short + wait: the rest stays on order; the next GRN expects only what is left; only the latest GRN can be undone', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  orderFlour(4);
  await receive(user, '1');
  await toReview(user);
  await user.click(screen.getByRole('button', { name: 'Manager approves' }));
  await user.type(screen.getByLabelText('Manager PIN', { selector: 'input' }), '2580');
  await user.click(screen.getByRole('button', { name: /^Wait for the rest/ }));
  await user.click(screen.getByRole('button', { name: 'Approve' }));
  expect(readAll().find((e) => e.type === 'stock.grn')).toMatchObject({ shortDecision: 'wait', lines: [{ ordered: 4, received: 1, accepted: 1 }] });

  // Next delivery: the order is Partly received; the rest (3) is what the next GRN expects.
  await user.click(screen.getByRole('button', { name: 'Next delivery' }));
  await user.click(screen.getByRole('button', { name: /PO-0001 · expected .* · partly received/ }));
  expect(screen.getByRole('textbox', { name: 'Packs of Pizza Flour' })).toHaveProperty('value', '3');
  expect(screen.getByText('Expected 3 packs')).toBeTruthy();
  await toReview(user);
  await user.click(screen.getByRole('button', { name: 'Save GRN' }));
  expect(amount()).toContain('4 packs · 100 kg');
  expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy(); // nothing else waiting
  await user.keyboard('{Escape}');

  // Two GRNs stand against PO-0001: only the latest has an Undo.
  await openGrn(user);
  expect(screen.getByText(/^Nothing on order/)).toBeTruthy(); // everything came: closed
  await user.click(screen.getByRole('button', { name: 'Open GRN-0001' }));
  expect(screen.queryByRole('button', { name: 'Undo GRN-0001' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Back' }));
  await user.click(screen.getByRole('button', { name: 'Open GRN-0002' }));
  expect(screen.getByRole('button', { name: 'Undo GRN-0002' })).toBeTruthy();
});

test('over + return: only what was owed goes into stock, the extra is recorded as returned', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  orderFlour(2);
  await receive(user, '3');
  expect(screen.getByLabelText('Pizza Flour: over').textContent).toContain('over +1');
  await toReview(user);
  await user.click(screen.getByRole('button', { name: 'Manager approves' }));
  await user.type(screen.getByLabelText('Manager PIN', { selector: 'input' }), '2580');
  expect(screen.getByRole('button', { name: 'Approve' })).toHaveProperty('disabled', true);
  await user.click(within(screen.getByRole('group', { name: 'Extra lines' })).getByRole('button', { name: /^Return extra/ }));
  await user.click(screen.getByRole('button', { name: 'Approve' }));
  expect(readAll().find((e) => e.type === 'stock.grn')).toMatchObject({ overDecision: 'return', lines: [{ ordered: 2, received: 3, accepted: 2, returned: 1 }] });
  await user.keyboard('{Escape}');
  expect(amount()).toContain('2 packs · 50 kg');
});

test('over + accept: everything that came goes into stock', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  orderFlour(2);
  await receive(user, '3');
  await toReview(user);
  await user.click(screen.getByRole('button', { name: 'Manager approves' }));
  await user.type(screen.getByLabelText('Manager PIN', { selector: 'input' }), '2580');
  await user.click(within(screen.getByRole('group', { name: 'Extra lines' })).getByRole('button', { name: /^Accept extra/ }));
  await user.click(screen.getByRole('button', { name: 'Approve' }));
  expect(readAll().find((e) => e.type === 'stock.grn')).toMatchObject({ overDecision: 'accept', lines: [{ ordered: 2, received: 3, accepted: 3, returned: 0 }] });
  await user.keyboard('{Escape}');
  expect(amount()).toContain('3 packs · 75 kg');
});

test('a GRN older than the allowed hours has no Undo', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  orderFlour(2);
  const po = readAll().find((e) => e.type === 'stock.ordered')!;
  act(() => {
    appendEvent({
      type: 'stock.grn', at: Date.now() - 25 * 3_600_000, orderNumber: 0, actor: { id: 'm', name: 'Ravi', role: 'manager' }, orderId: po.id,
      supplierId: 'sup_prima', lines: [{ itemId: 'inv-0001', ordered: 2, received: 2, accepted: 2, returned: 0 }], approvedBy: null,
    });
  });
  await openGrn(user);
  expect(screen.getByRole('region', { name: 'GRN history' })).toBeTruthy(); // the order is closed, so the sheet opens on the list
  await user.click(screen.getByRole('button', { name: /^Open (GRN \(pending\)|GRN-0001)$/ }));
  expect(screen.queryByRole('button', { name: /^Undo GRN/ })).toBeNull();
});

test('more than ordered shows as over, in orange like short', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  orderFlour();
  await receive(user, '4');
  expect(screen.getByLabelText('Pizza Flour: over').textContent).toContain('over +2');
  expect(document.querySelector('.grn-check--warn .qty__num')).toBeTruthy();
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

// ----- "Order when below", the owner's number (SCRUM-135) -----

test('the owner, with his PIN, sets flour to order when below 2 packs; Undo and Automatic hand it back', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  await user.click(within(flourRow()).getByRole('button', { name: 'Pizza Flour' }));
  const sheet = () => within(screen.getByRole('dialog', { name: 'Pizza Flour' }));
  await user.click(sheet().getByRole('tab', { name: 'Order' }));
  expect(sheet().getByText('automatic')).toBeTruthy();

  await user.click(sheet().getByRole('button', { name: 'Change order when below' }));
  await user.type(sheet().getByLabelText('Owner PIN'), '2580'); // the manager's: refused
  expect(sheet().getByRole('alert').textContent).toBe('Only the owner sets when to order.');
  await user.type(sheet().getByLabelText('Owner PIN'), '9999');
  await user.type(sheet().getByRole('textbox', { name: /Order when below/ }), 'none');
  await user.click(sheet().getByRole('button', { name: 'Save' }));
  expect(sheet().getByRole('alert').textContent).toMatch(/Type a number of packs/);
  await user.clear(sheet().getByRole('textbox', { name: /Order when below/ }));
  await user.type(sheet().getByRole('textbox', { name: /Order when below/ }), '2{Enter}');
  expect(lastEvent()).toMatchObject({ type: 'stock.limit_set', itemId: 'inv-0001', packs: 2, actor: { role: 'owner' } });
  expect(sheet().getByRole('status').textContent).toMatch(/order when below 2 packs/);

  await user.click(within(sheet().getByRole('status')).getByRole('button', { name: 'Undo' }));
  expect(lastEvent()).toMatchObject({ type: 'stock.limit_set', packs: null });
  expect(sheet().getByText('automatic')).toBeTruthy();

  act(() => inventoryStore.setOrderBelow('inv-0001', 3, { id: 'o', name: 'Owner', role: 'owner' }));
  await user.click(sheet().getByRole('button', { name: 'Change order when below' }));
  await user.type(sheet().getByLabelText('Owner PIN'), '9999');
  await user.click(sheet().getByRole('button', { name: 'Automatic' }));
  expect(lastEvent()).toMatchObject({ type: 'stock.limit_set', packs: null });
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
  await openGrn(user);
  expect(screen.getByRole('textbox', { name: 'kg of Pizza Flour' })).toHaveProperty('value', '50');
  await receive(user, '12.5', 'kg of Pizza Flour');
  await toReview(user);
  await user.click(screen.getByRole('button', { name: 'Manager approves' }));
  await user.type(screen.getByLabelText('Manager PIN', { selector: 'input' }), '2580');
  await user.click(screen.getByRole('button', { name: /^Close order/ }));
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
