import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mobile at Charge (CRM): the sale never waits on the customer list, and the cashier is told when a
// number given could not be saved.

const crm = vi.hoisted(() => ({ lookup: vi.fn(), ensure: vi.fn() }));
vi.mock('../services/crmClient.ts', async (real) => ({
  ...(await real<typeof import('../services/crmClient.ts')>()),
  crmClient: crm,
  crmReachable: () => true,
}));
vi.mock('./eventLog.ts', async (real) => ({
  ...(await real<typeof import('./eventLog.ts')>()),
  modulesHere: () => ({ crm: true }),
}));

const { App } = await import('./App.tsx');
const { readAll } = await import('./eventLog.ts');

beforeEach(() => {
  localStorage.clear();
  crm.lookup.mockResolvedValue({ customer: null }); // a new number
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const panel = () => within(screen.getByRole('complementary', { name: 'Current order' }));
const toast = () => document.querySelector('.toast')?.textContent ?? '';
const paidEvent = () => readAll().filter((e) => e.type === 'order.paid').at(-1) as { customerId?: string } | undefined;

const charge = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getAllByRole('button', { name: 'L 2500' })[0]); // Devilled Chicken L
  await user.click(panel().getByRole('button', { name: 'Send to kitchen' }));
  await user.click(panel().getByRole('button', { name: /^1001/ }));
  await user.click(panel().getByRole('button', { name: 'Charge' }));
  await user.type(screen.getByRole('textbox', { name: /Mobile/ }), '077 123 4567');
};

test('the shop PC does not answer: the sale goes through, and the toast says the mobile was not saved', async () => {
  crm.ensure.mockRejectedValue(new Error('timed out'));
  const user = userEvent.setup();
  render(<App />);
  await charge(user);
  await user.click(screen.getByRole('button', { name: /Exact cash/ }));

  expect(panel().getByText('Paid')).toBeTruthy();
  expect(toast()).toContain('Paid 2,500 · mobile not saved');
  expect(paidEvent()?.customerId).toBeUndefined();
});

test('a number the shop PC saves: the payment names the customer, and the toast says nothing more', async () => {
  crm.ensure.mockResolvedValue({ customer: { id: 'cus-0000000000000001', name: null }, created: true });
  const user = userEvent.setup();
  render(<App />);
  await charge(user);
  await user.click(screen.getByRole('button', { name: /Exact cash/ }));

  expect(toast()).not.toContain('not saved');
  expect(paidEvent()?.customerId).toBe('cus-0000000000000001');
});
