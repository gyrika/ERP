import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Credit on the Register (credit.ts): a bill on a customer's credit, what they owe in sight when
// they are put on an order, and Take payment for the day they pay it back.

const crm = vi.hoisted(() => ({ lookup: vi.fn(), ensure: vi.fn(), search: vi.fn() }));
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
const { appendEvent, readAll } = await import('./eventLog.ts');
const { creditOf } = await import('../domain/credit.ts');

const DILANI = { id: 'cus-00000000000000d1', name: 'Dilani' };
const owner = { id: 'o', name: 'Anton', role: 'owner' as const };

beforeEach(() => {
  localStorage.clear();
  crm.lookup.mockResolvedValue({ customer: DILANI });
  appendEvent({ type: 'credit.limit_set', at: Date.now() - 1000, orderNumber: 0, actor: owner, customerId: DILANI.id, before: null, after: { limit: 2_000_000 } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const panel = () => within(screen.getByRole('complementary', { name: 'Current order' }));
const putOnDilani = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.keyboard('0771234567');
  await panel().findByRole('button', { name: /Dilani/ });
  await user.keyboard('{Enter}');
};

test('a bill on credit, then she pays part of it back from her name; Undo takes the pay-back back', async () => {
  const user = userEvent.setup();
  render(<App />);
  await putOnDilani(user);
  await user.click(screen.getAllByRole('button', { name: 'M 1,450' })[0]);
  await user.click(screen.getByRole('button', { name: 'Pay' }));
  await user.click(panel().getByRole('button', { name: 'Credit' }));

  const paid = readAll().filter((e) => e.type === 'order.paid').at(-1) as { tender: string; customerId?: string; total: number };
  expect(paid.tender).toBe('credit');
  expect(paid.customerId).toBe(DILANI.id);
  expect(creditOf(readAll(), DILANI.id).owes).toBe(paid.total);

  await user.click(screen.getByRole('button', { name: 'New bill' }));
  await putOnDilani(user);
  expect(panel().getByText(/on credit/).textContent).toContain('1,450');
  await user.click(panel().getByRole('button', { name: 'Take payment' }));
  expect(panel().getByText('Paying back')).toBeTruthy();
  await user.keyboard('1000{Enter}');

  expect(creditOf(readAll(), DILANI.id).owes).toBe(paid.total - 100_000);
  const toast = await screen.findByText(/Dilani paid back 1,000 · owes 450/);
  await user.click(within(toast.closest('.toast') as HTMLElement).getByRole('button', { name: 'Undo' }));
  expect(creditOf(readAll(), DILANI.id).owes).toBe(paid.total);
  expect(JSON.stringify(readAll())).not.toContain('Dilani'); // names never travel in events
});
