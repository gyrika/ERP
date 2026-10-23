import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readAll } from './eventLog.ts';
import { InventoryView } from './InventoryView.tsx';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  render(<InventoryView />);
  await user.click(screen.getByRole('button', { name: 'Stock rules' }));
  return within(screen.getByRole('dialog', { name: 'Stock rules' }));
};
const usage = 'Daily use is worked out from the last days of sales';
const share = 'A count needs a reason when it is more than % of what was expected';

test('anyone can read the stock rules; only the owner, with his PIN, changes them', async () => {
  const user = userEvent.setup();
  const rules = await open(user);
  expect(rules.getByRole('textbox', { name: usage })).toHaveProperty('value', '14');
  expect(rules.getByRole('textbox', { name: share })).toHaveProperty('value', '10');
  expect(rules.getByRole('textbox', { name: '…or worth more than Rs' })).toHaveProperty('value', '2,000');
  expect(rules.getByRole('textbox', { name: usage })).toHaveProperty('readOnly', true);
  expect(rules.queryByRole('button', { name: 'Save rules' })).toBeNull();

  await user.click(rules.getByRole('button', { name: 'Change (owner)' }));
  await user.type(rules.getByLabelText('Owner PIN'), '2580'); // the manager's: refused
  expect(rules.getByRole('alert').textContent).toBe('Only the owner changes the stock rules.');
  await user.type(rules.getByLabelText('Owner PIN'), '9999');
  expect(rules.getByRole('textbox', { name: usage })).toHaveProperty('readOnly', false);
  expect(readAll()).toHaveLength(0);
});

test('a wrong number is refused with what to type, and nothing is saved; a good change is audited with Undo', async () => {
  const user = userEvent.setup();
  const rules = await open(user);
  await user.click(rules.getByRole('button', { name: 'Change (owner)' }));
  await user.type(rules.getByLabelText('Owner PIN'), '9999');

  const days = rules.getByRole('textbox', { name: usage });
  await user.clear(days);
  await user.type(days, '0');
  await user.click(rules.getByRole('button', { name: 'Save rules' }));
  expect(rules.getByRole('alert').textContent).toContain('Type a number from 1 to 90.');
  await user.clear(days);
  await user.type(days, 'two weeks');
  await user.click(rules.getByRole('button', { name: 'Save rules' }));
  expect(rules.getByRole('alert').textContent).toContain('type it as digits, like 14');
  expect(readAll()).toHaveLength(0);

  await user.clear(days);
  await user.type(days, '21');
  const percent = rules.getByRole('textbox', { name: share });
  await user.clear(percent);
  await user.type(percent, '15');
  await user.click(rules.getByRole('button', { name: 'Save rules' }));
  expect(readAll().map((e) => e.type === 'stock.settings_set' && [e.key, e.value, e.actor.role])).toEqual([['countGapShare', 0.15, 'owner'], ['usageDays', 21, 'owner']]);
  expect(screen.queryByRole('dialog', { name: 'Stock rules' })).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('Stock rules changed (2).Undo');

  // The new numbers show next time; Undo puts the old ones back.
  await user.click(within(screen.getByRole('status')).getByRole('button', { name: 'Undo' }));
  expect(readAll().slice(2).map((e) => e.type === 'stock.settings_set' && [e.key, e.value])).toEqual([['countGapShare', 0.1], ['usageDays', 14]]);
  await user.click(screen.getByRole('button', { name: 'Stock rules' }));
  expect(screen.getByRole('textbox', { name: usage })).toHaveProperty('value', '14');
});
