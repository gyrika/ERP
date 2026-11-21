import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CreditSetting } from '../domain/credit.ts';

// Credit at Charge (credit.ts): the Credit key, "Add to this payment", and paying credit back.

const crm = vi.hoisted(() => ({ lookup: vi.fn(), ensure: vi.fn(), search: vi.fn() }));
vi.mock('../services/crmClient.ts', async (real) => ({
  ...(await real<typeof import('../services/crmClient.ts')>()),
  crmClient: crm,
}));
const { PayPanel } = await import('./PayPanel.tsx');

const KASUN = { id: 'cus-00000000000000a1', name: 'Kasun' };
beforeEach(() => {
  localStorage.clear();
  crm.lookup.mockImplementation(async (phone: string) => ({ customer: phone === '+94770000001' ? KASUN : null }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const account = (setting: CreditSetting | null, owes = 0) => () => ({ setting, owes });
const charge = (onPay: () => void, creditOf: ReturnType<typeof account>, extra: Partial<Parameters<typeof PayPanel>[0]> = {}) =>
  render(<PayPanel number={1001} total={164900} lines={null} onPay={onPay} onClose={() => {}} customers creditOf={creditOf} {...extra} />);

test('no customer yet: Credit is there, greyed, and says why', () => {
  charge(vi.fn(), account({ limit: null }));
  const key = screen.getByRole('button', { name: 'Credit' });
  expect(key).toHaveProperty('disabled', true);
  expect(key.textContent).toContain('Add customer');
});

test('a customer with credit: Credit (or R) puts the bill on it, for them', async () => {
  const onPay = vi.fn();
  const user = userEvent.setup();
  charge(onPay, account({ limit: 2_000_000 }, 500_000), { customer: KASUN });
  const key = screen.getByRole('button', { name: 'Credit' });
  expect(key.textContent).toContain('15,000 left');
  await user.keyboard('r');
  expect(onPay).toHaveBeenCalledWith('credit', 164900, KASUN.id);
});

test('credit off for them: greyed, "No credit"; R does nothing', async () => {
  const onPay = vi.fn();
  const user = userEvent.setup();
  charge(onPay, account(null), { customer: KASUN });
  expect(screen.getByRole('button', { name: 'Credit' }).textContent).toContain('No credit');
  await user.keyboard('r');
  expect(onPay).not.toHaveBeenCalled();
});

test('past the limit: greyed with by how much, unless manager mode is on', async () => {
  const onPay = vi.fn();
  const user = userEvent.setup();
  const { unmount } = charge(onPay, account({ limit: 1_000_000 }, 900_000), { customer: KASUN });
  const key = screen.getByRole('button', { name: 'Credit' });
  expect(key).toHaveProperty('disabled', true);
  expect(key.textContent).toContain('Over limit by 649');
  unmount();
  charge(onPay, account({ limit: 1_000_000 }, 900_000), { customer: KASUN, managerOn: true });
  await user.click(screen.getByRole('button', { name: 'Credit' }));
  expect(onPay).toHaveBeenCalledWith('credit', 164900, KASUN.id);
});

test('a known number typed at Charge: their credit works too', async () => {
  const onPay = vi.fn();
  const user = userEvent.setup();
  charge(onPay, account({ limit: null }));
  await user.keyboard('0770000001');
  expect(await screen.findByText('Kasun · on the list')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Credit' }));
  expect(onPay).toHaveBeenCalledWith('credit', 164900, KASUN.id);
});

test('they owe: one tap adds it to this payment; the total and cash count both; it rides along as payBack', async () => {
  const onPay = vi.fn();
  const user = userEvent.setup();
  charge(onPay, account({ limit: null }, 1_240_000), { customer: KASUN });
  await user.click(screen.getByRole('button', { name: /Owes 12,400 on credit/ }));
  expect(screen.getByRole('status').textContent).toContain('14,049');
  await user.keyboard('15000{Enter}');
  expect(onPay).toHaveBeenCalledWith('cash', 1_500_000, KASUN.id, undefined, 1_240_000);
});

test('they owe but this bill goes on credit too: nothing is paid back with it', async () => {
  const onPay = vi.fn();
  const user = userEvent.setup();
  charge(onPay, account({ limit: null }, 1_240_000), { customer: KASUN });
  await user.click(screen.getByRole('button', { name: /Owes 12,400 on credit/ }));
  await user.keyboard('r');
  expect(onPay).toHaveBeenCalledWith('credit', 164900, KASUN.id);
});

test('paying back: the whole amount in cash at once, or part of it typed; no Credit key, no Mobile', async () => {
  const onPay = vi.fn();
  const user = userEvent.setup();
  const { unmount } = render(<PayPanel number={0} total={1_240_000} lines={null} onPay={onPay} onClose={() => {}} repay={{ title: 'Kasun' }} />);
  expect(screen.queryByRole('button', { name: 'Credit' })).toBeNull();
  expect(screen.queryByLabelText(/Mobile/)).toBeNull();
  expect(screen.getByText('Paying back')).toBeTruthy();
  await user.keyboard('{Enter}');
  expect(onPay).toHaveBeenLastCalledWith('cash', 1_240_000);
  unmount();
  render(<PayPanel number={0} total={1_240_000} lines={null} onPay={onPay} onClose={() => {}} repay={{ title: 'Kasun' }} />);
  await user.keyboard('10000');
  expect(screen.getByRole('status').textContent).toContain('Still owes after');
  expect(screen.getByRole('status').textContent).toContain('2,400');
  await user.keyboard('b');
  expect(onPay).toHaveBeenLastCalledWith('transfer', 1_000_000);
});
