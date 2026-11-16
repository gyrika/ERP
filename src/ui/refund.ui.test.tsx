import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App.tsx';
import { readEvents } from './eventLog.ts';
import { setKitchenScreen } from './kitchenScreen.ts';
import { heldList } from './testHeld.ts';

// A customer comes back after paying (SCRUM-247): their number opens the bill, the change is
// given back, and the bill says so in the history.

beforeEach(() => { localStorage.clear(); setKitchenScreen(true); });
afterEach(cleanup);

const panel = () => within(screen.getByRole('complementary', { name: 'Current order' }));
const paidList = () => within(screen.getByRole('region', { name: 'Paid today' }));

test('typed number opens a paid bill; a burger off gives back 450; the history says so', async () => {
  const user = userEvent.setup();
  render(<App />);
  // 1001 = Margherita M (1,450) + Chicken Burger (450), sent, paid in exact cash, then the next customer.
  await user.click(screen.getAllByRole('button', { name: 'M 1,450' })[0]);
  await user.click(screen.getAllByRole('button', { name: '450' })[0]);
  await user.click(screen.getByRole('button', { name: 'Send to kitchen' }));
  await user.click(heldList().getByRole('button', { name: /^1001/ }));
  await user.click(screen.getByRole('button', { name: 'Pay' }));
  await user.click(screen.getByRole('button', { name: /Exact cash/ }));
  await user.keyboard('{Escape}'); // next order
  expect(panel().queryByRole('button', { name: /^Chicken Burger/ })).toBeNull();

  // The customer is back: their number, typed, opens their bill.
  await user.keyboard('1001');
  expect(screen.getByText('Enter opens bill 1001')).toBeTruthy();
  await user.keyboard('{Enter}');
  await user.click(panel().getByRole('button', { name: /^Chicken Burger/ }));
  const sheet = within(screen.getByRole('region', { name: / extras$/ }));
  await user.click(sheet.getByRole('button', { name: 'Remove' }));
  await user.click(screen.getByRole('button', { name: 'Give back 450' }));
  expect(readEvents().filter((e) => e.type === 'order.settled').at(-1)).toMatchObject({ amount: -45000, orderNumber: 1001 });

  const row = paidList().getByRole('button', { name: /^1001/ });
  expect(row.textContent).toContain('Gave back 450');
  expect(row.textContent).toContain('1,450');
});

test('a number that is no bill today stays a typed order', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.keyboard('4242');
  expect(screen.queryByText(/Enter opens bill/)).toBeNull();
});
