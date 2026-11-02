import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FAKE_STAFF } from '../fake/data.ts';
import { moneyOutFromEvents } from '../domain/moneyOut.ts';
import { currentCashier } from '../services/auth.ts';
import { App } from './App.tsx';
import { appendEvent, readAll } from './eventLog.ts';
import { MoneyOutView } from './MoneyOutView.tsx';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const pin = FAKE_STAFF.find((s) => s.actor.role === 'manager')!.pin;
const owner = FAKE_STAFF.find((s) => s.actor.role === 'owner')!.actor;
const live = () => moneyOutFromEvents(readAll());

test('cashier: F6, Gas, the amount, Enter: recorded at once from the drawer, with Undo', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.keyboard('{F6}');
  const sheet = screen.getByRole('dialog', { name: 'Money out' });
  // A cashier pays cash from the drawer only, and never rent or wages.
  expect(within(sheet).queryByRole('button', { name: /Rent/ })).toBeNull();
  expect(within(sheet).queryByRole('button', { name: /Wages/ })).toBeNull();
  expect(within(sheet).queryByRole('group', { name: 'Paid from' })).toBeNull();

  await user.click(within(sheet).getByRole('button', { name: /Gas/ }));
  await user.keyboard('2500{Enter}');
  expect(screen.queryByRole('dialog', { name: 'Money out' })).toBeNull();
  expect(live()).toMatchObject([{ what: 'gas', from: 'drawer', cents: 250000 }]);

  await user.click(within(screen.getByRole('status')).getByRole('button', { name: 'Undo' }));
  expect(live()).toEqual([]);
});

test('the amount typed is what is stored, in cents', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole('button', { name: /Money out/ }));
  await user.click(screen.getByRole('button', { name: /Gas/ }));
  await user.type(screen.getByRole('textbox', { name: /How much/ }), '1250.50');
  await user.click(screen.getByRole('button', { name: 'Record Rs 1,250.50' }));
  expect(live()[0].cents).toBe(125050);
});

test('Other needs a note, and nothing records until it has one', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.keyboard('{F6}');
  await user.click(screen.getByRole('button', { name: /Other/ }));
  await user.keyboard('500');
  expect((screen.getByRole('button', { name: 'Say what it was' }) as HTMLButtonElement).disabled).toBe(true);
  await user.keyboard('{Enter}');
  expect(live()).toEqual([]);
  await user.type(screen.getByRole('textbox', { name: 'What was it?' }), 'Bulbs{Enter}');
  expect(live()).toMatchObject([{ what: 'other', note: 'Bulbs', cents: 50000 }]);
});

test('Esc closes the sheet without recording', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.keyboard('{F6}');
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: 'Money out' })).toBeNull();
  expect(live()).toEqual([]);
});

test('manager mode: rent from the bank, signed by the manager', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.keyboard('{Control>}m{/Control}');
  await user.keyboard(pin);
  await user.keyboard('{F6}');
  const sheet = screen.getByRole('dialog', { name: 'Money out' });
  await user.click(within(sheet).getByRole('button', { name: /Rent/ }));
  await user.keyboard('60000');
  await user.click(within(sheet).getByRole('button', { name: 'Bank' }));
  await user.click(within(sheet).getByRole('button', { name: /Record/ }));
  expect(live()).toMatchObject([{ what: 'rent', from: 'bank', cents: 6000000, actor: { role: 'manager' } }]);
});

test('the page totals the month without supplier payments, and Remove has an Undo', async () => {
  const at = Date.now();
  const actor = currentCashier();
  appendEvent({ type: 'money.out', at, orderNumber: 0, actor, what: 'gas', from: 'drawer', cents: 250000 });
  appendEvent({ type: 'money.out', at, orderNumber: 0, actor: owner, what: 'supplier', from: 'drawer', cents: 700000, supplierId: 's1', note: 'Veg shop' });
  const user = userEvent.setup();
  render(<MoneyOutView />);
  const page = screen.getByRole('main', { name: 'Money out' });
  expect(page.querySelector('.money-out__total')?.textContent).toContain('Rs 2,500');
  expect(within(page).getByText(/already in food cost/).textContent).toContain('Rs 7,000');
  expect(within(page).getByText(/Cash from the drawer today/).textContent).toContain('Rs 9,500');

  await user.click(within(page).getByRole('button', { name: 'Remove Rs 2,500 Gas' }));
  expect(page.querySelector('.money-out__total')?.textContent).toContain('Rs 0');
  await user.click(within(screen.getByRole('status')).getByRole('button', { name: 'Undo' }));
  expect(page.querySelector('.money-out__total')?.textContent).toContain('Rs 2,500');
});

test("someone's entry offers Remove only to them or a manager", () => {
  appendEvent({ type: 'money.out', at: Date.now(), orderNumber: 0, actor: owner, what: 'rent', from: 'bank', cents: 100 });
  render(<MoneyOutView />);
  expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
});

test('the month steps back, and never past this month', async () => {
  const user = userEvent.setup();
  render(<MoneyOutView />);
  const later = screen.getByRole('button', { name: 'Month after' }) as HTMLButtonElement;
  expect(later.disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Month before' }));
  expect(later.disabled).toBe(false);
});
