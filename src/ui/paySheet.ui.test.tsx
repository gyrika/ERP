import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The optional Mobile at Charge (CRM): the sale never waits on it, and Enter still pays exact cash.

const crm = vi.hoisted(() => ({ lookup: vi.fn(), ensure: vi.fn() }));
vi.mock('../services/crmClient.ts', () => ({ crmClient: crm }));
const { PaySheet } = await import('./PaySheet.tsx');

const KASUN = { id: 'cus-00000000000000a1', name: 'Kasun' };
beforeEach(() => {
  crm.lookup.mockImplementation(async (phone: string) => ({ customer: phone === '+94770000001' ? KASUN : null }));
  crm.ensure.mockImplementation(async () => ({ customer: { id: 'cus-00000000000000b2', name: null }, created: true }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

test('CRM off: no Mobile field, the sheet as it always was', async () => {
  const onPay = vi.fn();
  const user = userEvent.setup();
  render(<PaySheet total={290000} onPay={onPay} onClose={() => {}} />);
  expect(screen.queryByLabelText(/Mobile/)).toBeNull();
  await user.keyboard('{Enter}');
  expect(onPay).toHaveBeenCalledWith('cash', 290000);
});

test('no number: Enter pays exact cash at once, nothing asked', async () => {
  const onPay = vi.fn();
  const user = userEvent.setup();
  render(<PaySheet total={290000} onPay={onPay} onClose={() => {}} customers />);
  await user.keyboard('{Enter}');
  expect(onPay).toHaveBeenCalledWith('cash', 290000);
  expect(crm.lookup).not.toHaveBeenCalled();
  expect(crm.ensure).not.toHaveBeenCalled();
});

test('a known number: typed straight away, the name shown, Enter twice pays for that customer', async () => {
  const onPay = vi.fn();
  const user = userEvent.setup();
  render(<PaySheet total={290000} onPay={onPay} onClose={() => {}} customers />);
  await user.keyboard('0770000001'); // focus was on Exact: the digits go to Mobile anyway
  expect((screen.getByLabelText(/Mobile/) as HTMLInputElement).value).toBe('0770000001');
  expect(await screen.findByText('Kasun · on the list')).toBeTruthy();
  await user.keyboard('{Enter}{Enter}');
  expect(onPay).toHaveBeenCalledWith('cash', 290000, KASUN.id);
  expect(crm.ensure).not.toHaveBeenCalled();
});

test('a new number: the customer is made as they pay', async () => {
  const onPay = vi.fn();
  const user = userEvent.setup();
  render(<PaySheet total={290000} onPay={onPay} onClose={() => {}} customers />);
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
  render(<PaySheet total={290000} onPay={onPay} onClose={() => {}} customers />);
  await user.type(screen.getByLabelText(/Mobile/), '0770000055');
  expect(await screen.findByText('The list is not answering: the sale still goes in')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: /^Exact/ }));
  await vi.waitFor(() => expect(onPay).toHaveBeenCalledWith('cash', 290000, undefined, true));

  cleanup();
  const onPay2 = vi.fn();
  render(<PaySheet total={290000} onPay={onPay2} onClose={() => {}} customers />);
  await user.type(screen.getByLabelText(/Mobile/), '0112345678');
  expect(screen.getByText('a landline, not a mobile')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: /^Exact/ }));
  expect(onPay2).toHaveBeenCalledWith('cash', 290000);
});
