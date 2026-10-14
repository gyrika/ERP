import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readAll } from './eventLog.ts';
import { ManagerView } from './ManagerView.tsx';

// The manager's page (SCRUM-90): today's progress, the three count lists, the record.

beforeEach(() => localStorage.clear());
afterEach(cleanup);

test('today, the daily / weekly / monthly lists with one Start each, and the record', async () => {
  const user = userEvent.setup();
  render(<ManagerView />);
  const today = within(screen.getByRole('region', { name: 'Today' }));
  expect(today.getByText(/^0 of \d+ counted today$/)).toBeTruthy();
  for (const t of ['Daily', 'Weekly', 'Monthly']) expect(screen.getByRole('region', { name: `${t} counts` })).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Count record, last 52 weeks' })).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'Count record' })).getByText('No streak yet')).toBeTruthy();

  // No sales yet, so everything is monthly: start that group and count the first item.
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
