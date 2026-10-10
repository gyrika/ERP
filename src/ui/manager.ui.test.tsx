import { act } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEV_PINS } from '../domain/auth.ts';
import { App } from './App.tsx';
import { Kitchen } from './Kitchen.tsx';
import { readEvents } from './eventLog.ts';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

type User = ReturnType<typeof userEvent.setup>;
const pinFor = (role: string) => Object.entries(DEV_PINS).find(([, a]) => a.role === role)![0];
const panel = () => within(screen.getByRole('complementary', { name: 'Current order' }));
const kitchen = () => within(screen.getByRole('main', { name: 'Orders to make' }));

/** 1001 = Margherita M + Chicken Burger, sent, then opened again from "Waiting to pay". */
const sendAndReopen = async (user: User) => {
  await user.click(screen.getAllByRole('button', { name: 'M 1450' })[0]);
  await user.click(screen.getAllByRole('button', { name: '450' })[0]);
  await user.click(panel().getByRole('button', { name: 'Send to kitchen' }));
  await user.click(panel().getByRole('button', { name: /^1001/ }));
};

const askManager = async (user: User, pin = pinFor('manager')) => {
  await user.click(panel().getByRole('button', { name: 'Ask manager' }));
  await user.keyboard(pin); // the PIN field is focused: one key press + the PIN
};

test('a cashier cannot touch sent items; a wrong or cashier PIN does not unlock', async () => {
  const user = userEvent.setup();
  render(<App />);
  await sendAndReopen(user);
  expect(panel().queryByRole('button', { name: /Margherita/ })).toBeNull();

  await askManager(user, pinFor('cashier'));
  expect(screen.getByRole('alert').textContent).toContain('PIN not accepted');
  await user.keyboard('0000');
  expect(screen.getByRole('alert')).toBeTruthy();
  await user.keyboard('{Escape}');
  expect(panel().queryByRole('button', { name: /Margherita/ })).toBeNull();
  expect(readEvents().filter((e) => e.type.startsWith('order.item_'))).toEqual([]);
});

test('manager changes a sent item: reason required, kitchen shows old struck + new, event logged, control returns', async () => {
  const user = userEvent.setup();
  render(<><App /><Kitchen /></>);
  await sendAndReopen(user);
  await user.click(kitchen().getByRole('button', { name: 'Seen: Order 1001' })); // kitchen saw the original

  await askManager(user);
  expect(panel().getByText(/Manager · tap a sent item/)).toBeTruthy();
  await user.click(panel().getByRole('button', { name: /Margherita/ }));

  const sheet = within(screen.getByRole('dialog'));
  await user.click(sheet.getByRole('button', { name: /^Large/ }));
  const save = sheet.getByRole('button', { name: /^Save change/ });
  await user.click(save); // no reason yet: it says so instead of doing nothing
  expect(sheet.getByRole('alert').textContent).toBe('Pick a reason first');
  await user.click(sheet.getByRole('button', { name: 'Customer changed mind' }));
  expect(sheet.queryByRole('alert')).toBeNull();
  await user.click(save);

  // Bill: Large 1990 + burger 450.
  expect(panel().getAllByText('2,440').length).toBeGreaterThan(0);
  // Control is back with the cashier: sent lines locked again.
  expect(panel().queryByRole('button', { name: /Margherita/ })).toBeNull();
  expect(panel().getByRole('button', { name: 'Ask manager' })).toBeTruthy();

  // Kitchen: Changed, flashing again, old struck through, new beside it.
  const ticket = within(kitchen().getByRole('article', { name: 'Order 1001, changed' }));
  expect(ticket.getByText('Changed')).toBeTruthy();
  expect(kitchen().getByRole('button', { name: 'Seen: Order 1001, changed' })).toBeTruthy();
  const struck = ticket.getAllByText('Margherita')[0].closest('s');
  expect(struck?.textContent).toContain('Medium');
  expect(ticket.getByText('Large')).toBeTruthy();

  const [event] = readEvents().filter((e) => e.type === 'order.item_changed');
  expect(event).toMatchObject({
    type: 'order.item_changed', orderNumber: 1001, reason: 'Customer changed mind',
    actor: { role: 'manager' }, before: { itemId: 'margherita', size: 'M' }, after: { itemId: 'margherita', size: 'L' },
  });
  expect(typeof event.at).toBe('number');
});

test('manager cancels a sent item: struck "Cancelled" in the kitchen, even on a ticket already Done', async () => {
  const user = userEvent.setup();
  render(<><App /><Kitchen /></>);
  await sendAndReopen(user);
  await user.click(kitchen().getByRole('button', { name: 'Done: Order 1001' }));
  expect(kitchen().getByText('No orders waiting')).toBeTruthy();

  await askManager(user);
  await user.click(panel().getByRole('button', { name: /Chicken Burger/ }));
  const sheet = within(screen.getByRole('dialog'));
  await user.click(sheet.getByRole('button', { name: 'Other' }));
  await user.type(sheet.getByLabelText('Reason'), 'Customer left');
  await user.click(sheet.getByRole('button', { name: 'Cancel item' }));

  expect(panel().queryByText('Chicken Burger')).toBeNull();
  expect(panel().getAllByText('1,450').length).toBeGreaterThan(0);
  const ticket = within(kitchen().getByRole('article', { name: 'Order 1001, changed' })); // reopened
  expect(ticket.getByText('Cancelled')).toBeTruthy();
  expect(ticket.getByText('Chicken Burger').closest('s')).toBeTruthy();
  expect(readEvents().find((e) => e.type === 'order.item_cancelled')).toMatchObject({
    reason: 'Customer left', actor: { role: 'manager' }, before: { itemId: 'chicken-burger' },
  });
});

test('cancelling every item takes the order off "Waiting to pay"', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getAllByRole('button', { name: 'M 1450' })[0]);
  await user.click(panel().getByRole('button', { name: 'Send to kitchen' }));
  await user.click(panel().getByRole('button', { name: /^1001/ }));
  await askManager(user);
  await user.click(panel().getByRole('button', { name: /Margherita/ }));
  const sheet = within(screen.getByRole('dialog'));
  await user.click(sheet.getByRole('button', { name: 'Wrong item entered' }));
  await user.click(sheet.getByRole('button', { name: 'Cancel item' }));
  expect(panel().queryByRole('region', { name: 'Waiting to pay' })).toBeNull();
});

test('a cashier can undo a send only straight after it', async () => {
  const user = userEvent.setup();
  render(<><App /><Kitchen /></>);
  await user.click(screen.getAllByRole('button', { name: 'M 1450' })[0]);
  await user.click(panel().getByRole('button', { name: 'Send to kitchen' }));
  await user.click(screen.getAllByRole('button', { name: '450' })[0]); // next customer: the send is now sealed
  await user.keyboard('{Control>}z{/Control}');
  await user.keyboard('{Control>}z{/Control}');
  expect(kitchen().getByRole('article', { name: 'Order 1001' })).toBeTruthy();
});

test('sends and payments are in the same event log as changes', async () => {
  const user = userEvent.setup();
  render(<App />);
  await sendAndReopen(user);
  await user.click(panel().getByRole('button', { name: 'Charge' }));
  await user.click(screen.getByRole('button', { name: /Exact/ }));
  expect(readEvents().map((e) => e.type)).toEqual(['order.sent', 'order.paid']);
  expect(readEvents()[1]).toMatchObject({ orderNumber: 1001, total: 190000, tender: 'cash', actor: { role: 'cashier' } });
});

test('Cancel item without a reason explains itself, then works once a reason is picked', async () => {
  const user = userEvent.setup();
  render(<><App /><Kitchen /></>);
  await sendAndReopen(user);
  await askManager(user);
  await user.click(panel().getByRole('button', { name: /Chicken Burger/ }));
  const sheet = within(screen.getByRole('dialog'));

  await user.click(sheet.getByRole('button', { name: 'Cancel item' }));
  expect(sheet.getByRole('alert').textContent).toBe('Pick a reason first');
  expect(document.activeElement?.textContent).toBe('Customer changed mind'); // focus moved to the reasons
  expect(panel().getByText('Chicken Burger')).toBeTruthy(); // nothing cancelled yet

  await user.click(sheet.getByRole('button', { name: 'Out of stock' }));
  await user.click(sheet.getByRole('button', { name: 'Cancel item' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(panel().queryByText('Chicken Burger')).toBeNull();
  expect(kitchen().getByText('Cancelled')).toBeTruthy();
});

test('Save change stays off until something is actually changed', async () => {
  const user = userEvent.setup();
  render(<App />);
  await sendAndReopen(user);
  await askManager(user);
  await user.click(panel().getByRole('button', { name: /Margherita/ }));
  const sheet = within(screen.getByRole('dialog'));
  await user.click(sheet.getByRole('button', { name: 'Wrong item entered' }));
  expect((sheet.getByRole('button', { name: /^Save change/ }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(sheet.getByRole('button', { name: 'Increase quantity' }));
  expect((sheet.getByRole('button', { name: /^Save change/ }) as HTMLButtonElement).disabled).toBe(false);
});

test('the manager unlock does not lapse mid-edit, and a lapsed unlock never leaves the register stuck', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<App />);
    await sendAndReopen(user);
    await askManager(user);
    await user.click(panel().getByRole('button', { name: /Chicken Burger/ }));
    act(() => { vi.advanceTimersByTime(90_000); }); // manager is slow to decide
    const sheet = within(screen.getByRole('dialog'));
    await user.click(sheet.getByRole('button', { name: 'Out of stock' }));
    await user.click(sheet.getByRole('button', { name: 'Cancel item' }));
    expect(panel().queryByText('Chicken Burger')).toBeNull();

    // Unlock, walk away: it lapses and the register still takes typing.
    await askManager(user);
    act(() => { vi.advanceTimersByTime(61_000); });
    expect(panel().getByRole('button', { name: 'Ask manager' })).toBeTruthy();
    await user.keyboard('m');
    expect(screen.getByLabelText('Type an order')).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});
