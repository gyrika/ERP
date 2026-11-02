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
  // Keys pick the size, then the box takes the amount.
  await user.keyboard('2');
  await user.keyboard('2500{Enter}');
  expect(screen.queryByRole('dialog', { name: 'Money out' })).toBeNull();
  expect(live()).toMatchObject([{ what: 'gas', from: 'drawer', cents: 250000, choiceId: 'gas-5', note: '5kg', qty: 1 }]);

  await user.click(within(screen.getByRole('status')).getByRole('button', { name: 'Undo' }));
  expect(live()).toEqual([]);
});

test('the amount typed is what is stored, in cents', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole('button', { name: /Money out/ }));
  await user.click(screen.getByRole('button', { name: /Other/ }));
  await user.type(screen.getByRole('textbox', { name: 'What was it?' }), 'Bulbs');
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
  await user.keyboard('1');
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

const payGas = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.keyboard('{F6}');
  await user.click(screen.getByRole('button', { name: /Gas/ }));
};

test('gas: nothing records without a size; the last price fills in per cylinder, follows how many, and stays editable', async () => {
  const user = userEvent.setup();
  render(<App />);
  await payGas(user);
  expect((screen.getByRole('button', { name: 'Choose the size' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: /^2\s*5kg$/ }));
  await user.keyboard('1650{Enter}');
  expect(live()).toMatchObject([{ choiceId: 'gas-5', cents: 165000 }]);

  await payGas(user);
  await user.click(screen.getByRole('button', { name: /^2\s*5kg$/ }));
  const amount = screen.getByRole('textbox', { name: /How much/ }) as HTMLInputElement;
  expect(amount.value).toBe('1650');
  const many = screen.getByRole('textbox', { name: /How many/ });
  await user.clear(many);
  await user.type(many, '2');
  expect(amount.value).toBe('3300');
  await user.clear(amount);
  await user.type(amount, '3200');
  await user.click(screen.getByRole('button', { name: 'Record Rs 3,200' }));
  expect(live()[1]).toMatchObject({ qty: 2, cents: 320000, note: '5kg' });
});

test('rent asks which, says which are paid this month, and Money out says which are left', async () => {
  const user = userEvent.setup();
  render(<MoneyOutView />);
  await user.click(screen.getByRole('button', { name: 'Add money out' }));
  await user.click(screen.getByRole('button', { name: /Rent/ }));
  expect((screen.getByRole('button', { name: 'Choose which rent' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: /Land$/ }));
  await user.keyboard('20000{Enter}');
  expect(live()).toMatchObject([{ what: 'rent', choiceId: 'rent-land', note: 'Land' }]);

  expect(screen.getByText('Rent not paid yet: Room 1, Room 2')).toBeTruthy();
  expect(within(screen.getByRole('list', { name: 'Rent by which' })).getByText('Land')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Add money out' }));
  const again = screen.getByRole('dialog', { name: 'Money out' });
  await user.click(within(again).getByRole('button', { name: /Rent/ }));
  expect(within(again).getByRole('button', { name: /Land\s*paid/ })).toBeTruthy();
});

test('sizes and rents are editable, with Undo; a cashier cannot edit them', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<App />);
  await payGas(user);
  expect(screen.queryByRole('button', { name: 'Edit sizes' })).toBeNull();
  unmount();

  render(<MoneyOutView />);
  await user.click(screen.getByRole('button', { name: 'Add money out' }));
  await user.click(screen.getByRole('button', { name: /Rent/ }));
  await user.click(screen.getByRole('button', { name: 'Edit rents' }));
  const first = screen.getByRole('textbox', { name: 'Name 1' });
  await user.clear(first);
  await user.type(first, 'Front room');
  await user.click(screen.getByRole('button', { name: 'Add a rent' }));
  expect((screen.getByRole('button', { name: 'Give each one a name' }) as HTMLButtonElement).disabled).toBe(true);
  await user.type(screen.getByRole('textbox', { name: 'Name 4' }), 'Store');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByRole('button', { name: /Front room$/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /Store$/ })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Undo' }));
  expect(screen.getByRole('button', { name: /Room 1$/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Store$/ })).toBeNull();
});

const delivery = (id: string, cents: number, at: number) => {
  const by = owner;
  appendEvent({ type: 'stock.ordered', id: `po-${id}`, at: at - 1, orderNumber: 0, actor: by, poNo: `PO-${id}`, supplierId: 'sup_litro', lines: [{ itemId: 'inv-0058', packs: 1 }] } as never);
  appendEvent({
    type: 'stock.grn', id, at, orderNumber: 0, actor: by, grnNo: `GRN-${id}`, orderId: `po-${id}`, supplierId: 'sup_litro',
    lines: [{ itemId: 'inv-0058', ordered: 1, received: 1, unitPriceCents: cents }], approvedBy: null,
  } as never);
};

test('a supplier payment connects to its GRNs: owed shows, Pay ticks them, and a part payment leaves the rest owed', async () => {
  const now = Date.now();
  delivery('1', 500000, now - 2000);
  delivery('2', 300000, now - 1000);
  const user = userEvent.setup();
  render(<MoneyOutView />);
  const owed = screen.getByRole('region', { name: 'Owed to suppliers' });
  expect(owed.textContent).toContain('8,000');
  expect(owed.textContent).toContain('2 GRNs');

  await user.click(within(owed).getByRole('button', { name: /^Pay / }));
  const sheet = screen.getByRole('dialog', { name: 'Money out' });
  const amount = within(sheet).getByRole('textbox', { name: /How much/ }) as HTMLInputElement;
  expect(amount.value).toBe('8000');
  // Untick the newer delivery: the amount follows.
  await user.click(within(sheet).getByRole('button', { name: /GRN-2/ }));
  expect(amount.value).toBe('5000');
  await user.clear(amount);
  await user.type(amount, '2000{Enter}');
  expect(live()).toMatchObject([{ what: 'supplier', supplierId: 'sup_litro', cents: 200000 }]);
  expect(live()[0].grnIds).toHaveLength(1);

  const after = screen.getByRole('region', { name: 'Owed to suppliers' });
  expect(after.textContent).toContain('6,000');
  expect(screen.getByRole('list', { name: 'Entries' }).textContent).toContain('GRN-1');
});

test('a supplier with no GRN owed can still be paid, and the page says how it counts', async () => {
  const user = userEvent.setup();
  render(<MoneyOutView />);
  expect(screen.queryByRole('region', { name: 'Owed to suppliers' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Add money out' }));
  await user.click(screen.getByRole('button', { name: /Supplier/ }));
  await user.click(screen.getByRole('button', { name: /Litro/ }));
  expect(screen.getByText(/counts towards the next delivery/)).toBeTruthy();
  await user.keyboard('1000{Enter}');
  expect(live()[0]).toMatchObject({ what: 'supplier', cents: 100000 });
  expect(live()[0].grnIds).toBeUndefined();
});
