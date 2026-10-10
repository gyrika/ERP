import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App.tsx';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const panel = () => within(screen.getByRole('complementary', { name: 'Current order' }));
const sendBtn = () => panel().getByRole('button', { name: 'Send to kitchen' }) as HTMLButtonElement;

/** Customers eat first: send, then later open the order from "Waiting to pay" and charge. */
const sendThenOpen = async (user: ReturnType<typeof userEvent.setup>, number: number) => {
  await user.click(sendBtn());
  await user.click(within(panel().getByRole('region', { name: 'Waiting to pay' })).getByRole('button', { name: new RegExp(`^${number}`) }));
  await user.click(panel().getByRole('button', { name: 'Charge' }));
};

test('tap size → send → waiting → charge exact → paid → undo payment', async () => {
  const user = userEvent.setup();
  render(<App />);
  expect(sendBtn().disabled).toBe(true);

  await user.click(screen.getAllByRole('button', { name: 'L 2500' })[0]); // Devilled Chicken L
  expect(panel().getByText('Devilled Chicken')).toBeTruthy();
  expect(panel().getAllByText('2,500').length).toBeGreaterThan(0);
  expect(screen.getByRole('status').textContent).toContain('Added Devilled Chicken');

  await user.click(sendBtn());
  expect(screen.getByRole('status').textContent).toContain('Sent 1001 to kitchen');
  expect(panel().queryByText('Devilled Chicken')).toBeNull(); // register is free for the next customer
  expect(panel().getByText('1002')).toBeTruthy();

  await user.click(panel().getByRole('button', { name: /^1001/ }));
  await user.click(panel().getByRole('button', { name: 'Charge' }));
  await user.click(screen.getByRole('button', { name: /Exact/ }));
  expect(panel().getByText('Paid')).toBeTruthy();

  await user.click(panel().getByRole('button', { name: 'Undo payment' }));
  expect(panel().getByRole('button', { name: 'Charge' })).toBeTruthy();
});

test('a second round on an open order: sent lines are locked, only new ones go out', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getAllByRole('button', { name: 'M 1450' })[0]); // Margherita M
  await user.click(sendBtn());
  await user.click(panel().getByRole('button', { name: /^1001/ }));
  // The sent pizza is shown but cannot be edited.
  expect(panel().queryByRole('button', { name: /Margherita/ })).toBeNull();
  await user.click(screen.getAllByRole('button', { name: 'M 1450' })[0]); // another one
  expect(panel().getAllByText('Margherita').length).toBe(2); // not merged into the sent line
  await user.click(sendBtn());
  expect(screen.getByRole('status').textContent).toContain('Sent more for 1001');
  expect(panel().getByText('2,900')).toBeTruthy(); // waiting list total for 1001
});

test('cash over total shows change', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getAllByRole('button', { name: 'M 1450' })[0]);
  await sendThenOpen(user, 1001);
  await user.click(screen.getByRole('button', { name: '2,000' }));
  expect(panel().getByText('Change')).toBeTruthy();
  expect(panel().getByText('550')).toBeTruthy();
});

test('extras sheet prices the line and edits it', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole('button', { name: /^Devilled Chicken/ }));
  await user.click(screen.getByRole('button', { name: /Large/ }));
  await user.click(screen.getByRole('button', { name: /Full cheese/ }));
  await user.click(screen.getByRole('button', { name: /No onion/ }));
  const add = screen.getByRole('button', { name: /^Add ·/ });
  expect(add.textContent).toContain('3,100'); // matches the design: Large 2,500 + Full cheese 600
  await user.click(add);
  expect(panel().getByText('Large · Full cheese · No onion')).toBeTruthy();
  expect(panel().getAllByText('3,100').length).toBeGreaterThan(0);
});

test('typing shorthand builds the order after one Enter', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.keyboard('2 l margherita, burger no tomato');
  const input = screen.getByLabelText('Type an order') as HTMLInputElement;
  expect(input.value).toBe('2 l margherita, burger no tomato');
  await screen.findByText('2 × Margherita · Large');
  await user.keyboard('{Enter}');
  expect(panel().getByText('2 × Margherita')).toBeTruthy();
  expect(panel().getByText('Chicken Burger')).toBeTruthy();
  // 2 × 1990 + 450 = 4,430
  expect(panel().getAllByText('4,430').length).toBeGreaterThan(0);
});

test('Undo removes the last add', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getAllByRole('button', { name: 'M 1450' })[0]);
  await user.click(screen.getByRole('button', { name: 'Undo' }));
  expect(sendBtn().disabled).toBe(true);
});

test('tapping the background or pressing Escape leaves an opened order; menu taps still add a round', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getAllByRole('button', { name: 'M 1450' })[0]);
  await user.click(sendBtn());
  const waiting = () => panel().queryByRole('region', { name: 'Waiting to pay' });

  await user.click(panel().getByRole('button', { name: /^1001/ }));
  expect(waiting()).toBeNull();
  await user.click(panel().getByText('Margherita')); // the bill itself is not background
  expect(waiting()).toBeNull();
  await user.click(screen.getByRole('main')); // empty space beside the menu
  expect(waiting()).toBeTruthy();

  await user.click(panel().getByRole('button', { name: /^1001/ }));
  await user.keyboard('{Escape}');
  expect(waiting()).toBeTruthy();

  await user.click(panel().getByRole('button', { name: /^1001/ }));
  await user.click(screen.getAllByRole('button', { name: '450' })[0]); // a menu tap adds a round, it does not leave
  expect(panel().getByText('Chicken Burger')).toBeTruthy();
});

test('the order list labels unpaid and paid orders clearly', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getAllByRole('button', { name: 'M 1450' })[0]);
  await user.click(sendBtn()); // 1001
  await user.click(screen.getAllByRole('button', { name: '450' })[0]);
  await user.click(sendBtn()); // 1002
  await sendThenOpen(user, 1001);
  expect(panel().getByText('Unpaid')).toBeTruthy(); // the opened order says it is unpaid
  await user.click(screen.getByRole('button', { name: '2,000' }));
  await user.click(panel().getByRole('button', { name: 'Next order' }));

  const waiting = within(panel().getByRole('region', { name: 'Waiting to pay' }));
  expect(waiting.getByRole('button', { name: /^1002.*Unpaid$/ })).toBeTruthy();

  const paid = within(panel().getByRole('region', { name: 'Paid today' }));
  expect(paid.getByText('1001')).toBeTruthy();
  expect(paid.getByText('Paid · Cash')).toBeTruthy();
  expect(paid.queryByRole('button')).toBeNull(); // nothing left to do on a paid order
});

test('the toast never covers an open sheet', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getAllByRole('button', { name: 'M 1450' })[0]);
  await user.click(sendBtn());
  expect(screen.getByText('Sent 1001 to kitchen')).toBeTruthy();
  await user.click(panel().getByRole('button', { name: /^1001/ }));
  await user.click(panel().getByRole('button', { name: 'Charge' }));
  expect(screen.queryByText('Sent 1001 to kitchen')).toBeNull();
  expect(screen.getByRole('button', { name: 'Card' })).toBeTruthy();
});
