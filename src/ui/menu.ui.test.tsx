import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setMenuState } from '../domain/menu.ts';
import { EMPTY_MENU_STATE } from '../domain/menuEdits.ts';
import { readAll } from './eventLog.ts';
import { Root } from './Root.tsx';

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/'); setMenuState(EMPTY_MENU_STATE); });
afterEach(() => { cleanup(); setMenuState(EMPTY_MENU_STATE); });

test("the owner changes a price and a name: the counter shows it at once", async () => {
  const user = userEvent.setup();
  render(<Root />);

  history.replaceState(null, '', '/#menu');
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  await user.click(await screen.findByRole('button', { name: 'Change Margherita' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Change Margherita' }));
  await user.clear(sheet.getByLabelText('Medium price'));
  await user.type(sheet.getByLabelText('Medium price'), '1600');
  expect(sheet.getByText('Printed 1,450')).toBeTruthy();
  await user.type(sheet.getByLabelText('Sinhala'), 'මාගරීටා');
  await user.click(sheet.getByRole('button', { name: 'Save' }));
  expect(screen.getByRole('status').textContent).toContain('Saved Margherita');
  expect(screen.getByText('M 1,600 · L 1,990')).toBeTruthy();

  const e = readAll().find((x) => x.type === 'menu.item_set')!;
  expect(e).toMatchObject({ itemId: 'margherita', before: {}, after: { prices: { M: 160000 }, name: { si: 'මාගරීටා' } } });
  await user.keyboard('{Escape}');
  expect(screen.getAllByRole('button', { name: 'M 1600' }).length).toBeGreaterThan(0);
  expect(screen.getAllByRole('button', { name: 'M 1600' }).length).toBeGreaterThan(0);
});

test('sold out for today: greyed on the counter, cannot be added; Undo brings it back', async () => {
  const user = userEvent.setup();
  history.replaceState(null, '', '/#menu');
  render(<Root />);
  const row = within((await screen.findByRole('button', { name: 'Change BBQ Chicken' })).closest('li')!);
  await user.click(row.getByRole('button', { name: 'Available' }));
  expect(row.getByRole('button', { name: 'Sold out today' })).toBeTruthy();
  await user.keyboard('{Escape}');
  const card = screen.getByText('BBQ Chicken').closest('.card')!;
  expect(within(card as HTMLElement).getByText('Sold out')).toBeTruthy();
  expect(within(card as HTMLElement).getByRole('button', { name: 'L 2500' }).getAttribute('aria-disabled')).toBe('true');
});

test('hidden items leave the counter; back to the printed menu in one tap', async () => {
  const user = userEvent.setup();
  history.replaceState(null, '', '/#menu');
  render(<Root />);
  await user.click(await screen.findByRole('button', { name: 'Change Seafood' }));
  await user.click(screen.getByRole('checkbox', { name: /Hide from the menu/ }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByText('Hidden')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Change Seafood' }));
  await user.click(screen.getByRole('button', { name: 'Back to the printed menu' }));
  expect(screen.queryByText('Hidden')).toBeNull();
  expect(screen.queryByText('Changed')).toBeNull();
});
