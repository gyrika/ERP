import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readAll } from './eventLog.ts';

// #unlock: the developers' one-time code turns a module on; the shop's id is there to make one.

const setup = vi.hoisted(() => ({ modules: vi.fn(), unlockModule: vi.fn() }));
vi.mock('../services/setupClient.ts', () => ({ setupClient: setup }));
const { default: UnlockView } = await import('./UnlockView.tsx');

const SHOP = 'cheesybeez-thalwila-a1b2';
const AT = Date.UTC(2026, 10, 11, 6, 0);
let on = false;

beforeEach(() => {
  localStorage.clear();
  on = false;
  setup.modules.mockImplementation(async () => ({ shopId: SHOP, keyed: true, modules: [{ id: 'crm', on, since: on ? AT : null }] }));
  setup.unlockModule.mockImplementation(async (code: string) => {
    if (code !== 'CB1.good.code') throw new Error('the code is not signed by the developers (or was copied wrong)');
    on = true;
    return {
      module: 'crm', on: true,
      events: [{ id: 'm1', shopId: SHOP, at: AT, orderNumber: 0, actor: { id: 'developers', name: 'CheesyBeez developers', role: 'owner' }, type: 'shop.module_set', module: 'crm', on: true, codeId: '0123456789abcdef' }],
    };
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

test('the shop id to make the code for; a good code turns Customers on, a bad one says why', async () => {
  const user = userEvent.setup();
  render(<UnlockView onClose={() => {}} />);
  expect((await screen.findByText(SHOP)).tagName).toBe('CODE');
  expect(screen.getByText('Customers (CRM)').nextElementSibling?.textContent).toBe('Off');

  const box = screen.getByLabelText('Developer code');
  await user.type(box, 'CB1.forged');
  await user.click(screen.getByRole('button', { name: 'Use code' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/not signed by the developers/);

  await user.clear(box);
  await user.type(box, 'CB1.good.code');
  await user.click(screen.getByRole('button', { name: 'Use code' }));
  expect((await screen.findByRole('status')).textContent).toBe('Customers (CRM) is on.');
  expect(screen.getByText('Customers (CRM)').nextElementSibling?.textContent).toMatch(/^On · since/);
  expect(readAll().some((e) => e.type === 'shop.module_set'), 'this screen knows at once').toBe(true);
  expect((box as HTMLTextAreaElement).value).toBe('');
});

test('a version with no developer key says so and offers no box', async () => {
  setup.modules.mockResolvedValueOnce({ shopId: SHOP, keyed: false, modules: [{ id: 'crm', on: false, since: null }] });
  render(<UnlockView onClose={() => {}} />);
  expect(await screen.findByText(/carries no developer key/)).toBeTruthy();
  expect(screen.queryByLabelText('Developer code')).toBeNull();
});
