import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { heldList, tick, ticked } from './testHeld.ts';
import { App } from './App.tsx';
import { Kitchen } from './Kitchen.tsx';
import { readAll } from './eventLog.ts';
import { setKitchenScreen } from './kitchenScreen.ts';

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
  await user.click(screen.getByRole('button', { name: 'Send to kitchen' }));
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
  await user.click(heldList().getByRole('button', { name: /^1001/ }));
  await user.click(screen.getAllByRole('button', { name: 'M 1,450' })[0]); // + Margherita M
  await user.click(screen.getByRole('button', { name: 'Send to kitchen' }));

  const more = within(kitchen().getByRole('article', { name: 'Order 1001, added items' }));
  expect(more.getByText('Margherita')).toBeTruthy();
  expect(more.queryByText('Devilled Chicken')).toBeNull(); // only the new round
  expect(kitchen().getAllByRole('article').length).toBe(2);

  await user.click(heldList().getByRole('button', { name: /^1001/ }));
  await user.click(screen.getByRole('button', { name: 'Pay' }));
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

test('the register shows Waiting until Start, Cooking until Done, and keeps it once paid', async () => {
  const user = userEvent.setup();
  render(<><App /><Kitchen /></>);
  await sendOne(user); // 1001
  const row = () => within(heldList().getByRole('button', { name: /^1001/ }));
  expect(row().getByText('Waiting')).toBeTruthy();
  expect(row().queryByText('Cooking')).toBeNull();
  expect(row().getByText('Not paid')).toBeTruthy(); // a word for the kitchen, a word for the money

  await user.click(kitchen().getByRole('button', { name: 'Start: Order 1001' }));
  expect(row().getByText('Cooking')).toBeTruthy();
  await user.click(kitchen().getByRole('button', { name: 'Done: Order 1001' }));
  expect(row().getByText('Ready')).toBeTruthy(); // made, waiting for the customer (SCRUM-240)
  expect(row().queryByText('Cooking')).toBeNull();

  // A second round puts it back to Waiting, then Cooking; the opened order shows it too.
  await user.click(heldList().getByRole('button', { name: /^1001/ }));
  await user.click(screen.getAllByRole('button', { name: 'M 1,450' })[0]);
  await user.click(screen.getByRole('button', { name: 'Send to kitchen' }));
  expect(row().getByText('Waiting')).toBeTruthy();
  await user.click(kitchen().getByRole('button', { name: 'Start: Order 1001, added items' }));
  expect(row().getByText('Cooking')).toBeTruthy();

  // Paid orders keep their kitchen state.
  await user.click(heldList().getByRole('button', { name: /^1001/ }));
  // The order says Cooking; each sent line says its own state: the new round cooking, the first one made.
  expect(panel().getAllByText('Cooking')).toHaveLength(2);
  expect(panel().getByText('Made')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Pay' }));
  await user.click(screen.getByRole('button', { name: /Exact/ }));
  await user.click(screen.getByRole('button', { name: 'New bill' }));
  const paid = within(screen.getByRole('region', { name: 'Paid today' }));
  expect(paid.getByText('Cooking')).toBeTruthy();
  expect(paid.getByText('Paid · Cash')).toBeTruthy();
  // Paid, food still coming: it stays on the list. Made, it is Ready and still stays: the customer
  // has not taken it yet. Given (Ctrl+Enter on the paid order) and it leaves (SCRUM-240).
  expect(row().getByText('Cooking')).toBeTruthy();
  expect(row().getByText('Paid')).toBeTruthy();
  await user.click(kitchen().getByRole('button', { name: 'Done: Order 1001, added items' }));
  expect(row().getByText('Ready')).toBeTruthy();
  await user.click(heldList().getByRole('button', { name: /^1001/ }));
  await user.keyboard('{Control>}{Enter}{/Control}');
  expect(heldList().queryByRole('button', { name: /^1001/ })).toBeNull();
  expect(readAll().filter((e) => e.type === 'order.given')).toMatchObject([{ orderNumber: 1001 }]);
});

test('paid first, cooked, waiting to be collected: Ready stays on the list until Given; Undo brings it back', async () => {
  const user = userEvent.setup();
  render(<><App /><Kitchen /></>);
  const rail = () => heldList();
  await user.click(screen.getAllByRole('button', { name: 'L 2,500' })[0]);
  await user.click(screen.getByRole('button', { name: 'Pay' }));
  await user.click(screen.getByRole('button', { name: /Exact/ }));
  await user.click(screen.getByRole('button', { name: 'Send to kitchen' }));
  await user.click(kitchen().getByRole('button', { name: 'Start: Order 1001' }));
  await user.click(kitchen().getByRole('button', { name: 'Done: Order 1001' }));
  expect(rail().getByRole('button', { name: /^1001.*Ready.*Paid/ })).toBeTruthy();

  await user.click(rail().getByRole('button', { name: /^1001/ }));
  await user.click(panel().getByRole('button', { name: 'Given' }));
  expect(heldList().queryByRole('button', { name: /^1001/ })).toBeNull();
  const toast = screen.getByText('Given 1001').closest('.toast') as HTMLElement;
  await user.click(within(toast).getByRole('button', { name: 'Undo' }));
  await user.click(screen.getByRole('button', { name: 'New bill' })); // Undo put it back on screen; held bills are the others
  expect(rail().getByRole('button', { name: /^1001.*Ready.*Paid/ })).toBeTruthy();
  expect(readAll().map((e) => e.type).slice(-2)).toEqual(['order.given', 'order.given_undone']);
});

test('paying for a ready order does not hand it over: the cashier ticks it when the customer takes it', async () => {
  const user = userEvent.setup();
  render(<><App /><Kitchen /></>);
  await sendOne(user); // 1001, not paid
  await user.click(kitchen().getByRole('button', { name: 'Start: Order 1001' }));
  await user.click(kitchen().getByRole('button', { name: 'Done: Order 1001' }));
  const rail = () => heldList();
  expect(rail().getByRole('button', { name: /^1001.*Ready.*Not paid/ })).toBeTruthy();
  await user.click(rail().getByRole('button', { name: /^1001/ }));
  expect(panel().getByRole('button', { name: 'Given' })).toBeTruthy(); // eating in: handed over, paid later
  await user.click(screen.getByRole('button', { name: 'Pay' }));
  await user.click(screen.getByRole('button', { name: /Exact/ }));
  expect(ticked(1001)).toBe(false);
  expect(readAll().map((e) => e.type).at(-1)).toBe('order.paid');
  await user.click(tick(1001));
  expect(heldList().queryByRole('button', { name: /^1001/ })).toBeNull();
  expect(readAll().map((e) => e.type).at(-1)).toBe('order.given');
});

test('Remake: a burnt pizza is recorded as waste in two taps, and the line stays on the ticket to make again (SCRUM-177)', async () => {
  const user = userEvent.setup();
  render(<><App /><Kitchen /></>);
  await sendOne(user);
  const ticket = within(kitchen().getByRole('article', { name: 'Order 1001' }));
  expect(ticket.queryByRole('button', { name: 'Remake Devilled Chicken' })).toBeNull(); // not made yet: nothing to throw away
  await user.click(ticket.getByRole('button', { name: 'Start: Order 1001' }));

  await user.click(ticket.getByRole('button', { name: 'Remake Devilled Chicken' }));
  await user.click(within(ticket.getByRole('group', { name: 'Why remake Devilled Chicken?' })).getByRole('button', { name: 'Burnt' }));
  expect(readAll().at(-1)).toMatchObject({
    type: 'stock.wasted', what: { kind: 'dish', itemId: 'devilled-chicken', size: 'L' }, qty: 1, reason: 'burnt', lineId: expect.any(String), ticketId: expect.any(String),
  });
  expect(ticket.getByText('Remake ×1')).toBeTruthy();
  expect(ticket.getByRole('button', { name: 'Done: Order 1001' })).toBeTruthy(); // still to make

  const toast = screen.getAllByRole('status').find((el) => el.textContent?.includes('remake · Burnt'))!;
  await user.click(within(toast).getByRole('button', { name: 'Undo' }));
  expect(readAll().at(-1)).toMatchObject({ type: 'stock.waste_undone' });
  expect(ticket.queryByText('Remake ×1')).toBeNull();
});

// These tests are about the kitchen flow: the Kitchen view on (it is off on a new counter).
beforeEach(() => setKitchenScreen(true));
