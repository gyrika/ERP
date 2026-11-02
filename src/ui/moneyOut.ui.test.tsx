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

test('the page lists every rent, paid or not, with Pay; Pay opens on that rent with the last price, and a paid one shows its amount', async () => {
  const user = userEvent.setup();
  render(<MoneyOutView />);
  const rent = () => screen.getByRole('region', { name: 'Rent' });
  expect(within(rent()).getAllByText('Not paid')).toHaveLength(3);
  for (const name of ['Room 1', 'Room 2', 'Land']) expect(within(rent()).getByText(name)).toBeTruthy();

  await user.click(within(rent()).getByRole('button', { name: 'Pay Land' }));
  const sheet = screen.getByRole('dialog', { name: 'Money out' });
  expect(within(sheet).getByRole('button', { name: /Land$/ }).getAttribute('aria-pressed')).toBe('true');
  await user.keyboard('20000{Enter}');
  expect(live()).toMatchObject([{ what: 'rent', choiceId: 'rent-land', note: 'Land', cents: 2000000 }]);
  expect(within(rent()).getByText('Rs 20,000')).toBeTruthy();
  expect(within(rent()).getAllByText('Not paid')).toHaveLength(2);

  // Paid again: the last price is there, and the sheet marks it paid.
  await user.click(within(rent()).getByRole('button', { name: 'Pay Land' }));
  const again = screen.getByRole('dialog', { name: 'Money out' });
  expect((within(again).getByRole('textbox', { name: /How much/ }) as HTMLInputElement).value).toBe('20000');
  expect(within(again).getByRole('button', { name: /Land\s*paid/ })).toBeTruthy();
});

test('more rents are added right on the page, with Undo', async () => {
  const user = userEvent.setup();
  render(<MoneyOutView />);
  const rent = () => screen.getByRole('region', { name: 'Rent' });
  await user.click(within(rent()).getByRole('button', { name: 'Add or change rents' }));
  await user.click(within(rent()).getByRole('button', { name: 'Add a rent' }));
  await user.type(within(rent()).getByRole('textbox', { name: 'Name 4' }), 'Store');
  await user.click(within(rent()).getByRole('button', { name: 'Save' }));
  expect(within(rent()).getByText('Store')).toBeTruthy();
  expect(within(rent()).getByRole('button', { name: 'Pay Store' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Undo' }));
  expect(within(rent()).queryByText('Store')).toBeNull();
});

test('sizes and rents are editable, with Undo; a cashier cannot edit them', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<App />);
  await payGas(user);
  expect(screen.queryByRole('button', { name: 'Edit sizes' })).toBeNull();
  unmount();

  render(<MoneyOutView />);
  const dialog = () => within(screen.getByRole('dialog', { name: 'Money out' }));
  await user.click(screen.getByRole('button', { name: 'Add money out' }));
  await user.click(dialog().getByRole('button', { name: /^(\d\s*)?Rent$/ }));
  await user.click(dialog().getByRole('button', { name: 'Edit rents' }));
  const first = screen.getByRole('textbox', { name: 'Name 1' });
  await user.clear(first);
  await user.type(first, 'Front room');
  await user.click(dialog().getByRole('button', { name: 'Add a rent' }));
  expect((dialog().getByRole('button', { name: 'Give each one a name' }) as HTMLButtonElement).disabled).toBe(true);
  await user.type(screen.getByRole('textbox', { name: 'Name 4' }), 'Store');
  await user.click(dialog().getByRole('button', { name: 'Save' }));
  expect(dialog().getByRole('button', { name: /Front room$/ })).toBeTruthy();
  expect(dialog().getByRole('button', { name: /Store$/ })).toBeTruthy();
  await user.click(dialog().getByRole('button', { name: 'Undo' }));
  expect(dialog().getByRole('button', { name: /Room 1$/ })).toBeTruthy();
  expect(dialog().queryByRole('button', { name: /Store$/ })).toBeNull();
});

const delivery = (id: string, cents: number, at: number) => {
  const by = owner;
  appendEvent({ type: 'stock.ordered', id: `po-${id}`, at: at - 1, orderNumber: 0, actor: by, poNo: `PO-${id}`, supplierId: 'sup_litro', lines: [{ itemId: 'inv-0058', packs: 1 }] } as never);
  appendEvent({
    type: 'stock.grn', id, at, orderNumber: 0, actor: by, grnNo: `GRN-${id}`, orderId: `po-${id}`, supplierId: 'sup_litro',
    lines: [{ itemId: 'inv-0058', ordered: 1, received: 1, unitPriceCents: cents }], approvedBy: null,
  } as never);
};

test('Money out lists every unpaid GRN, old ones too: Pay opens on it, and a part payment leaves the rest owed', async () => {
  const now = Date.now();
  delivery('1', 500000, new Date(2026, 0, 15).getTime());
  delivery('2', 300000, now - 1000);
  const user = userEvent.setup();
  render(<MoneyOutView />);
  const list = () => screen.getByRole('region', { name: 'Unpaid GRNs' });
  expect(list().textContent).toContain('8,000');
  expect(list().textContent).toContain('2 unpaid GRNs');
  expect(list().textContent).toContain('GRN-1');
  expect(list().textContent).toContain('GRN-2');

  await user.click(within(list()).getByRole('button', { name: 'Pay GRN-1' }));
  const sheet = screen.getByRole('dialog', { name: 'Money out' });
  const amount = within(sheet).getByRole('textbox', { name: /How much/ }) as HTMLInputElement;
  expect(amount.value).toBe('5000');
  await user.clear(amount);
  await user.type(amount, '2000{Enter}');
  expect(live()).toMatchObject([{ what: 'supplier', supplierId: 'sup_litro', cents: 200000 }]);
  expect(live()[0].grnIds).toHaveLength(1);

  expect(list().textContent).toContain('6,000');
  expect(list().textContent).toContain('Rs 2,000 of Rs 5,000 paid');
  expect(screen.getByRole('list', { name: 'Entries' }).textContent).toContain('GRN-1');
});

test('the owner removes a GRN from the unpaid list, with Undo: it leaves the Register too, and no money is recorded', async () => {
  delivery('1', 500000, Date.now() - 1000);
  const user = userEvent.setup();
  const { unmount } = render(<MoneyOutView />);
  await user.click(within(screen.getByRole('region', { name: 'Unpaid GRNs' })).getByRole('button', { name: 'Remove GRN-1' }));
  expect(screen.queryByRole('region', { name: 'Unpaid GRNs' })).toBeNull();
  expect(live()).toEqual([]);
  await user.click(screen.getByRole('button', { name: 'Undo' }));
  expect(screen.getByRole('region', { name: 'Unpaid GRNs' })).toBeTruthy();
  await user.click(within(screen.getByRole('region', { name: 'Unpaid GRNs' })).getByRole('button', { name: 'Remove GRN-1' }));
  unmount();

  render(<App />);
  await user.keyboard('{F6}');
  await user.click(screen.getByRole('button', { name: /Supplier/ }));
  expect(screen.getByText(/No GRN is waiting to be paid/)).toBeTruthy();
});

test('a supplier is paid only through a GRN: with none, nothing can be recorded', async () => {
  const user = userEvent.setup();
  render(<MoneyOutView />);
  expect(screen.queryByRole('region', { name: 'Unpaid GRNs' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Add money out' }));
  await user.click(screen.getByRole('button', { name: /Supplier/ }));
  expect(screen.getByText(/No GRN is waiting to be paid/)).toBeTruthy();
  await user.type(screen.getByRole('textbox', { name: /How much/ }), '1000');
  expect((screen.getByRole('button', { name: 'No GRN to pay' }) as HTMLButtonElement).disabled).toBe(true);
  await user.keyboard('{Enter}');
  expect(live()).toEqual([]);
});

test('the Register: F6, Supplier lists the owner\'s unpaid GRNs; a key picks one, the amount fills in; never more than it owes', async () => {
  const now = Date.now();
  delivery('7', 500000, now - 2000);
  delivery('8', 300000, now - 1000);
  const user = userEvent.setup();
  render(<App />);
  await user.keyboard('{F6}');
  const sheet = screen.getByRole('dialog', { name: 'Money out' });
  await user.click(within(sheet).getByRole('button', { name: /Supplier/ }));
  expect(within(sheet).queryByRole('group', { name: 'Which supplier' })).toBeNull();
  expect((within(sheet).getByRole('button', { name: 'Choose the GRN' }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(sheet).getByRole('button', { name: /GRN-8/ })).toBeTruthy();

  await user.keyboard('1');
  const amount = within(sheet).getByRole('textbox', { name: /How much/ }) as HTMLInputElement;
  expect(amount.value).toBe('5000');
  await user.clear(amount);
  await user.type(amount, '5001');
  expect((within(sheet).getByRole('button', { name: 'More than the GRN owes' }) as HTMLButtonElement).disabled).toBe(true);
  await user.clear(amount);
  await user.type(amount, '5000{Enter}');
  expect(live()).toMatchObject([{ what: 'supplier', supplierId: 'sup_litro', cents: 500000, from: 'drawer' }]);
  expect(live()[0].grnIds).toHaveLength(1);

  // Paid: it no longer asks, and the other stays.
  await user.keyboard('{F6}');
  const next = screen.getByRole('dialog', { name: 'Money out' });
  await user.click(within(next).getByRole('button', { name: /Supplier/ }));
  expect(within(next).queryByRole('button', { name: /GRN-7/ })).toBeNull();
  expect(within(next).getByRole('button', { name: /GRN-8/ })).toBeTruthy();
});
