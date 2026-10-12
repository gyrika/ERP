import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Root } from './Root.tsx';

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, '', '/');
});
afterEach(cleanup);

const panel = () => within(screen.getByRole('complementary', { name: 'Current order' }));
const kitchen = () => within(screen.getByRole('main', { name: 'Orders to make' }));

const sendOne = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: /^Devilled Chicken/ }));
  await user.click(screen.getByRole('button', { name: /Large/ }));
  await user.click(screen.getByRole('button', { name: /^Add ·/ }));
  await user.click(panel().getByRole('button', { name: 'Send to kitchen' }));
};

test('one counter PC: F2 flips Register ⇄ Kitchen, the chip shows what is cooking, Space bumps the oldest', async () => {
  const user = userEvent.setup();
  render(<Root />);
  expect(screen.getByRole('button', { name: 'Kitchen: nothing cooking' })).toBeTruthy();

  await sendOne(user);
  expect(screen.getByRole('button', { name: 'Kitchen: 1 cooking, oldest waiting 00:00' })).toBeTruthy();

  await user.keyboard('{F2}');
  expect(location.hash).toBe('#kitchen');
  expect(kitchen().getByRole('article', { name: 'Order 1001' })).toBeTruthy();

  await user.keyboard(' ');
  expect(kitchen().getByText('No orders waiting')).toBeTruthy();

  await user.keyboard('{Control>}z{/Control}');
  expect(kitchen().getByRole('article', { name: 'Order 1001' })).toBeTruthy();

  await user.keyboard('{F2}');
  expect(location.hash).toBe('');
  expect(screen.getByRole('complementary', { name: 'Current order' })).toBeTruthy();

  // Touch works too: the chip opens the Kitchen, the Register key (or Esc) comes back.
  await user.click(screen.getByRole('button', { name: /^Kitchen: 1 cooking/ }));
  await user.click(screen.getByRole('button', { name: /^Register/ }));
  expect(screen.getByRole('complementary', { name: 'Current order' })).toBeTruthy();
  await user.keyboard('{F2}{Escape}');
  expect(screen.getByRole('complementary', { name: 'Current order' })).toBeTruthy();
});

test('a kitchen device opened at /#kitchen has no Register key', () => {
  history.replaceState(null, '', '/#kitchen');
  render(<Root />);
  expect(kitchen().getByText('No orders waiting')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Register/ })).toBeNull();
});
