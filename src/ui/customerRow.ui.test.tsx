import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The customer row on the bill (Anton, 2026-11-21): always in sight on an unpaid bill, find someone
// or + New; and someone who only came to pay their credit back is found and paid from the search.

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
const cashier = { id: 'c', name: 'Nimal', role: 'cashier' as const };

beforeEach(() => {
  localStorage.clear();
  crm.lookup.mockResolvedValue({ customer: null });
  crm.search.mockResolvedValue({ matches: [] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const panel = () => within(screen.getByRole('complementary', { name: 'Current order' }));
/** Dilani ate on credit last week: Rs 1,450 owed. */
const dilaniOwes = () => appendEvent({
  type: 'order.paid', at: Date.now() - 7 * 86_400_000, orderNumber: 900, actor: cashier,
  total: 145_000, tender: 'credit', tendered: 145_000, customerId: DILANI.id,
} as Parameters<typeof appendEvent>[0]);

test('an empty bill shows the customer row: find (0) and + New, without pressing anything', () => {
  render(<App />);
  expect(panel().getByRole('button', { name: /Customer mobile or name/ })).toBeTruthy();
  expect(panel().getByRole('button', { name: '+ New' })).toBeTruthy();
});

test('tapping the row opens the search, the same as 0', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(panel().getByRole('button', { name: /Customer mobile or name/ }));
  expect(panel().getByRole('textbox', { name: 'Customer' })).toBe(document.activeElement);
  await user.keyboard('{Escape}');
  expect(panel().getByRole('button', { name: '+ New' })).toBeTruthy();
});

test('+ New: mobile, Enter, name, Enter adds them and puts them on the bill', async () => {
  crm.ensure.mockResolvedValue({ customer: { id: 'cus-00000000000000e2', name: 'Ruwan' }, created: true });
  const user = userEvent.setup();
  render(<App />);
  await user.click(panel().getByRole('button', { name: '+ New' }));
  expect(panel().getByRole('textbox', { name: 'New customer: mobile' })).toBe(document.activeElement);
  expect(panel().getByRole('textbox', { name: 'Name' })).toBeTruthy(); // both in sight at once
  await user.keyboard('0771234567');
  await panel().findByRole('button', { name: /New customer/ });
  await user.keyboard('{Enter}');
  expect(document.activeElement).toBe(panel().getByRole('textbox', { name: 'Name' }));
  await user.keyboard('Ruwan{Enter}');
  expect(crm.ensure).toHaveBeenCalledWith('+94771234567', 'Ruwan', undefined, undefined);
  expect(await panel().findByRole('button', { name: /Customer Ruwan: change/ })).toBeTruthy();
});

test('came only to pay credit back: found by name, Take payment from the search, no bill needed', async () => {
  dilaniOwes();
  crm.search.mockResolvedValue({ matches: [{ ...DILANI, ends: '567' }] });
  const user = userEvent.setup();
  render(<App />);
  await user.click(panel().getByRole('button', { name: /Customer mobile or name/ }));
  await user.keyboard('Dil');
  await user.click(await panel().findByRole('button', { name: /Take payment from Dilani, owes 1,450/ }));
  expect(panel().getByText('Paying back')).toBeTruthy();
  await user.keyboard('1000{Enter}');
  expect(creditOf(readAll(), DILANI.id).owes).toBe(45_000);
  expect(readAll().some((e) => e.type === 'order.paid' && e.orderNumber !== 900)).toBe(false); // no sale
});

test('found by mobile with a bill on screen: Take payment leaves the bill as it was', async () => {
  dilaniOwes();
  crm.lookup.mockResolvedValue({ customer: DILANI });
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getAllByRole('button', { name: 'M 1,450' })[0]);
  await user.keyboard('0771234567');
  await user.click(await panel().findByRole('button', { name: /Take payment from Dilani/ }));
  await user.keyboard('1450{Enter}');
  expect(creditOf(readAll(), DILANI.id).owes).toBe(0);
  // The bill is still there, with no customer put on it.
  expect(panel().getByRole('button', { name: /Customer mobile or name/ })).toBeTruthy();
  expect(panel().getAllByText(/1,450/).length).toBeGreaterThan(0);
});
