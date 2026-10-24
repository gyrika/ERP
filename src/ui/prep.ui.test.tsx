import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App.tsx';
import { Kitchen } from './Kitchen.tsx';
import { appendEvent, readAll } from './eventLog.ts';
import { Root } from './Root.tsx';

// SCRUM-136: low stock goes to the kitchen as a PREP ticket; Start, then Done makes the batch.

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/'); });
afterEach(cleanup);

const owner = { id: 'o1', name: 'Nisal', role: 'owner' as const };
const kitchen = () => within(screen.getByRole('main', { name: 'Orders to make' }));
const semi = () => within(screen.getByRole('main', { name: 'Semi-processed' }));
const row = (name: string) => within(semi().getByRole('button', { name }).closest('article')!);
/** Mozzarella Blend sent once and made (2,000 g); "make more when below" 3,000 g, so it runs low. */
const lowBlend = () => {
  appendEvent({ type: 'prep.ordered', at: Date.now(), orderNumber: 0, actor: owner, ticketId: 'p1', prepId: 'Mozzarella Blend', name: 'Mozzarella Blend', qty: 2000, unit: 'g' });
  appendEvent({ type: 'kitchen.bumped', at: Date.now(), orderNumber: 0, ticketId: 'p1' });
  appendEvent({ type: 'prep.limit_set', at: Date.now(), orderNumber: 0, actor: owner, prepId: 'Mozzarella Blend', before: null, after: 3000 });
};

test('low stock is sent to the kitchen; the PREP ticket is started and marked Done, and Done makes the batch', async () => {
  lowBlend();
  const user = userEvent.setup();
  history.replaceState(null, '', '/#items/semi');
  render(<><Root /><Kitchen /></>);
  expect(row('Mozzarella Blend').getByText('Make more')).toBeTruthy();
  expect(row('Mozzarella Blend').getByText('2,000 g')).toBeTruthy();

  await user.click(row('Mozzarella Blend').getByRole('button', { name: 'Send Mozzarella Blend to the kitchen' }));
  expect(readAll().at(-1)).toMatchObject({ type: 'prep.ordered', prepId: 'Mozzarella Blend', qty: 2000, unit: 'g' });
  expect(row('Mozzarella Blend').getByText('In the kitchen · 2,000 g')).toBeTruthy();
  expect(row('Mozzarella Blend').getByText('2,000 g')).toBeTruthy(); // nothing moves until Done

  const ticket = within(kitchen().getByRole('article', { name: 'Prep: Mozzarella Blend' }));
  expect(ticket.getByText('Prep')).toBeTruthy();
  expect(ticket.getByText('Make 2,000 g')).toBeTruthy();
  await user.click(ticket.getByRole('button', { name: 'Start: Prep: Mozzarella Blend' }));
  expect(ticket.getByText('Making')).toBeTruthy();
  await user.click(ticket.getByRole('button', { name: 'Done: Prep: Mozzarella Blend' }));
  expect(kitchen().queryByRole('article', { name: 'Prep: Mozzarella Blend' })).toBeNull();
  expect(row('Mozzarella Blend').getByText('4,000 g')).toBeTruthy();
  expect(row('Mozzarella Blend').getByText('In stock')).toBeTruthy();

  // Undo of Done brings the ticket back and the batch off again.
  const toast = screen.getAllByRole('status').find((el) => el.textContent?.includes('Prep Mozzarella Blend done'))!;
  await user.click(within(toast).getByRole('button', { name: 'Undo' }));
  expect(kitchen().getByRole('article', { name: 'Prep: Mozzarella Blend' })).toBeTruthy();
  expect(row('Mozzarella Blend').getByText('2,000 g')).toBeTruthy();
});

test('customers come first: a PREP ticket waits after the orders, and the Register chip ignores it', async () => {
  appendEvent({ type: 'prep.ordered', at: Date.now() - 60_000, orderNumber: 0, actor: owner, ticketId: 'p1', prepId: 'Pizza Sauce Batch', name: 'Pizza Sauce Batch', qty: 1, unit: 'pcs' });
  const user = userEvent.setup();
  render(<><App onKitchen={() => {}} /><Kitchen /></>);
  expect(screen.getByRole('button', { name: 'Kitchen: nothing to make' })).toBeTruthy();

  await user.click(screen.getByRole('button', { name: /^Devilled Chicken/ }));
  await user.click(screen.getByRole('button', { name: /Large/ }));
  await user.click(screen.getByRole('button', { name: /^Add ·/ }));
  await user.click(screen.getByRole('button', { name: 'Send to kitchen' }));
  const cards = kitchen().getAllByRole('article').map((a) => a.getAttribute('aria-label'));
  expect(cards).toEqual(['Order 1001', 'Prep: Pizza Sauce Batch']);
  expect(screen.getByRole('button', { name: /^Kitchen: 1 to make/ })).toBeTruthy();
});

test('from the sheet: a number of batches, or the amount where the batch size is not known; Undo takes it back', async () => {
  const user = userEvent.setup();
  history.replaceState(null, '', '/#items/semi');
  render(<Root />);
  await user.click(semi().getByRole('button', { name: 'Mozzarella Blend' }));
  let sheet = within(screen.getByRole('dialog', { name: 'Mozzarella Blend' }));
  await user.clear(sheet.getByRole('textbox', { name: /Batches to make/ }));
  await user.type(sheet.getByRole('textbox', { name: /Batches to make/ }), '2');
  expect(sheet.getByText('· 4,000 g')).toBeTruthy();
  await user.click(sheet.getByRole('button', { name: 'Send to kitchen' }));
  expect(readAll().at(-1)).toMatchObject({ type: 'prep.ordered', prepId: 'Mozzarella Blend', qty: 4000 });
  const sentId = (readAll().at(-1) as { ticketId: string }).ticketId;
  await user.click(screen.getByRole('button', { name: 'Undo' }));
  expect(readAll().at(-1)).toMatchObject({ type: 'prep.order_undone', ticketId: sentId });
  await user.click(sheet.getByRole('button', { name: 'Close' }));

  // Penne Boil Batch: what a batch makes is not known yet, so the amount is typed.
  await user.click(semi().getByRole('button', { name: 'Penne Boil Batch' }));
  sheet = within(screen.getByRole('dialog', { name: 'Penne Boil Batch' }));
  await user.type(sheet.getByRole('textbox', { name: /How much to make/ }), '4');
  await user.click(sheet.getByRole('button', { name: 'Send to kitchen' }));
  expect(readAll().at(-1)).toMatchObject({ type: 'prep.ordered', prepId: 'Penne Boil Batch', qty: 4 });
});

test('"make more when below": Automatic or a number, with Undo', async () => {
  lowBlend();
  const user = userEvent.setup();
  history.replaceState(null, '', '/#items/semi');
  render(<Root />);
  await user.click(screen.getByRole('button', { name: 'Low' }));
  expect(semi().getByRole('button', { name: 'Mozzarella Blend' })).toBeTruthy();
  await user.click(semi().getByRole('button', { name: 'Mozzarella Blend' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Mozzarella Blend' }));
  await user.click(sheet.getByRole('button', { name: 'Change make more when below' }));
  await user.click(sheet.getByRole('button', { name: 'Automatic' }));
  await user.click(sheet.getByRole('button', { name: 'Save' }));
  expect(readAll().at(-1)).toMatchObject({ type: 'prep.limit_set', prepId: 'Mozzarella Blend', before: 3000, after: null });
  expect(sheet.getByText('automatic')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Undo' }));
  expect(readAll().at(-1)).toMatchObject({ type: 'prep.limit_set', before: null, after: 3000 });
});
