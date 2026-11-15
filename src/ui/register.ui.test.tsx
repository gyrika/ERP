import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { heldList } from './testHeld.ts';
import { App } from './App.tsx';
import { readAll } from './eventLog.ts';
import { setKitchenScreen } from './kitchenScreen.ts';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const panel = () => within(screen.getByRole('complementary', { name: 'Current order' }));
const sendBtn = () => screen.getByRole('button', { name: 'Send to kitchen' }) as HTMLButtonElement;

/** Customers eat first: send, then later open the order from the Orders list and pay. */
const sendThenOpen = async (user: ReturnType<typeof userEvent.setup>, number: number) => {
  await user.click(sendBtn());
  await user.click(heldList().getByRole('button', { name: new RegExp(`^${number}`) }));
  await user.click(screen.getByRole('button', { name: 'Pay' }));
};

test('tap size → send → waiting → charge exact → paid → undo payment', async () => {
  const user = userEvent.setup();
  render(<App />);
  expect(sendBtn().disabled).toBe(true);

  await user.click(screen.getAllByRole('button', { name: 'L 2,500' })[0]); // Devilled Chicken L
  expect(panel().getByText('Devilled Chicken')).toBeTruthy();
  expect(panel().getAllByText('2,500').length).toBeGreaterThan(0);
  expect(screen.getByRole('status').textContent).toContain('Added Devilled Chicken');

  await user.click(sendBtn());
  expect(screen.getByRole('status').textContent).toContain('Sent 1001 to kitchen');
  expect(panel().queryByText('Devilled Chicken')).toBeNull(); // register is free for the next customer
  expect(panel().getByText('1002')).toBeTruthy();

  await user.click(heldList().getByRole('button', { name: /^1001/ }));
  await user.click(screen.getByRole('button', { name: 'Pay' }));
  await user.click(screen.getByRole('button', { name: /Exact/ }));
  expect(panel().getByText('Paid')).toBeTruthy();

  await user.click(panel().getByRole('button', { name: 'Undo payment' }));
  expect(screen.getByRole('button', { name: 'Pay' })).toBeTruthy();
});

test('a second round on an open order: only new lines go out', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getAllByRole('button', { name: 'M 1,450' })[0]); // Margherita M
  await user.click(sendBtn());
  await user.click(heldList().getByRole('button', { name: /^1001/ }));
  await user.click(screen.getAllByRole('button', { name: 'M 1,450' })[0]); // another one
  expect(panel().getAllByText('Margherita').length).toBe(2); // not merged into the sent line
  await user.click(sendBtn());
  expect(screen.getByRole('status').textContent).toContain('Sent more for 1001');
  await user.click(heldList().getByRole('button', { name: /^1001/ }));
  expect(panel().getAllByText('2,900').length).toBeGreaterThan(0); // both rounds on 1001
});

test('cash over total shows change', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getAllByRole('button', { name: 'M 1,450' })[0]);
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
  expect(within(panel().getByRole('group', { name: 'How many Margherita' })).getByText('2')).toBeTruthy();
  expect(panel().getByText('Chicken Burger')).toBeTruthy();
  // 2 × 1990 + 450 = 4,430
  expect(panel().getAllByText('4,430').length).toBeGreaterThan(0);
});

test('what the parser cannot read is logged once: Enter keeps the rest for fixing, Esc on it adds nothing more', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.keyboard('2 l margherita, bbq chkn');
  await screen.findByText('2 × Margherita · Large');
  await screen.findByText('? bbq chkn');
  await user.keyboard('{Enter}');
  expect((screen.getByLabelText('Type an order') as HTMLInputElement).value).toBe('bbq chkn');
  await user.keyboard('{Escape}');
  const misses = readAll().filter((e) => e.type === 'shorthand.missed');
  expect(misses).toHaveLength(1);
  expect(misses[0]).toMatchObject({ text: '2 l margherita, bbq chkn', unresolved: ['bbq chkn'], gaveUp: false, orderNumber: 0 });
});

test('Esc on text the parser cannot read logs that the cashier gave up', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.keyboard('qwerty special');
  await screen.findByText('? qwerty special');
  await user.keyboard('{Escape}');
  expect(readAll().filter((e) => e.type === 'shorthand.missed')).toMatchObject([{ text: 'qwerty special', unresolved: ['qwerty special'], gaveUp: true }]);
});

test('Undo removes the last add', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getAllByRole('button', { name: 'M 1,450' })[0]);
  await user.click(screen.getByRole('button', { name: 'Undo' }));
  expect(sendBtn().disabled).toBe(true);
});

test('Escape (+ New order) leaves an opened order on the list; a stray tap never does; menu taps add a round', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getAllByRole('button', { name: 'M 1,450' })[0]);
  await user.click(sendBtn());
  const rail = () => heldList();

  await user.click(rail().getByRole('button', { name: /^1001/ }));
  expect(panel().getByText('Margherita')).toBeTruthy();
  await user.click(screen.getByRole('main')); // empty space beside the menu: nothing happens
  expect(panel().getByText('Margherita')).toBeTruthy();
  await user.keyboard('{Escape}');
  expect(panel().queryByText('Margherita')).toBeNull();
  expect(rail().getByRole('button', { name: /^1001/ })).toBeTruthy(); // still on the list

  await user.click(rail().getByRole('button', { name: /^1001/ }));
  await user.click(screen.getAllByRole('button', { name: '450' })[0]); // a menu tap adds a round, it does not leave
  expect(panel().getByText('Chicken Burger')).toBeTruthy();
});

test('+ New order with something on the order: it keeps its number and waits on the list, not sent', async () => {
  const user = userEvent.setup();
  render(<App />);
  const rail = () => heldList();
  await user.click(screen.getAllByRole('button', { name: 'M 1,450' })[0]);
  await user.click(screen.getByRole('button', { name: 'New bill' }));
  expect(panel().queryByText('Margherita')).toBeNull();
  expect(rail().getByRole('button', { name: /^1001.*Not sent.*Not paid/ })).toBeTruthy();

  await user.click(screen.getAllByRole('button', { name: '450' })[0]); // the next customer
  await user.click(sendBtn());
  expect(screen.getByRole('status').textContent).toContain('Sent 1002 to kitchen');
  expect(readAll().filter((e) => e.type === 'order.sent')).toHaveLength(1);

  // Back to 1001: its line is there, and it goes to the kitchen with its own number.
  await user.click(rail().getByRole('button', { name: /^1001/ }));
  expect(panel().getByText('Margherita')).toBeTruthy();
  await user.click(sendBtn());
  expect(screen.getByRole('status').textContent).toContain('Sent 1001 to kitchen');
  expect(rail().getByRole('button', { name: /^1001.*Waiting.*Not paid/ })).toBeTruthy();
});

test('pay first, send after: the kitchen sees nothing until Send; the sale counts at once', async () => {
  const user = userEvent.setup();
  render(<App />);
  const rail = () => heldList();
  await user.click(screen.getAllByRole('button', { name: 'L 2,500' })[0]);
  await user.click(screen.getByRole('button', { name: 'Pay' }));
  await user.click(screen.getByRole('button', { name: /Exact/ }));
  await user.click(screen.getByRole('button', { name: 'New bill' }));

  // Paid, held: the sale and its lines are written, the kitchen is not told.
  const sent = readAll().filter((e) => e.type === 'order.sent');
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ orderNumber: 1001, held: true });
  expect(readAll().some((e) => e.type === 'order.paid')).toBe(true);
  expect(rail().getByRole('button', { name: /^1001.*Not sent.*Paid/ })).toBeTruthy();

  // Elsewhere and back: Send is still there.
  await user.click(screen.getAllByRole('button', { name: '450' })[0]);
  expect(panel().getByText('Chicken Burger')).toBeTruthy(); // a new order, not added to the paid one
  await user.keyboard('{Escape}');
  await user.click(rail().getByRole('button', { name: /^1001/ }));
  await user.click(screen.getByRole('button', { name: 'Send to kitchen' }));
  expect(readAll().filter((e) => e.type === 'order.released')).toMatchObject([{ orderNumber: 1001, ticketId: sent[0].type === 'order.sent' ? sent[0].ticketId : '' }]);
  expect(rail().getByRole('button', { name: /^1001.*Waiting.*Paid/ })).toBeTruthy();
});

test('undoing a payment made before Send takes the held send back too', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getAllByRole('button', { name: 'L 2,500' })[0]);
  await user.click(screen.getByRole('button', { name: 'Pay' }));
  await user.click(screen.getByRole('button', { name: /Exact/ }));
  await user.click(panel().getByRole('button', { name: 'Undo payment' }));
  expect(readAll().map((e) => e.type)).toEqual(['order.sent', 'order.paid', 'order.send_undone', 'order.payment_undone']);
  expect(screen.getByRole('button', { name: 'Send to kitchen' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Pay' })).toBeTruthy();
});

test('the order list labels unpaid and paid orders clearly', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getAllByRole('button', { name: 'M 1,450' })[0]);
  await user.click(sendBtn()); // 1001
  await user.click(screen.getAllByRole('button', { name: '450' })[0]);
  await user.click(sendBtn()); // 1002
  await user.click(heldList().getByRole('button', { name: /^1001/ }));
  // The opened order: its number as a badge, how it stands in one word, and Charge (so: not paid).
  expect(within(panel().getByText('1001').parentElement!).getByText('Bill No')).toBeTruthy();
  expect(panel().getByText('Waiting')).toBeTruthy();
  expect(panel().queryByText('Unpaid')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Pay' }));
  expect(panel().getByText('Paying')).toBeTruthy(); // Charge opens in the panel itself
  await user.click(screen.getByRole('button', { name: '2,000' }));
  await user.click(screen.getByRole('button', { name: 'New bill' }));

  const waiting = heldList();
  // A row: the number, a word for the kitchen, a word for the money.
  expect(waiting.getByRole('button', { name: /^1002.*Waiting.*Not paid/ })).toBeTruthy();
  expect(waiting.getByRole('button', { name: /^1001.*Waiting.*Paid/ })).toBeTruthy(); // paid, not made yet: still listed

  const paid = within((heldList(), panel().getByRole('region', { name: 'Paid today' })));
  expect(paid.getByText('1001')).toBeTruthy();
  expect(paid.getByText('Paid · Cash')).toBeTruthy();
  expect(paid.queryByRole('button')).toBeNull(); // nothing left to do on a paid order
});

test('bank transfer pays the full total in one tap', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getAllByRole('button', { name: 'M 1,450' })[0]);
  await sendThenOpen(user, 1001);
  await user.click(screen.getByRole('button', { name: 'Bank transfer' }));
  await user.click(screen.getByRole('button', { name: 'New bill' }));
  const paid = within((heldList(), panel().getByRole('region', { name: 'Paid today' })));
  expect(paid.getByText('Paid · Bank transfer')).toBeTruthy();
});

test('the toast never covers an open sheet', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getAllByRole('button', { name: 'M 1,450' })[0]);
  await user.click(sendBtn());
  expect(screen.getByText('Sent 1001 to kitchen')).toBeTruthy();
  await user.click(heldList().getByRole('button', { name: /^1001/ }));
  await user.click(screen.getByRole('button', { name: 'Pay' }));
  expect(screen.queryByText('Sent 1001 to kitchen')).toBeNull();
  expect(screen.getByRole('button', { name: 'Card' })).toBeTruthy();
});

test('typing a printed menu number adds that pizza: "5 L" is a large Devilled Chicken', async () => {
  const user = userEvent.setup();
  render(<App />);
  expect(screen.getAllByText('5').length).toBeGreaterThan(0); // the number is on the card, so staff learn it
  await user.keyboard('5');
  await user.keyboard(' L{Enter}');
  expect(panel().getByText(/Devilled Chicken/)).toBeTruthy();
  expect(panel().getByText(/Large/)).toBeTruthy();
});

test('half-and-half: pick the other half in the pizza sheet, priced half of each', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getAllByRole('button', { name: /Margherita/ }).find((b) => b.classList.contains('card__title'))!);
  const sheet = within(screen.getByRole('region', { name: 'Margherita extras' }));
  expect(screen.queryByRole('dialog')).toBeNull(); // in the order panel, not a pop-up
  await user.click(sheet.getByRole('button', { name: 'Half & half…' }));
  await user.click(sheet.getByRole('button', { name: '½ Seafood' }));
  expect(sheet.getByRole('heading', { name: '½ Margherita + ½ Seafood' })).toBeTruthy();
  await user.click(sheet.getByRole('button', { name: /^Large/ }));
  await user.click(sheet.getByRole('button', { name: 'No tomato' })); // Seafood's leave-out
  await user.click(sheet.getByRole('button', { name: 'Add · 2,595' }));

  expect(panel().getByText('½ Margherita + ½ Seafood')).toBeTruthy();
  expect(panel().getByText('Large · No tomato')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain('Added ½ Margherita + ½ Seafood');

  // Back to a whole pizza drops the leave-out only Seafood had.
  await user.click(panel().getByText('½ Margherita + ½ Seafood'));
  const edit = within(screen.getByRole('region', { name: 'Margherita extras' }));
  await user.click(edit.getByRole('button', { name: 'Whole pizza' }));
  expect(edit.queryByRole('button', { name: 'No tomato' })).toBeNull();
  await user.click(edit.getByRole('button', { name: 'Update · 1,990' }));
  expect(panel().getByText('Margherita')).toBeTruthy();
});

test('an Uber Eats order: the Uber Eats key, the code, the items; sent with the mark; closed as paid by Uber, no cash asked', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole('button', { name: /^Uber Eats/ }));
  const sheet = within(screen.getByRole('dialog', { name: 'Uber Eats order' }));
  const start = sheet.getByRole('button', { name: /Start order/ }) as HTMLButtonElement;
  expect(start.disabled).toBe(true);
  await user.type(sheet.getByLabelText('Uber Eats order code'), ' 4f2a9{Enter}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(panel().getByText('Uber Eats · 4F2A9')).toBeTruthy();

  await user.click(screen.getAllByRole('button', { name: 'M 1,450' })[0]); // Margherita M
  await user.click(sendBtn());
  const sent = readAll().find((e) => e.type === 'order.sent');
  expect(sent).toMatchObject({ orderNumber: 1001, platform: { id: 'uber', code: '4F2A9' } });

  const row = heldList().getByRole('button', { name: /^1001/ });
  expect(within(row).getByText('Uber Eats · 4F2A9')).toBeTruthy();
  await user.click(row);
  expect(screen.queryByRole('button', { name: 'Pay' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Close · Uber Eats' }));
  expect(screen.queryByRole('dialog')).toBeNull(); // no pay sheet: Uber pays the shop
  expect(readAll().find((e) => e.type === 'order.paid')).toMatchObject({ orderNumber: 1001, tender: 'uber', total: 145000, tendered: 145000 });
  expect(panel().getByText('Paid')).toBeTruthy();
});

test('the Uber Eats mark comes off with ×, before the order is sent', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole('button', { name: /^Uber Eats/ }));
  await user.type(within(screen.getByRole('dialog', { name: 'Uber Eats order' })).getByLabelText('Uber Eats order code'), 'AB12{Enter}');
  await user.click(panel().getByRole('button', { name: 'Not from Uber Eats' }));
  expect(panel().queryByText('Uber Eats · AB12')).toBeNull();
});

test('− / + on the line just added: one more, one fewer, and below one it comes off with Undo (SCRUM-236)', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getAllByRole('button', { name: 'M 1,450' })[0]); // Margherita M
  await user.click(panel().getByRole('button', { name: 'One more Margherita' }));
  expect(within(panel().getByRole('group', { name: 'How many Margherita' })).getByText('2')).toBeTruthy();
  expect(panel().getAllByText('2,900').length).toBeGreaterThan(0);
  await user.click(panel().getByRole('button', { name: 'One fewer Margherita' }));
  await user.click(panel().getByRole('button', { name: 'Remove Margherita' }));
  expect(panel().queryByText('Margherita')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Undo' }));
  expect(panel().getByText('Margherita')).toBeTruthy();
});

test('every line not yet sent has − / +; a sent line keeps them greyed', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getAllByRole('button', { name: 'M 1,450' })[0]);
  await user.click(screen.getAllByRole('button', { name: '450' })[0]); // Chicken Burger
  expect((panel().getByRole('button', { name: 'One more Margherita' }) as HTMLButtonElement).disabled).toBe(false);
  expect((panel().getByRole('button', { name: 'One more Chicken Burger' }) as HTMLButtonElement).disabled).toBe(false);
  await user.click(sendBtn());
  await user.click(heldList().getByRole('button', { name: /^1001/ }));
  expect((panel().getByRole('button', { name: 'One more Margherita' }) as HTMLButtonElement).disabled).toBe(true);
});

test('Held bills counts the other bills still going', async () => {
  const user = userEvent.setup();
  render(<App />);
  expect(screen.getByRole('button', { name: 'Held bills: 0' })).toBeTruthy();
  await user.click(screen.getAllByRole('button', { name: 'M 1,450' })[0]);
  expect(screen.getByRole('button', { name: 'Held bills: 0' })).toBeTruthy(); // the bill on screen is not held
  await user.click(sendBtn());
  expect(screen.getByRole('button', { name: 'Held bills: 1' })).toBeTruthy();
});

test('the always-visible "Type or search" field opens typed shorthand', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByLabelText('Type or search… e.g. 2 L pepperoni'));
  await user.keyboard('2 burger{Enter}');
  expect(within(panel().getByRole('group', { name: 'How many Chicken Burger' })).getByText('2')).toBeTruthy();
});

// These tests are about the kitchen flow: the Kitchen view on (it is off on a new counter).
beforeEach(() => setKitchenScreen(true));
