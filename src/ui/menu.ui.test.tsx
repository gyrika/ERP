import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EMPTY_MENU_STATE } from '../domain/menuEdits.ts';
import { setMenuState } from '../domain/menu.ts';
import { readAll } from './eventLog.ts';
import { Root } from './Root.tsx';

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, '', '/#menu');
  setMenuState(EMPTY_MENU_STATE);
});
afterEach(() => {
  cleanup();
  setMenuState(EMPTY_MENU_STATE);
});

test('owner can change a menu price, the edit is event-backed, and Undo restores it', async () => {
  const user = userEvent.setup();
  render(<Root />);

  await user.click(screen.getByRole('button', { name: 'Change Margherita' }));
  await user.clear(screen.getByRole('textbox', { name: 'Medium price' }));
  await user.type(screen.getByRole('textbox', { name: 'Medium price' }), '1600');
  await user.click(screen.getByRole('button', { name: 'Save' }));

  expect(readAll().some((event) => event.type === 'menu.item_set')).toBe(true);
  expect(screen.getByRole('status').textContent).toContain('Saved Margherita');
  expect(screen.getByRole('button', { name: 'Change Margherita' }).closest('li')?.textContent).toContain('M 1,600');

  await user.click(screen.getByRole('button', { name: 'Undo' }));
  expect(screen.getByRole('button', { name: 'Change Margherita' }).closest('li')?.textContent).toContain('M 1,450');
});

test('menu screen can mark an item sold out and Register disables it', async () => {
  const user = userEvent.setup();
  render(<Root />);

  const margherita = screen.getByText('Margherita', { selector: 'b' }).closest('li')!;
  await user.click(within(margherita).getByRole('button', { name: 'Available' }));
  expect(within(margherita).getByRole('button', { name: 'Sold out today' }).getAttribute('aria-pressed')).toBe('true');
  expect(readAll().some((event) => event.type === 'menu.sold_out')).toBe(true);

  await user.click(screen.getByRole('button', { name: /Register/ }));
  expect(screen.getAllByRole('button', { name: 'M 1450' })[0].getAttribute('aria-disabled')).toBe('true');
});
