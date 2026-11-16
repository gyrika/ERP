import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App.tsx';
import { readEvents } from './eventLog.ts';
import { setKitchenScreen } from './kitchenScreen.ts';

// A paid order changed afterwards, on the same bill (SCRUM-253): extras, a new item, an item off,
// each marked on its line, and Pay takes only the difference.

beforeEach(() => { localStorage.clear(); setKitchenScreen(false); });
afterEach(cleanup);

const panel = () => within(screen.getByRole('complementary', { name: 'Current order' }));
const paidList = () => within(screen.getByRole('region', { name: 'Paid today' }));

/** 1001: Margherita M (1,450), paid exact cash, then the next customer's bill. */
const paidMargherita = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getAllByRole('button', { name: 'M 1,450' })[0]);
  await user.click(screen.getByRole('button', { name: 'Pay' }));
  await user.click(screen.getByRole('button', { name: /Exact cash/ }));
  await user.keyboard('{Escape}');
  await user.click(paidList().getByRole('button', { name: /^1001/ }));
};

test('extra cheese on the paid pizza: marked on its line, Pay 600 more, paid before and to pay now', async () => {
  const user = userEvent.setup();
  render(<App />);
  await paidMargherita(user);
  await user.click(panel().getByRole('button', { name: /^Margherita/ }));
  const sheet = within(screen.getByRole('region', { name: / extras$/ }));
  await user.click(sheet.getByRole('button', { name: /Full cheese/ }));
  await user.click(sheet.getByRole('button', { name: /^Update/ }));

  expect(panel().getByText(/\+ Full cheese · .* · \+600/).className).toContain('line__edit--due');
  expect(panel().getByText('Paid before').nextSibling!.textContent).toBe('1,450');
  expect(panel().getByText('To pay now').nextSibling!.textContent).toBe('600');
  expect(paidList().getByRole('button', { name: /^1001/ }).textContent).toContain('To pay 600');

  await user.click(screen.getByRole('button', { name: 'Pay 600 more' }));
  await user.click(screen.getByRole('button', { name: /Exact cash/ }));
  expect(readEvents().filter((e) => e.type === 'order.settled').at(-1)).toMatchObject({ amount: 60000, orderNumber: 1001 });
  expect(panel().queryByText('To pay now')).toBeNull();
  expect(panel().getByText(/\+ Full cheese · .* · \+600$/).className).not.toContain('line__edit--due'); // paid: no longer amber
});

test('a burger added to the paid bill: same number, only its price to pay, sent to the kitchen with its money', async () => {
  const user = userEvent.setup();
  render(<App />);
  await paidMargherita(user);
  await user.click(screen.getAllByRole('button', { name: '450' })[0]);
  expect(panel().getByText('Bill No').parentElement!.textContent).toContain('1001'); // the same bill, not a new one
  expect(panel().getByText(/Added now · \+450/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Pay 450 more' })).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Pay 450 more' }));
  await user.click(screen.getByRole('button', { name: /Exact cash/ }));
  const events = readEvents().filter((e) => e.orderNumber === 1001);
  const types = events.map((e) => e.type);
  expect(types.slice(-2)).toEqual(['order.sent', 'order.settled']);
  expect(events.at(-2)).toMatchObject({ addOn: true, lines: [{ itemId: 'chicken-burger' }] });
  expect(panel().getByText(/Added .* · \+450$/)).toBeTruthy();
});

test('right after paying, a menu tap still starts the next bill', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getAllByRole('button', { name: 'M 1,450' })[0]);
  await user.click(screen.getByRole('button', { name: 'Pay' }));
  await user.click(screen.getByRole('button', { name: /Exact cash/ }));
  await user.click(screen.getAllByRole('button', { name: '450' })[0]);
  expect(panel().getByText('Bill No').parentElement!.textContent).toContain('1002');
});

test('an item taken off after paying stays on the bill struck through, money back', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getAllByRole('button', { name: 'M 1,450' })[0]);
  await user.click(screen.getAllByRole('button', { name: '450' })[0]);
  await user.click(screen.getByRole('button', { name: 'Pay' }));
  await user.click(screen.getByRole('button', { name: /Exact cash/ }));
  await user.keyboard('{Escape}');
  await user.click(paidList().getByRole('button', { name: /^1001/ }));
  await user.click(panel().getByRole('button', { name: /^Chicken Burger/ }));
  await user.click(within(screen.getByRole('region', { name: / extras$/ })).getByRole('button', { name: 'Remove' }));
  const gone = within(panel().getByRole('rowgroup', { name: 'Taken off after paying' }));
  expect(gone.getByText('Chicken Burger')).toBeTruthy();
  expect(gone.getByText(/Removed .* · −450/)).toBeTruthy();
  expect(panel().getByText('To give back').nextSibling!.textContent).toBe('450');
});
