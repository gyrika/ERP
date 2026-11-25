import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Charge's customer field: search by mobile or name, and + New customer for the cashier to add one on purpose.

const crm = vi.hoisted(() => ({ lookup: vi.fn(), ensure: vi.fn(), search: vi.fn() }));
vi.mock('../services/crmClient.ts', async (real) => ({
  ...(await real<typeof import('../services/crmClient.ts')>()),
  crmClient: crm,
}));
const { PayPanel } = await import('./PayPanel.tsx');

const RUWAN = { id: 'cus-00000000000000e2', name: 'Ruwan' };
beforeEach(() => {
  localStorage.clear();
  crm.lookup.mockResolvedValue({ customer: null });
  crm.search.mockResolvedValue({ matches: [] });
  crm.ensure.mockResolvedValue({ customer: RUWAN, created: true });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const charge = (onPay = vi.fn()) => {
  render(<PayPanel number={1001} total={290000} lines={null} onPay={onPay} onClose={() => {}} customers />);
  return onPay;
};
const form = () => within(screen.getByRole('group', { name: 'New customer' }));

test('the field says it searches, with + New customer beside it', () => {
  charge();
  expect(screen.getByLabelText('Mobile or name').getAttribute('placeholder')).toBe('Search mobile or name');
  expect(screen.getByRole('button', { name: '+ New customer' })).toBeTruthy();
});

test('+ New customer: mobile and name, Enter, Enter adds them; the payment is then theirs', async () => {
  const onPay = charge();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '+ New customer' }));
  expect(document.activeElement).toBe(form().getByLabelText('Mobile'));
  await user.keyboard('0771234567{Enter}');
  expect(document.activeElement).toBe(form().getByLabelText('Name'));
  await user.keyboard('Ruwan Silva{Enter}');
  expect(crm.ensure).toHaveBeenCalledWith('+94771234567', 'Ruwan Silva', undefined, undefined);
  expect(await screen.findByText('Ruwan · added')).toBeTruthy();
  expect(screen.queryByRole('group', { name: 'New customer' })).toBeNull();
  await user.keyboard('{Enter}');
  expect(onPay).toHaveBeenCalledWith('cash', 290000, RUWAN.id);
});

test('+ New customer: a nickname too, by Tab from the name; Enter adds them with it', async () => {
  crm.ensure.mockResolvedValue({ customer: { ...RUWAN, name: 'Ruwan Silva', nickname: 'Ruwa' }, created: true });
  charge();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '+ New customer' }));
  await user.keyboard('0771234567{Enter}Ruwan Silva{Tab}Ruwa{Enter}');
  expect(crm.ensure).toHaveBeenCalledWith('+94771234567', 'Ruwan Silva', undefined, 'Ruwa');
  expect(await screen.findByText('Ruwan Silva “Ruwa” · added')).toBeTruthy();
});

test('what was typed comes along: a name typed in search fills the Name', async () => {
  charge();
  const user = userEvent.setup();
  await user.click(screen.getByLabelText('Mobile or name'));
  await user.keyboard('Ruwan');
  await user.click(screen.getByRole('button', { name: '+ New customer' }));
  expect(form().getByLabelText('Name')).toHaveProperty('value', 'Ruwan');
  expect(document.activeElement).toBe(form().getByLabelText('Mobile'));
});

test('a number already on the list is not made twice: told so, and they are put on the payment', async () => {
  crm.ensure.mockResolvedValue({ customer: { id: 'cus-00000000000000a1', name: 'Kasun' }, created: false });
  charge();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '+ New customer' }));
  await user.keyboard('0770000001');
  await user.click(form().getByRole('button', { name: /Add customer/ }));
  expect(await screen.findByText('Kasun · already on the list')).toBeTruthy();
});

test('a wrong mobile is not sent; the shop PC not answering says so and keeps what was typed; Esc closes', async () => {
  charge();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '+ New customer' }));
  await user.keyboard('12{Enter}');
  await user.keyboard('A{Enter}');
  expect(form().getByRole('alert')).toBeTruthy();
  expect(crm.ensure).not.toHaveBeenCalled();
  crm.ensure.mockRejectedValue(new Error('timeout'));
  await user.clear(form().getByLabelText('Mobile'));
  await user.type(form().getByLabelText('Mobile'), '0771234567');
  await user.click(form().getByRole('button', { name: /Add customer/ }));
  expect((await form().findByRole('alert')).textContent).toContain('did not answer');
  expect(form().getByLabelText('Name')).toHaveProperty('value', 'A');
  await user.click(form().getByLabelText('Name'));
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('group', { name: 'New customer' })).toBeNull();
});
