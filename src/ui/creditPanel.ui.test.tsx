import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Actor } from '../domain/auth.ts';

// Credit on a customer's page (credit.ts): the owner turns it on with a limit, changes it, or turns it
// off, each with Undo; a manager only sees it.

const me = vi.hoisted(() => ({ actor: null as Actor | null }));
vi.mock('../services/serverAuth.ts', async (real) => ({
  ...(await real<typeof import('../services/serverAuth.ts')>()),
  signedIn: () => me.actor,
}));
const { CreditPanel } = await import('./customers/CreditPanel.tsx');
const { readAll } = await import('./eventLog.ts');
const { creditOf } = await import('../domain/credit.ts');

const ID = 'cus-00000000000000d1';
beforeEach(() => { localStorage.clear(); me.actor = { id: 'o', name: 'Anton', role: 'owner' }; });
afterEach(() => { cleanup(); });

const open = (isOwner = true, onSaved = vi.fn()) =>
  render(<CreditPanel customerId={ID} name="Dilani" events={readAll()} now={Date.now()} isOwner={isOwner} onSaved={onSaved} />);

test('the owner changes the default limit; Undo puts the default back', async () => {
  const onSaved = vi.fn();
  const user = userEvent.setup();
  open(true, onSaved);
  // Every customer starts with the shop's default: Rs 100,000.
  expect(screen.getByRole('radio', { name: 'With a limit' }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByText('limit · the shop default')).toBeTruthy();
  expect(screen.getByLabelText('Limit, Rs')).toHaveProperty('value', '100000');
  await user.clear(screen.getByLabelText('Limit, Rs'));
  await user.type(screen.getByLabelText('Limit, Rs'), '20,000');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(creditOf(readAll(), ID).setting).toEqual({ limit: 2_000_000 });
  expect(onSaved.mock.calls[0][0].message).toBe('Dilani: credit on, limit Rs 20,000.');
  await onSaved.mock.calls[0][0].undo();
  expect(creditOf(readAll(), ID).setting).toEqual({ limit: 10_000_000 });
});

test('changing the limit, no limit, and off; a limit that is not a number is not saved', async () => {
  const user = userEvent.setup();
  const { unmount } = open();
  await user.clear(screen.getByLabelText('Limit, Rs'));
  await user.type(screen.getByLabelText('Limit, Rs'), 'abc');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByRole('alert').textContent).toContain('Type the limit');
  await user.click(screen.getByRole('radio', { name: 'No limit' }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(creditOf(readAll(), ID).setting).toEqual({ limit: null });
  unmount();
  open();
  expect(screen.getByRole('radio', { name: 'No limit' }).getAttribute('aria-checked')).toBe('true');
  await user.click(screen.getByRole('radio', { name: 'Off' }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(creditOf(readAll(), ID).setting).toBeNull();
});

test('a manager sees the credit but cannot change it', () => {
  me.actor = { id: 'm', name: 'Ravi', role: 'manager' };
  open(false);
  expect(screen.queryByRole('radio', { name: 'With a limit' })).toBeNull();
  expect(screen.getByText(/Only the owner turns credit on or off/)).toBeTruthy();
});
