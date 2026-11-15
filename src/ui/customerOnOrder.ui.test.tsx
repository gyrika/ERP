import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The customer on the order (CRM): put on from the Register in a few keys, found or made on the
// shop PC's list, greeted by name, offered "the usual", and named on the payment by id only.

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

const DILANI = { id: 'cus-00000000000000d1', name: 'Dilani' };

beforeEach(() => {
  localStorage.clear();
  crm.lookup.mockResolvedValue({ customer: null });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const panel = () => within(screen.getByRole('complementary', { name: 'Current order' }));
const paidEvent = () => readAll().filter((e) => e.type === 'order.paid').at(-1) as { customerId?: string } | undefined;

/** 0 on the Register starts a customer's mobile; the rest is typed into the field it opens. */
const typeMobile = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.keyboard('0');
  expect(panel().getByRole('textbox', { name: 'Customer' })).toHaveProperty('value', '0');
  await user.keyboard('771234567');
};

const sendAndPay = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(panel().getByRole('button', { name: 'Send to kitchen' }));
  await user.click(within(screen.getByRole('navigation', { name: 'Orders' })).getByRole('button', { name: /^1001|^1002/ }));
  await user.click(panel().getByRole('button', { name: 'Pay' }));
};

test('a customer on the list: 0 and their mobile, Enter, and the payment is theirs; no Mobile asked at Charge', async () => {
  crm.lookup.mockResolvedValue({ customer: DILANI });
  const user = userEvent.setup();
  render(<App />);
  await typeMobile(user);
  expect(crm.lookup).toHaveBeenLastCalledWith('+94771234567');
  expect(await panel().findByRole('button', { name: /Dilani.*No visits yet/ })).toBeTruthy();
  await user.keyboard('{Enter}');

  expect(panel().getByRole('button', { name: 'Customer Dilani: change' }).textContent).toContain('First visit');
  expect(crm.ensure).not.toHaveBeenCalled(); // already on the list: nothing to make

  await user.click(screen.getAllByRole('button', { name: 'M 1,450' })[0]);
  await sendAndPay(user);
  expect(screen.queryByRole('textbox', { name: /Mobile/ })).toBeNull();
  expect(panel().getByText('Dilani · on the list')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: /Exact cash/ }));

  expect(paidEvent()?.customerId).toBe(DILANI.id);
  expect(JSON.stringify(readAll())).not.toContain('Dilani'); // the name never travels in an event
});

test('a new number: Tab for the name, Enter makes the customer on the shop PC and puts them on', async () => {
  crm.ensure.mockResolvedValue({ customer: { id: 'cus-00000000000000e2', name: 'Ruwan' }, created: true });
  const user = userEvent.setup();
  render(<App />);
  await typeMobile(user);
  expect(await panel().findByRole('button', { name: /New customer/ })).toBeTruthy();
  await user.tab();
  expect(document.activeElement).toBe(panel().getByRole('textbox', { name: 'Name, if they give it' }));
  await user.keyboard('Ruwan{Enter}');

  expect(crm.ensure).toHaveBeenCalledWith('+94771234567', 'Ruwan');
  expect(await panel().findByRole('button', { name: 'Customer Ruwan: change' })).toBeTruthy();
});

test('the next visit: "Same as last time" is offered and takes Enter; it says which visit this is', async () => {
  crm.lookup.mockResolvedValue({ customer: DILANI });
  const user = userEvent.setup();
  render(<App />);
  await typeMobile(user);
  await panel().findByRole('button', { name: /Dilani/ });
  await user.keyboard('{Enter}');
  await user.click(screen.getAllByRole('button', { name: 'M 1,450' })[0]);
  await sendAndPay(user);
  await user.click(screen.getByRole('button', { name: /Exact cash/ }));
  await user.click(panel().getByRole('button', { name: 'Next order' }));

  await typeMobile(user);
  expect(await panel().findByRole('button', { name: /Dilani.*1 visit/ })).toBeTruthy();
  await user.keyboard('{Enter}');
  const usual = panel().getByRole('button', { name: /Same as last time.*Margherita M/ });
  expect(document.activeElement).toBe(usual);
  expect(panel().getByRole('button', { name: 'Customer Dilani: change' }).textContent).toContain('2nd visit');
  await user.keyboard('{Enter}');

  expect(panel().getByText('Margherita')).toBeTruthy();
  expect(panel().queryByRole('button', { name: /Same as last time/ })).toBeNull(); // offered on an empty order only
});

test('Esc: no customer, and Charge still offers Mobile; × takes a customer off again', async () => {
  crm.lookup.mockResolvedValue({ customer: DILANI });
  const user = userEvent.setup();
  render(<App />);
  await typeMobile(user);
  await user.keyboard('{Escape}');
  expect(panel().queryByRole('textbox', { name: 'Customer' })).toBeNull();
  expect(panel().getByRole('button', { name: /Add customer/ })).toBeTruthy();

  await user.click(panel().getByRole('button', { name: /Add customer/ }));
  await user.keyboard('0771234567');
  await panel().findByRole('button', { name: /Dilani/ });
  await user.keyboard('{Enter}');
  await user.click(panel().getByRole('button', { name: 'Take the customer off' }));
  expect(panel().queryByRole('button', { name: /Customer Dilani/ })).toBeNull();

  await user.click(screen.getAllByRole('button', { name: 'M 1,450' })[0]);
  await sendAndPay(user);
  expect(screen.getByRole('textbox', { name: /Mobile/ })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: /Exact cash/ }));
  expect(paidEvent()?.customerId).toBeUndefined();
});
