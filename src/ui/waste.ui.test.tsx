import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FAKE_STAFF } from '../fake/data.ts';
import { App } from './App.tsx';
import { readAll } from './eventLog.ts';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const pin = FAKE_STAFF.find((s) => s.actor.role === 'manager')!.pin;
const wastes = () => readAll().filter((e) => e.type === 'stock.wasted');

test('manager mode: the bin wastes a dish through its recipe, with Undo', async () => {
  const user = userEvent.setup();
  render(<App />);
  expect(screen.queryByRole('button', { name: /Waste/ })).toBeNull(); // not for the cashier

  await user.keyboard('{Control>}m{/Control}');
  await user.keyboard(pin);
  await user.click(screen.getByRole('button', { name: /Waste/ }));

  const sheet = () => within(screen.getByRole('dialog', { name: 'Waste' }));
  await user.keyboard('margherita large');
  await user.keyboard('{Enter}');
  expect(sheet().getByText('Margherita · Large')).toBeTruthy();
  // The link to stock shows before anything is recorded.
  expect(within(sheet().getByRole('region', { name: 'Takes from stock' })).getAllByRole('listitem').length).toBeGreaterThan(0);

  expect((sheet().getByRole('button', { name: 'Choose a reason' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(sheet().getByRole('button', { name: /Burnt/ }));
  await user.click(sheet().getByRole('button', { name: 'Waste' }));

  expect(screen.queryByRole('dialog', { name: 'Waste' })).toBeNull();
  const [w] = wastes();
  expect(w).toMatchObject({ what: { kind: 'dish', itemId: 'margherita', size: 'L' }, name: 'Margherita · Large', qty: 1, reason: 'burnt' });
  expect('actor' in w && w.actor.role).toBe('manager');

  const toast = screen.getAllByRole('status').find((el) => el.textContent?.includes('Wasted 1 × Margherita · Large'))!;
  await user.click(within(toast).getByRole('button', { name: 'Undo' }));
  expect(readAll().some((e) => e.type === 'stock.waste_undone' && e.wasteId === w.id)).toBe(true);
});

test('a raw item is wasted in its own unit', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.keyboard('{Control>}m{/Control}');
  await user.keyboard(pin);
  await user.keyboard('w');
  await user.keyboard('flour');
  const option = screen.getAllByRole('option').find((o) => o.textContent?.includes('Raw'))!;
  await user.click(option);
  await user.keyboard('500');
  await user.click(screen.getByRole('button', { name: /Expired/ }));
  await user.keyboard('{Enter}');
  expect(wastes()[0]).toMatchObject({ what: { kind: 'stock' }, qty: 500, reason: 'expired' });
});

test('the bin shows in manager mode even when a cashier is signed in (the PIN is a manager\'s)', async () => {
  const user = userEvent.setup();
  render(<App canManageStock={false} />);
  await user.keyboard('{Control>}m{/Control}');
  await user.keyboard(pin);
  expect(screen.getByRole('button', { name: /Waste/ })).toBeTruthy();
});

test('raw materials are one tap away, without searching', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.keyboard('{Control>}m{/Control}');
  await user.keyboard(pin);
  await user.keyboard('w');
  await user.click(screen.getByRole('button', { name: 'Raw materials' }));
  const options = screen.getAllByRole('option');
  expect(options.length).toBeGreaterThan(5);
  expect(options.every((o) => o.textContent?.includes('Raw'))).toBe(true);
});
