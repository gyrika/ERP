import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App.tsx';
import { Kitchen } from './Kitchen.tsx';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const panel = () => within(screen.getByRole('complementary', { name: 'Current order' }));
const kitchen = () => within(screen.getByRole('main', { name: 'Orders to make' }));

/** Takes one order at the register and sends it: Devilled Chicken L, no onion. */
const sendOne = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: /^Devilled Chicken/ }));
  await user.click(screen.getByRole('button', { name: /Large/ }));
  await user.click(screen.getByRole('button', { name: /No onion/ }));
  await user.click(screen.getByRole('button', { name: /^Add ·/ }));
  await user.click(panel().getByRole('button', { name: 'Send to kitchen' }));
};

test('a sent order appears in the kitchen before payment; Start, then Done clears it; Undo brings it back', async () => {
  const user = userEvent.setup();
  render(<><App /><Kitchen /></>);
  expect(kitchen().getByText('No orders waiting')).toBeTruthy();

  await sendOne(user);
  const ticket = within(kitchen().getByRole('article', { name: 'Order 1001' }));
  expect(ticket.getByText('Devilled Chicken')).toBeTruthy();
  expect(ticket.getByText('Large')).toBeTruthy();
  expect(ticket.getByText('No onion')).toBeTruthy();
  expect(ticket.getByText('00:00')).toBeTruthy();
  expect(ticket.queryByRole('button', { name: 'Done: Order 1001' })).toBeNull();

  await user.click(ticket.getByRole('button', { name: 'Start: Order 1001' }));
  expect(ticket.getByText('Cooking')).toBeTruthy();
  const started = screen.getAllByRole('status').find((el) => el.textContent?.includes('1001 started'))!;
  await user.click(within(started).getByRole('button', { name: 'Undo' }));
  expect(ticket.queryByText('Cooking')).toBeNull();

  await user.click(ticket.getByRole('button', { name: 'Start: Order 1001' }));
  await user.click(ticket.getByRole('button', { name: 'Done: Order 1001' }));
  expect(kitchen().getByText('No orders waiting')).toBeTruthy();

  // Both screens share this test page, so pick the kitchen's toast, not the register's.
  const toast = screen.getAllByRole('status').find((el) => el.textContent?.includes('1001 done'))!;
  await user.click(within(toast).getByRole('button', { name: 'Undo' }));
  expect(kitchen().getByRole('article', { name: 'Order 1001' })).toBeTruthy();
});

test('undoing the send at the register recalls the ticket', async () => {
  const user = userEvent.setup();
  render(<><App /><Kitchen /></>);
  await sendOne(user);
  expect(kitchen().getByRole('article', { name: 'Order 1001' })).toBeTruthy();
  const toast = screen.getAllByRole('status').find((el) => el.textContent?.includes('Sent 1001'))!;
  await user.click(within(toast).getByRole('button', { name: 'Undo' }));
  expect(kitchen().queryByRole('article', { name: 'Order 1001' })).toBeNull();
  expect(panel().getByText('Devilled Chicken')).toBeTruthy(); // back on the register, unsent
});

test('a later round arrives as its own "added" ticket; paying does not touch the kitchen', async () => {
  const user = userEvent.setup();
  render(<><App /><Kitchen /></>);
  await sendOne(user);
  await user.click(panel().getByRole('button', { name: /^1001/ }));
  await user.click(screen.getAllByRole('button', { name: 'M 1450' })[0]); // + Margherita M
  await user.click(panel().getByRole('button', { name: 'Send to kitchen' }));

  const more = within(kitchen().getByRole('article', { name: 'Order 1001, added items' }));
  expect(more.getByText('Margherita')).toBeTruthy();
  expect(more.queryByText('Devilled Chicken')).toBeNull(); // only the new round
  expect(kitchen().getAllByRole('article').length).toBe(2);

  await user.click(panel().getByRole('button', { name: /^1001/ }));
  await user.click(panel().getByRole('button', { name: 'Charge' }));
  await user.click(screen.getByRole('button', { name: /Exact/ }));
  expect(kitchen().getAllByRole('article').length).toBe(2);
});

test('a kitchen opened later still sees earlier tickets', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<App />);
  await sendOne(user);
  unmount();
  render(<Kitchen />);
  expect(screen.getByRole('article', { name: 'Order 1001' })).toBeTruthy();
});

test('the register shows Waiting until Start, Cooking until Done, next to Paid / Unpaid', async () => {
  const user = userEvent.setup();
  render(<><App /><Kitchen /></>);
  await sendOne(user); // 1001
  const row = () => within(panel().getByRole('button', { name: /^1001/ }));
  expect(row().getByText('Waiting')).toBeTruthy();
  expect(row().queryByText('Cooking')).toBeNull();
  expect(row().getByText('Unpaid')).toBeTruthy();

  await user.click(kitchen().getByRole('button', { name: 'Start: Order 1001' }));
  expect(row().getByText('Cooking')).toBeTruthy();
  await user.click(kitchen().getByRole('button', { name: 'Done: Order 1001' }));
  expect(row().getByText('Done')).toBeTruthy();
  expect(row().queryByText('Cooking')).toBeNull();

  // A second round puts it back to Waiting, then Cooking; the opened order shows it too.
  await user.click(panel().getByRole('button', { name: /^1001/ }));
  await user.click(screen.getAllByRole('button', { name: 'M 1450' })[0]);
  await user.click(panel().getByRole('button', { name: 'Send to kitchen' }));
  expect(row().getByText('Waiting')).toBeTruthy();
  await user.click(kitchen().getByRole('button', { name: 'Start: Order 1001, added items' }));
  expect(row().getByText('Cooking')).toBeTruthy();

  // Paid orders keep their kitchen state.
  await user.click(panel().getByRole('button', { name: /^1001/ }));
  expect(panel().getByText('Cooking')).toBeTruthy();
  await user.click(panel().getByRole('button', { name: 'Charge' }));
  await user.click(screen.getByRole('button', { name: /Exact/ }));
  await user.click(panel().getByRole('button', { name: 'Next order' }));
  const paid = within(panel().getByRole('region', { name: 'Paid today' }));
  expect(paid.getByText('Cooking')).toBeTruthy();
  expect(paid.getByText('Paid · Cash')).toBeTruthy();
});
