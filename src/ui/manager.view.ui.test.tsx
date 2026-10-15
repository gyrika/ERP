import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readAll } from './eventLog.ts';
import { FAKE_STAFF } from '../fake/data.ts';
import { EDIT_IDLE_MS, ManagerView } from './ManagerView.tsx';

const pinFor = (role: string) => FAKE_STAFF.find((s) => s.actor.role === role)!.pin;

// The manager's page (SCRUM-90): today's progress, the three count lists, the record.

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.useRealTimers(); });

test('today, the daily / weekly / monthly lists with one Start each, and the record', async () => {
  const user = userEvent.setup();
  render(<ManagerView />);
  const today = within(screen.getByRole('region', { name: 'Today' }));
  expect(today.getByText(/^0 of \d+ counted today$/)).toBeTruthy();
  for (const t of ['Daily', 'Weekly', 'Monthly']) expect(screen.getByRole('region', { name: `${t} counts` })).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Count record, last 52 weeks' })).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'Count record' })).getByText('No streak yet')).toBeTruthy();

  // Before any sales the 8 dearest packs are daily; count the first monthly item.
  const monthly = within(screen.getByRole('region', { name: 'Monthly counts' }));
  await user.click(monthly.getByRole('button', { name: /^Start monthly · \d+$/ }));
  const form = within(screen.getByRole('form', { name: /^Count / }));
  await user.type(form.getByRole('textbox', { name: 'Full packs' }), '1');
  await user.click(form.getByRole('button', { name: 'Next' }));
  expect(readAll().at(-1)).toMatchObject({ type: 'stock.counted', tier: 'monthly' });
  await user.keyboard('{Escape}');

  expect(today.getByText(/^1 of \d+ counted today$/)).toBeTruthy();
  expect(monthly.getAllByText('Done')).toHaveLength(1);
  expect(monthly.getByText(/^1 of \d+ this month$/)).toBeTruthy();
});

test('the owner moves an item to another list, and back to automatic', async () => {
  const user = userEvent.setup();
  render(<ManagerView />);
  const daily = () => within(screen.getByRole('region', { name: 'Daily counts' }));
  expect(daily().getByText(/^0 of 8 today$/)).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Edit lists' }));
  await user.type(screen.getByLabelText('Owner PIN'), pinFor('manager'));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Only the owner can edit the lists.');
  expect(screen.queryByRole('combobox')).toBeNull();
  await user.type(screen.getByLabelText('Owner PIN'), pinFor('owner'));
  await user.selectOptions(screen.getByRole('combobox', { name: 'How often to count Salt' }), 'daily');
  expect(readAll().at(-1)).toMatchObject({ type: 'stock.tier_set', tier: 'daily', actor: { role: 'owner' } });
  expect(daily().getByText('Salt')).toBeTruthy();
  expect(daily().getByText(/^0 of 9 today$/)).toBeTruthy();

  await user.selectOptions(screen.getByRole('combobox', { name: 'How often to count Salt' }), 'auto');
  expect(readAll().at(-1)).toMatchObject({ type: 'stock.tier_set', tier: null });
  expect(daily().queryByText('Salt')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Done' }));
  expect(screen.queryByRole('combobox')).toBeNull();
});

test('Edit lists closes after a minute untouched', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(<ManagerView />);
  await user.click(screen.getByRole('button', { name: 'Edit lists' }));
  await user.type(screen.getByLabelText('Owner PIN'), pinFor('owner'));
  expect(await screen.findAllByRole('combobox')).not.toHaveLength(0);
  act(() => { vi.advanceTimersByTime(EDIT_IDLE_MS + 10); });
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.getByRole('button', { name: 'Edit lists' })).toBeTruthy();
});
