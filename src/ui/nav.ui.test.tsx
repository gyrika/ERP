/**
 * One Back (nav.ts): Esc, the mouse's back button, Alt+← and the browser's Back all go to
 * where you just were; a sheet on top closes first; the Register is never left by accident.
 */
import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { parentOf } from './nav.ts';
import { Root } from './Root.tsx';

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, '', '/');
});
afterEach(cleanup);

const register = () => screen.findByRole('complementary', { name: 'Current order' });
const mouseBack = () => {
  fireEvent.mouseDown(window, { button: 3 });
  fireEvent.mouseUp(window, { button: 3 });
};

test('the place above: #items/recipe/x → #items/recipe → #items → the Register', () => {
  expect(parentOf('#items/recipe/margherita')).toBe('#items/recipe');
  expect(parentOf('#items/semi')).toBe('#items');
  expect(parentOf('#items')).toBe('');
  expect(parentOf('')).toBe('');
});

test('Find supplier, then Back: Items again, not the screen before it; Forward keeps the filter', async () => {
  const user = userEvent.setup();
  render(<Root />);
  await register();
  location.hash = '#items';
  await user.click((await screen.findAllByRole('button', { name: 'Prima / David Stores (Wholesale)' }))[0]);
  expect(location.hash).toBe('#suppliers');
  expect(screen.getByRole('heading', { name: 'Targeted Suppliers' })).toBeTruthy();

  await user.keyboard('{Escape}');
  expect(await screen.findByRole('main', { name: 'Inventory' })).toBeTruthy();
  expect(location.hash).toBe('#items');

  history.forward();
  expect(await screen.findByRole('heading', { name: 'Targeted Suppliers' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Nimmi veg shop/ })).toBeNull();

  await user.keyboard('{Escape}'); // Items
  await screen.findByRole('main', { name: 'Inventory' });
  await user.keyboard('{Escape}'); // the Register
  expect(await register()).toBeTruthy();
  expect(location.hash).toBe('');
});

test('Esc with a sheet open closes the sheet only; the next Esc leaves the place', async () => {
  const user = userEvent.setup();
  history.replaceState(null, '', '/#menu');
  render(<Root />);
  await user.click(await screen.findByRole('button', { name: 'Change Margherita' }));
  expect(screen.getByRole('dialog', { name: 'Change Margherita' })).toBeTruthy();

  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: 'Change Margherita' })).toBeNull();
  expect(screen.getByRole('main', { name: 'Menu' })).toBeTruthy();
  expect(location.hash).toBe('#menu');

  await user.keyboard('{Escape}');
  expect(await register()).toBeTruthy();
});

test('Esc in a search box leaves the box first, then the place', async () => {
  const user = userEvent.setup();
  history.replaceState(null, '', '/#items');
  render(<Root />);
  const search = await screen.findByPlaceholderText('Search ingredient, category or supplier');
  await user.type(search, 'flour');
  await user.keyboard('{Escape}');
  expect(document.activeElement).not.toBe(search);
  expect(screen.getByRole('main', { name: 'Inventory' })).toBeTruthy();

  await user.keyboard('{Escape}');
  expect(await register()).toBeTruthy();
});

test("the mouse's back button and Alt+← are the same Back: sheet first, then the place", async () => {
  const user = userEvent.setup();
  render(<Root />);
  await register();
  location.hash = '#menu';
  await user.click(await screen.findByRole('button', { name: 'Change Margherita' }));

  mouseBack();
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Change Margherita' })).toBeNull());
  expect(location.hash).toBe('#menu');

  await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
  expect(await register()).toBeTruthy();
  expect(location.hash).toBe('');
});

test('a place opened directly goes up, one level at a time', async () => {
  const user = userEvent.setup();
  history.replaceState(null, '', '/#items/semi');
  render(<Root />);
  expect(await screen.findByRole('main', { name: 'Semi-processed' })).toBeTruthy();

  mouseBack();
  expect(await screen.findByRole('main', { name: 'Inventory' })).toBeTruthy();
  expect(location.hash).toBe('#items');

  await user.keyboard('{Escape}');
  expect(await register()).toBeTruthy();
});

test('on the Register, Back never leaves the app', async () => {
  const user = userEvent.setup();
  render(<Root />);
  await register();
  const before = history.length;
  mouseBack();
  await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
  await user.keyboard('{Escape}');
  expect(location.hash).toBe('');
  expect(history.length).toBe(before);
  expect(await register()).toBeTruthy();
});

test("a step's own Back wins: Esc on Order by supplier goes back to Orders, once", async () => {
  const user = userEvent.setup();
  render(<Root />);
  await register();
  location.hash = '#order';
  await user.click(await screen.findByRole('button', { name: 'Order by supplier' }));
  expect(location.hash).toBe('#order/suppliers');
  await user.click(screen.getByRole('button', { name: '+ Ajantha (Wholesale)' }));
  // Back is a button in the title row (top right), never in the foot.
  const backKey = screen.getByRole('button', { name: 'Back' });
  expect(backKey.closest('.sheet__title')).toBeTruthy();
  expect(backKey.closest('.flow__foot')).toBeNull();

  await user.keyboard('{Escape}'); // Items → the supplier list, on the same page
  expect(await screen.findByRole('group', { name: 'Order from a supplier' })).toBeTruthy();
  expect(location.hash).toBe('#order/suppliers');

  await user.keyboard('{Escape}'); // → Orders, not past it
  expect(await screen.findByRole('button', { name: 'Order by item' })).toBeTruthy();
  await new Promise((r) => setTimeout(r, 50));
  expect(location.hash).toBe('#order');
});
