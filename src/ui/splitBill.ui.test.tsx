import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App.tsx';
import { readAll } from './eventLog.ts';
import { setKitchenScreen } from './kitchenScreen.ts';
import { heldList } from './testHeld.ts';

// Split bill (SCRUM-244): each person pays for their own items, any tender; the last part closes the order.

beforeEach(() => { localStorage.clear(); setKitchenScreen(true); });
afterEach(cleanup);

const panel = () => within(screen.getByRole('complementary', { name: 'Current order' }));
const pay = () => within(panel().getByRole('region', { name: 'Payment' }));
const paying = () => panel().queryByRole('region', { name: 'Payment' });
const rows = () => within(pay().getByRole('list', { name: "Tap this person's items" })).getAllByRole('button');
const lastPaid = () => readAll().filter((e) => e.type === 'order.paid').at(-1) as { total: number; tender: string; parts?: { tender: string; amount: number }[] } | undefined;

/** Two pizzas of 2,500, sent, with Charge open. */
const openPayment = async (user = userEvent.setup()) => {
  render(<App />);
  const large = screen.getAllByRole('button', { name: 'L 2,500' });
  await user.click(large[0]);
  await user.click(large[1]);
  await user.click(screen.getByRole('button', { name: 'Send to kitchen' }));
  await user.click(heldList().getByRole('button', { name: /^1001/ }));
  await user.click(screen.getByRole('button', { name: 'Pay' }));
  return user;
};

test('S splits: one person pays their pizza by bank, the other the rest in cash; one payment with both parts', async () => {
  const user = await openPayment();
  await user.keyboard('s');
  expect(pay().getByRole('button', { name: /Split bill/ }).getAttribute('aria-pressed')).toBe('true');
  expect(rows()).toHaveLength(2);

  await user.click(rows()[0]);
  expect(pay().getByRole('status').textContent).toBe('Their part 2,500');
  await user.keyboard('b');

  // Still paying: the first pizza is paid, the rest is what is left.
  expect(paying()).toBeTruthy();
  expect(pay().getByText('Paid 2,500 · 2,500 left')).toBeTruthy();
  expect((rows()[0] as HTMLButtonElement).disabled).toBe(true);
  expect(lastPaid()).toBeUndefined(); // nothing written until the last part

  await user.keyboard('{Enter}'); // nothing picked: exact cash for the rest
  expect(paying()).toBeNull();
  expect(panel().getByText(/Split · Bank transfer 2,500 \+ Cash 2,500/)).toBeTruthy();
  const paid = lastPaid()!;
  expect(paid.total).toBe(500000);
  expect(paid.parts).toEqual([
    { tender: 'transfer', amount: 250000, tendered: 250000 },
    { tender: 'cash', amount: 250000, tendered: 250000 },
  ]);
});

test('Undo takes a part back; Esc clears the pick, then leaves Split', async () => {
  const user = await openPayment();
  await user.keyboard('s');
  await user.click(rows()[1]);
  await user.keyboard('{Enter}'); // their part, exact cash
  expect(pay().getByText('Paid 2,500 · 2,500 left')).toBeTruthy();
  await user.keyboard('{Control>}z{/Control}');
  expect(pay().queryByText(/left$/)).toBeNull();
  expect(rows().every((r) => !(r as HTMLButtonElement).disabled)).toBe(true);

  await user.click(rows()[0]);
  await user.keyboard('{Escape}');
  expect(pay().getByRole('status').textContent).toBe('Total 5,000');
  await user.keyboard('{Escape}');
  expect(pay().queryByRole('list', { name: "Tap this person's items" })).toBeNull();
});

test('the arrows walk the items, Space picks one, Enter takes their part', async () => {
  const user = await openPayment();
  await user.keyboard('s{ArrowDown} ');
  expect(rows()[0].getAttribute('aria-pressed')).toBe('true');
  expect(pay().getByRole('status').textContent).toBe('Their part 2,500');
  await user.keyboard('{Enter}');
  expect(pay().getByText('Paid 2,500 · 2,500 left')).toBeTruthy();
});
