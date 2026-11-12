import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readAll } from './eventLog.ts';

// #unlock: the developers' password turns a module on or off.

const setup = vi.hoisted(() => ({ modules: vi.fn(), unlockModule: vi.fn() }));
vi.mock('../services/setupClient.ts', () => ({ setupClient: setup }));
const { default: UnlockView } = await import('./UnlockView.tsx');

const SHOP = 'cheesybeez-thalwila-a1b2';
const AT = Date.UTC(2026, 10, 11, 6, 0);
let on = false;

beforeEach(() => {
  localStorage.clear();
  on = false;
  setup.modules.mockImplementation(async () => ({ shopId: SHOP, modules: [{ id: 'crm', on, since: on ? AT : null }] }));
  setup.unlockModule.mockImplementation(async (password: string, module: string, turnOn: boolean) => {
    if (password !== 'right') throw new Error("that is not the developers' password");
    on = turnOn;
    return {
      module, on: turnOn,
      events: [{ id: `m-${turnOn}`, shopId: SHOP, at: AT, orderNumber: 0, actor: { id: 'developers', name: 'CheesyBeez developers', role: 'owner' }, type: 'shop.module_set', module, on: turnOn, codeId: '0123456789abcdef' }],
    };
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

test('the password, then Turn on: Customers is on; a wrong password says so', async () => {
  const user = userEvent.setup();
  render(<UnlockView onClose={() => {}} />);
  const turnOn = await screen.findByRole('button', { name: 'Turn on' });
  expect(screen.getByText('Off')).toBeTruthy();

  await user.click(turnOn);
  expect((await screen.findByRole('alert')).textContent).toBe('Type the developers’ password first.');
  expect(setup.unlockModule).not.toHaveBeenCalled();

  const box = screen.getByLabelText('Developers’ password');
  expect((box as HTMLInputElement).type).toBe('password');
  await user.type(box, 'wrong');
  await user.click(turnOn);
  expect((await screen.findByRole('alert')).textContent).toMatch(/not the developers' password/);

  await user.clear(box);
  await user.type(box, 'right');
  await user.click(turnOn);
  expect((await screen.findByRole('status')).textContent).toBe('Customers (CRM) is on.');
  expect(setup.unlockModule).toHaveBeenLastCalledWith('right', 'crm', true);
  expect(screen.getByText(/^On · since/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy();
  expect(readAll().some((e) => e.type === 'shop.module_set'), 'this screen knows at once').toBe(true);
  expect((box as HTMLInputElement).value, 'the password does not stay in the box').toBe('');
});
