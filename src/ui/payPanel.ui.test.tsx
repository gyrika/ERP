import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Charge opens inside the order panel (PayPanel), and the optional Mobile at Charge (CRM) never holds the sale up.

const crm = vi.hoisted(() => ({ lookup: vi.fn(), ensure: vi.fn() }));
vi.mock('../services/crmClient.ts', async (real) => ({
  ...(await real<typeof import('../services/crmClient.ts')>()),
  crmClient: crm,
}));
const { PayPanel, FOLD_MS } = await import('./PayPanel.tsx');
const { App } = await import('./App.tsx');

const KASUN = { id: 'cus-00000000000000a1', name: 'Kasun' };
beforeEach(() => {
  localStorage.clear();
  crm.lookup.mockImplementation(async (phone: string) => ({ customer: phone === '+94770000001' ? KASUN : null }));
  crm.ensure.mockImplementation(async () => ({ customer: { id: 'cus-00000000000000b2', name: null }, created: true }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

const alone = (onPay: () => void, customers = false) =>
  render(<PayPanel number={1001} total={290000} lines={null} onPay={onPay} onClose={() => {}} customers={customers} />);

// ---------- Customers (CRM) ----------

test('CRM off: no Mobile field; Enter pays exact cash', async () => {
  const onPay = vi.fn();
  const user = userEvent.setup();
  alone(onPay);
  expect(screen.queryByLabelText(/Mobile/)).toBeNull();
  await user.keyboard('{Enter}');
  expect(onPay).toHaveBeenCalledWith('cash', 290000);
});

test('no number: Enter pays exact cash at once, nothing asked', async () => {
  const onPay = vi.fn();
  const user = userEvent.setup();
  alone(onPay, true);
  await user.keyboard('{Enter}');
  expect(onPay).toHaveBeenCalledWith('cash', 290000);
  expect(crm.lookup).not.toHaveBeenCalled();
  expect(crm.ensure).not.toHaveBeenCalled();
});

test('a known number: typed straight away (it starts 0), the name shown, Enter twice pays for that customer', async () => {
  const onPay = vi.fn();
  const user = userEvent.setup();
  alone(onPay, true);
  await user.keyboard('0770000001'); // focus was on Exact cash: a number starting 0 goes to Mobile
  expect((screen.getByLabelText(/Mobile/) as HTMLInputElement).value).toBe('0770000001');
  expect((screen.getByRole('textbox', { name: 'Other amount' }) as HTMLInputElement).value).toBe('');
  expect(await screen.findByText('Kasun · on the list')).toBeTruthy();
  await user.keyboard('{Enter}{Enter}');
  expect(onPay).toHaveBeenCalledWith('cash', 290000, KASUN.id);
  expect(crm.ensure).not.toHaveBeenCalled();
});

test('with Customers on, other digits are still the cash given', async () => {
  const onPay = vi.fn();
  const user = userEvent.setup();
  alone(onPay, true);
  await user.keyboard('3000');
  expect((screen.getByRole('textbox', { name: 'Other amount' }) as HTMLInputElement).value).toBe('3000');
  expect((screen.getByLabelText(/Mobile/) as HTMLInputElement).value).toBe('');
  await user.keyboard('{Enter}');
  expect(onPay).toHaveBeenCalledWith('cash', 300000);
});

test('a new number: the customer is made as they pay', async () => {
  const onPay = vi.fn();
  const user = userEvent.setup();
  alone(onPay, true);
  await user.type(screen.getByLabelText(/Mobile/), '077 000 0099');
  expect(await screen.findByText('New customer: added as they pay')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Bank transfer' }));
  await vi.waitFor(() => expect(onPay).toHaveBeenCalledWith('transfer', 290000, 'cus-00000000000000b2'));
  expect(crm.ensure).toHaveBeenCalledWith('+94770000099');
});

test('the list not answering, or a half number: the sale still goes in, without a customer', async () => {
  crm.lookup.mockRejectedValue(new Error('timeout'));
  crm.ensure.mockRejectedValue(new Error('timeout'));
  const onPay = vi.fn();
  const user = userEvent.setup();
  alone(onPay, true);
  await user.type(screen.getByLabelText(/Mobile/), '0770000055');
  expect(await screen.findByText('The list is not answering: the sale still goes in')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: /^Exact cash/ }));
  await vi.waitFor(() => expect(onPay).toHaveBeenCalledWith('cash', 290000, undefined, true));

  cleanup();
  const onPay2 = vi.fn();
  alone(onPay2, true);
  await user.type(screen.getByLabelText(/Mobile/), '0112345678');
  expect(screen.getByText('a landline, not a mobile')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: /^Exact cash/ }));
  expect(onPay2).toHaveBeenCalledWith('cash', 290000);
});

// ---------- On the Register ----------

const panel = () => within(screen.getByRole('complementary', { name: 'Current order' }));
/** Charge is not a popup: the order panel itself becomes the payment. */
const pay = () => within(panel().getByRole('region', { name: 'Payment' }));
const paying = () => panel().queryByRole('region', { name: 'Payment' });
const note = () => pay().getByRole('status').textContent;

/** An order of 2,500, sent to the kitchen, with Charge open. */
const openPayment = async (user = userEvent.setup()) => {
  render(<App />);
  await user.click(screen.getAllByRole('button', { name: 'L 2500' })[0]);
  await user.click(panel().getByRole('button', { name: 'Send to kitchen' }));
  await user.click(panel().getByRole('button', { name: /^1001/ }));
  await user.click(panel().getByRole('button', { name: 'Charge' }));
  return user;
};

test('Charge turns the order panel into the payment: no sheet, the order still in view', async () => {
  await openPayment();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(within(pay().getByRole('list', { name: 'Order' })).getAllByRole('listitem')).toHaveLength(1);
  expect(note()).toBe('Total 2,500');
  expect(pay().getByRole('button', { name: 'Exact cash 2,500' })).toBeTruthy();
});

test('the suggested amounts are the total rounded up, what a customer really hands over', async () => {
  await openPayment();
  const given = within(pay().getByRole('group', { name: 'Cash given' })).getAllByRole('button').map((b) => b.textContent);
  expect(given).toEqual(['3,000', '5,000']);
  for (const name of ['Bank transfer', 'Card', 'QR']) expect(pay().getByRole('button', { name })).toBeTruthy();
});

test('Enter with nothing typed is exact cash', async () => {
  const user = await openPayment();
  await user.keyboard('{Enter}');
  expect(paying()).toBeNull();
  expect(panel().getByText('Paid')).toBeTruthy();
});

test('digits type the amount given, without the keypad; Enter takes it and shows the change', async () => {
  const user = await openPayment();
  await user.keyboard('2800');
  expect(pay().getByRole<HTMLInputElement>('textbox', { name: 'Other amount' }).value).toBe('2800');
  expect(pay().queryByRole('button', { name: 'Delete' })).toBeNull(); // the keyboard needs no keypad
  expect(note()).toBe('Change 300');
  await user.keyboard('{Enter}');
  expect(paying()).toBeNull();
  expect(panel().getByText('Change')).toBeTruthy();
  expect(panel().getByText(/Cash 2,800/)).toBeTruthy();
});

test('too little cash says how much is short and cannot be taken', async () => {
  const user = await openPayment();
  await user.keyboard('2000');
  expect(note()).toBe('Short 500');
  expect(pay().getByRole<HTMLButtonElement>('button', { name: 'Take' }).disabled).toBe(true);
  await user.keyboard('{Enter}');
  expect(paying()).toBeTruthy();
});

test('Esc clears what was typed, a second Esc goes back to the order', async () => {
  const user = await openPayment();
  await user.keyboard('28');
  await user.keyboard('{Escape}');
  expect(pay().getByRole<HTMLInputElement>('textbox', { name: 'Other amount' }).value).toBe('');
  await user.keyboard('{Escape}');
  expect(paying()).toBeNull();
  expect(panel().getByRole('button', { name: 'Charge' })).toBeTruthy();
});

test('B, C and Q pay by bank transfer, card and QR in one key', async () => {
  const user = await openPayment();
  await user.keyboard('b');
  expect(paying()).toBeNull();
  expect(panel().getByText(/Bank transfer · Total 2,500/)).toBeTruthy();
});

test('touch: the keypad opens from the field, folds away by itself once the amount is enough', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = await openPayment(userEvent.setup({ advanceTimers: vi.advanceTimersByTime }));
  expect(pay().queryByRole('button', { name: 'Delete' })).toBeNull();
  await user.click(pay().getByRole('textbox', { name: 'Other amount' }));
  expect(pay().queryByRole('list', { name: 'Order' })).toBeNull(); // the keypad takes the lines' room
  for (const key of ['3', '0', '00', 'Delete', '0']) await user.click(pay().getByRole('button', { name: key }));
  expect(note()).toBe('Change 500');
  act(() => { vi.advanceTimersByTime(FOLD_MS + 50); });
  expect(pay().queryByRole('button', { name: 'Delete' })).toBeNull();
  expect(pay().getByRole('list', { name: 'Order' })).toBeTruthy();
  expect(pay().getByRole<HTMLInputElement>('textbox', { name: 'Other amount' }).value).toBe('3000');
  await user.click(pay().getByRole('button', { name: 'Take 3,000' }));
  expect(panel().getByText(/Cash 3,000/)).toBeTruthy();
});

test('touch: while the amount is still short the keypad stays open', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = await openPayment(userEvent.setup({ advanceTimers: vi.advanceTimersByTime }));
  await user.click(pay().getByRole('button', { name: 'Keypad' }));
  await user.click(pay().getByRole('button', { name: '2' }));
  act(() => { vi.advanceTimersByTime(FOLD_MS * 3); });
  expect(pay().getByRole('button', { name: 'Delete' })).toBeTruthy();
  await user.click(pay().getByRole('button', { name: 'Hide' }));
  expect(pay().queryByRole('button', { name: 'Delete' })).toBeNull();
});

test('the menu stays live while paying: a tap adds the item and the order comes back', async () => {
  const user = await openPayment();
  await user.click(screen.getAllByRole('button', { name: 'M 1450' })[0]);
  expect(paying()).toBeNull();
  expect(panel().getByRole('button', { name: 'Send to kitchen' })).toBeTruthy();
});

// ---------- the counter screen ----------

test('Alt+1 … Alt+9 pick a menu tab; a digit alone still starts typing an order', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.keyboard('{Alt>}2{/Alt}');
  expect(screen.getByRole('button', { name: 'Pizza' }).getAttribute('aria-pressed')).toBe('true');
  await user.keyboard('{Alt>}1{/Alt}');
  expect(screen.getByRole('button', { name: 'Popular' }).getAttribute('aria-pressed')).toBe('true');
  await user.keyboard('2');
  expect(screen.getByRole('textbox')).toBeTruthy();
});

test('"More" holds the folded corner keys and closes when one is used', async () => {
  const user = userEvent.setup();
  render(<App />);
  const more = screen.getByRole('button', { name: 'More' });
  expect(screen.getByRole('button', { name: /^Money out/ }).closest('.corner__rest')).not.toBeNull();
  expect(more.getAttribute('aria-expanded')).toBe('false');
  await user.click(more);
  expect(more.getAttribute('aria-expanded')).toBe('true');
  await user.click(screen.getByRole('button', { name: /^Receive/ }));
  expect(more.getAttribute('aria-expanded')).toBe('false');
});
