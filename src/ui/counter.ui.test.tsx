import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FAKE_STAFF } from '../fake/data.ts';
import { printReceipt } from '../services/printer.ts';
import { App } from './App.tsx';
import { Root } from './Root.tsx';
import { readEvents } from './eventLog.ts';
import { setKitchenScreen } from './kitchenScreen.ts';
import { heldCount, heldList } from './testHeld.ts';

/**
 * The counter redesigned for recognition over recall (2026-11-16): every daily action is a
 * labelled button in the bar along the bottom, with its key printed on it; greyed, never hidden.
 * A new counter has no Kitchen view: paying sends the order with it.
 */

// A paired counter: printing goes through the (mocked) server.
vi.mock('../services/printer.ts', () => ({
  canPrint: () => true, printReceipt: vi.fn(), printChangeSlip: vi.fn(), printDeliveryBill: vi.fn(),
}));
const print = vi.mocked(printReceipt);

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, '', '/');
  print.mockReset();
  print.mockResolvedValue('printed');
});
afterEach(cleanup);

type User = ReturnType<typeof userEvent.setup>;
const panel = () => within(screen.getByRole('complementary', { name: 'Current order' }));
const bar = () => within(screen.getByRole('navigation', { name: 'Bill actions' }));
const btn = (name: string) => bar().getByRole('button', { name }) as HTMLButtonElement;
const pinFor = (role: string) => FAKE_STAFF.find((s) => s.actor.role === role)!.pin;
const margherita = (user: User) => user.click(screen.getAllByRole('button', { name: 'M 1,450' })[0]);
const burger = (user: User) => user.click(screen.getAllByRole('button', { name: '450' })[0]);
const net = () => screen.getByRole('complementary', { name: 'Current order' }).querySelector('.total')!.textContent;

test('every action is on the bar with its words and its key; Send to kitchen only with the Kitchen view on', () => {
  const { unmount } = render(<App />);
  const keys: [string, string][] = [
    ['Pay', 'F2'], ['Void item', 'F4'], ['Clear bill', 'F5'], ['New bill', 'F6'], ['Print last bill', 'F8'],
  ];
  for (const [name, key] of keys) {
    expect(btn(name).tagName).toBe('BUTTON');
    expect(btn(name).getAttribute('aria-keyshortcuts')).toBe(key);
    expect(btn(name).textContent).toContain(key); // printed on the button
  }
  expect(bar().queryByRole('button', { name: 'Send to kitchen' })).toBeNull();
  unmount();

  setKitchenScreen(true);
  render(<App />);
  expect(btn('Send to kitchen').getAttribute('aria-keyshortcuts')).toBe('F3');
});

test('an empty bill: PAY, Void, Clear and New bill are greyed, not hidden', async () => {
  const user = userEvent.setup();
  render(<App />);
  for (const name of ['Pay', 'Void item', 'Clear bill', 'New bill', 'Print last bill']) expect(btn(name).disabled).toBe(true);
  await user.keyboard('{F2}'); // the key does nothing either
  expect(screen.queryByText('Paying')).toBeNull();
  await margherita(user);
  for (const name of ['Pay', 'Void item', 'Clear bill', 'New bill']) expect(btn(name).disabled).toBe(false);
});

test('PAY (F2): the payment opens in the bill; exact cash pays; with no Kitchen view the order goes out with it and is handed over', async () => {
  const user = userEvent.setup();
  render(<App />);
  await margherita(user);
  await user.keyboard('{F2}');
  expect(panel().getByText('Paying')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: /Exact/ }));
  expect(panel().getByText('Paid')).toBeTruthy();
  const events = readEvents();
  const sent = events.find((e) => e.type === 'order.sent');
  expect(sent).toMatchObject({ orderNumber: 1001 });
  expect(sent && 'held' in sent).toBe(false); // nothing waits for a Send that has no button
  expect(events.map((e) => e.type)).toEqual(['order.sent', 'order.paid', 'order.given']);
  expect(btn('Pay').disabled).toBe(true); // paid: nothing left to pay
  expect(heldCount(0)).toBeTruthy(); // paid and given: not left on the list
});

test('VOID ITEM (F4 or Delete) removes the selected line at once, with Undo', async () => {
  const user = userEvent.setup();
  render(<App />);
  await margherita(user);
  await burger(user);
  // The line just added is selected; a tap on another row selects that one.
  expect(panel().getAllByRole('row').find((r) => r.getAttribute('aria-selected') === 'true')!.textContent).toContain('Chicken Burger');
  await user.click(panel().getByText('1,450', { selector: '.bill__price' }));
  await user.click(btn('Void item'));
  expect(panel().queryByText('Margherita')).toBeNull();
  expect(panel().getByText('Chicken Burger')).toBeTruthy();
  await user.click(within(screen.getByRole('status')).getByRole('button', { name: 'Undo' }));
  expect(panel().getByText('Margherita')).toBeTruthy();
  await user.keyboard('{F4}'); // the line came back: the selection is on the last line, the burger
  expect(panel().queryByText('Chicken Burger')).toBeNull();
  expect(panel().getByText('Margherita')).toBeTruthy();
  await user.keyboard('{Delete}');
  expect(panel().queryByRole('table')).toBeNull();
});

test('CLEAR BILL (F5) empties the bill at once, with Undo; no dialog', async () => {
  const user = userEvent.setup();
  render(<App />);
  await margherita(user);
  await burger(user);
  await user.click(btn('Clear bill'));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(panel().queryByText('Margherita')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('Cleared bill 1001');
  await user.click(within(screen.getByRole('status')).getByRole('button', { name: 'Undo' }));
  expect(net()).toBe('1,900');
  await user.keyboard('{F5}');
  expect(panel().queryByText('Chicken Burger')).toBeNull();
});

test('NEW BILL puts the bill on Held bills with its number and order type, with Undo; one tap brings it back', async () => {
  const user = userEvent.setup();
  render(<App />);
  expect(screen.queryByRole('button', { name: /^Hold/ })).toBeNull(); // one button for it (SCRUM-249)
  await margherita(user);
  await user.click(panel().getByRole('radio', { name: 'Dine in' }));
  await user.click(btn('New bill'));
  expect(panel().queryByText('Margherita')).toBeNull();
  expect(heldCount(1)).toBeTruthy();
  expect(panel().getByRole('radio', { name: 'Take away' }).getAttribute('aria-checked')).toBe('true'); // the next bill starts as take away
  await user.click(heldList().getByRole('button', { name: /^1001.*Dine in/ }));
  expect(panel().getByText('Margherita')).toBeTruthy();
  expect(panel().getByRole('radio', { name: 'Dine in' }).getAttribute('aria-checked')).toBe('true');
  await user.keyboard('{F6}');
  expect(heldCount(1)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Undo' }));
  expect(panel().getByText('Margherita')).toBeTruthy();
});

test('NEW BILL (F6) after a sale starts the next number; with items on the bill it holds them, nothing is lost', async () => {
  const user = userEvent.setup();
  render(<App />);
  await margherita(user);
  await user.click(btn('Pay'));
  await user.click(screen.getByRole('button', { name: /Exact/ }));
  await user.click(btn('New bill'));
  expect(panel().getByText('1002')).toBeTruthy();
  await burger(user);
  await user.keyboard('{F6}');
  expect(panel().getByText('1003')).toBeTruthy();
  expect(heldList().getByRole('button', { name: /^1002/ })).toBeTruthy();
});

test('PRINT LAST BILL (F8) prints a copy of the last sale', async () => {
  const user = userEvent.setup();
  render(<App />);
  await margherita(user);
  await user.click(btn('Pay'));
  await user.click(screen.getByRole('button', { name: /Exact/ }));
  await user.click(btn('New bill'));
  expect(print).toHaveBeenCalledTimes(1); // the receipt at payment
  await user.click(btn('Print last bill'));
  expect(print).toHaveBeenCalledTimes(2);
  expect(print.mock.calls[1][0]).toMatchObject({ number: 1001 });
  expect(print.mock.calls[1][2]).toMatchObject({ reprint: true });
  await user.keyboard('{F8}');
  expect(print).toHaveBeenCalledTimes(3);
});

test('SEND TO KITCHEN (F3), with the Kitchen view on: the new lines go to the kitchen', async () => {
  setKitchenScreen(true);
  const user = userEvent.setup();
  render(<App />);
  expect(btn('Send to kitchen').disabled).toBe(true);
  await margherita(user);
  await user.keyboard('{F3}');
  expect(readEvents().filter((e) => e.type === 'order.sent')).toMatchObject([{ orderNumber: 1001 }]);
  expect(screen.getByRole('status').textContent).toContain('Sent 1001 to kitchen');
});

test('VOID on a line already sent to the kitchen asks for a manager PIN, then the reason; a cashier PIN does not do', async () => {
  setKitchenScreen(true);
  const user = userEvent.setup();
  render(<App />);
  await margherita(user);
  await user.click(btn('Send to kitchen'));
  await user.click(heldList().getByRole('button', { name: /^1001/ }));
  expect(btn('Clear bill').disabled).toBe(true); // sent: not the cashier's to clear

  await user.click(btn('Void item'));
  const pin = screen.getByRole('dialog');
  expect(within(pin).getByText('To void an item already sent to the kitchen')).toBeTruthy();
  await user.keyboard(pinFor('cashier'));
  expect(screen.getByRole('dialog')).toBeTruthy(); // still asking
  expect(panel().getByText('Margherita')).toBeTruthy();
  await user.keyboard(pinFor('manager'));
  expect(screen.queryByRole('dialog')).toBeNull();

  await user.click(panel().getByRole('button', { name: /Wrong item entered/ }));
  expect(panel().queryByText('Margherita')).toBeNull();
  expect(readEvents().at(-1)).toMatchObject({ type: 'order.item_cancelled', reason: 'Wrong item entered' });
});

test('the row ✕ on a sent line asks for the PIN too; on a new line it just goes', async () => {
  setKitchenScreen(true);
  const user = userEvent.setup();
  render(<App />);
  await margherita(user);
  await user.click(btn('Send to kitchen'));
  await user.click(heldList().getByRole('button', { name: /^1001/ }));
  await burger(user);
  await user.click(panel().getByRole('button', { name: 'Void Chicken Burger' }));
  expect(panel().queryByText('Chicken Burger')).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  await user.click(panel().getByRole('button', { name: 'Void Margherita' }));
  expect(screen.getByRole('dialog')).toBeTruthy();
});

test('keys: arrows move the selection, + and − change how many', async () => {
  const user = userEvent.setup();
  render(<App />);
  await margherita(user);
  await burger(user);
  await user.keyboard('{ArrowUp}+');
  expect(within(panel().getByRole('group', { name: 'How many Margherita' })).getByText('2')).toBeTruthy();
  expect(net()).toBe('3,350');
  await user.keyboard('{ArrowDown}+-');
  expect(within(panel().getByRole('group', { name: 'How many Chicken Burger' })).getByText('1')).toBeTruthy();
  expect(net()).toBe('3,350');
});

test('totals: Subtotal, Discount and NET AMOUNT in whole cents', async () => {
  const user = userEvent.setup();
  render(<App />);
  await margherita(user);
  await burger(user);
  const sums = within(screen.getByRole('complementary', { name: 'Current order' }).querySelector('.sums') as HTMLElement);
  expect(sums.getByText('Subtotal').nextElementSibling!.textContent).toBe('1,900');
  expect(sums.getByText('Discount')).toBeTruthy();
  expect(sums.getByText('Net amount').nextElementSibling!.textContent).toBe('1,900');
});

test('a new counter shows no Kitchen view: no Kitchen key, and /#kitchen opens the Register', () => {
  history.replaceState(null, '', '/#kitchen');
  render(<Root />);
  expect(screen.getByRole('complementary', { name: 'Current order' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Kitchen/ })).toBeNull();
});

test('the counter starts in light mode unless a look was chosen', () => {
  render(<App />);
  expect(document.documentElement.dataset.theme).toBe('light');
});

test('order history on the left: held bills and paid today always in sight, one tap opens either', async () => {
  const user = userEvent.setup();
  render(<App />);
  const history = within(screen.getByRole('navigation', { name: 'Order history' }));
  expect(history.getByRole('heading', { name: 'Held bills · 0' })).toBeTruthy(); // there before any bill, no button to find it
  await margherita(user);
  await user.click(btn('Pay'));
  await user.click(screen.getByRole('button', { name: '2,000' })); // 1001 paid, change 550
  await burger(user);
  await user.click(btn('New bill')); // 1002 held
  expect(history.getByRole('heading', { name: 'Held bills · 1' })).toBeTruthy();
  const paidToday = within(history.getByRole('region', { name: 'Paid today' }));
  expect(paidToday.getByRole('button', { name: /^1001.*Margherita.*Paid · Cash/ })).toBeTruthy();

  await user.click(paidToday.getByRole('button', { name: /^1001/ }));
  expect(within(panel().getByRole('status')).getByText(/Cash 2,000/)).toBeTruthy();
  expect(paidToday.getByRole('button', { name: /^1001/ }).getAttribute('aria-current')).toBe('true');
  await user.click(heldList().getByRole('button', { name: /^1002/ }));
  expect(panel().getByText('Chicken Burger')).toBeTruthy();
});
