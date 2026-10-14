import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setMenuState } from '../domain/menu.ts';
import { EMPTY_MENU_STATE } from '../domain/menuEdits.ts';
import { FAKE_STAFF } from '../fake/data.ts';
import { readAll } from './eventLog.ts';
import { RECIPES_IDLE_MS } from './RecipesView.tsx';
import { Root } from './Root.tsx';

const pinFor = (role: string) => FAKE_STAFF.find((s) => s.actor.role === role)!.pin;

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/#recipes'); setMenuState(EMPTY_MENU_STATE); });
afterEach(() => { cleanup(); vi.useRealTimers(); setMenuState(EMPTY_MENU_STATE); });

const card = (name: string) => screen.getByText(name, { selector: '.rcard__name' }).closest('.rcard') as HTMLElement;

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByLabelText('Owner PIN'), pinFor('owner'));
  await screen.findByRole('heading', { name: 'Your recipes' });
};

test('the recipes open only with the owner PIN, and the opening is recorded', async () => {
  const user = userEvent.setup();
  render(<Root />);
  expect(screen.getByRole('heading', { name: 'CheesyBeez recipes' })).toBeTruthy();
  expect(screen.queryByText('Margherita Medium')).toBeNull();

  await user.type(screen.getByLabelText('Owner PIN'), pinFor('manager'));
  expect((await screen.findByRole('alert')).textContent).toBe('Only the owner can open the recipes.');
  expect(screen.queryByRole('heading', { name: 'Your recipes' })).toBeNull();

  await open(user);
  expect(readAll().at(-1)).toMatchObject({ type: 'recipe.viewed', actor: { role: 'owner' } });
  expect(screen.getByText(/of \d+ complete\. Until a recipe is complete/)).toBeTruthy();
});

test('a missing recipe is written from a similar one, saved as his, and Undo takes it back', async () => {
  const user = userEvent.setup();
  render(<Root />);
  await open(user);
  expect(within(card('Sausages Medium')).getByText('No recipe yet')).toBeTruthy();

  await user.click(within(card('Sausages Medium')).getByRole('button', { name: 'Write it' }));
  const form = within(screen.getByRole('form', { name: 'Sausages Medium: recipe' }));
  await user.click(form.getByRole('button', { name: 'BBQ Sausages Medium' }));
  expect((form.getByRole('combobox', { name: 'Line 1: what goes in' }) as HTMLSelectElement).value).toBe('10inch Dough Ball');
  await user.click(form.getByRole('button', { name: 'Save recipe' }));

  const saved = readAll().at(-1)!;
  expect(saved).toMatchObject({ type: 'recipe.answer_set', question: 'recipe:sausages:M', before: null, after: { kind: 'own' }, actor: { role: 'owner' } });
  expect(screen.getByRole('status').textContent).toContain('Sausages Medium: your recipe is saved.');
  expect(within(card('Sausages Medium')).queryByText('No recipe yet')).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Undo' }));
  expect(readAll().at(-1)).toMatchObject({ question: 'recipe:sausages:M', after: null });
  expect(within(card('Sausages Medium')).getByText('No recipe yet')).toBeTruthy();
});

test('a line straight from stock, with its unit taken from the stock item', async () => {
  const user = userEvent.setup();
  render(<Root />);
  await open(user);
  await user.click(within(card('Extra chicken')).getByRole('button', { name: 'Write it' }));
  const form = within(screen.getByRole('form', { name: 'Extra chicken: recipe' }));
  await user.selectOptions(form.getByRole('combobox', { name: 'Line 1: what goes in' }), 'Chicken');
  await user.type(form.getByRole('textbox', { name: 'Line 1: how much' }), '60');
  expect(form.getByText(/^Costs [\d,.]+ · earns \d+% of 400$/)).toBeTruthy();
  await user.click(form.getByRole('button', { name: 'Save recipe' }));
  expect(readAll().at(-1)).toMatchObject({
    question: 'addon:chicken', after: { kind: 'own', lines: [{ name: 'stock:inv-0011', qty: 60, unit: 'g' }] },
  });
  expect(within(card('Extra chicken')).getByText(/^Complete · costs/)).toBeTruthy();
});

test('amounts stay hidden until a recipe is opened', async () => {
  const user = userEvent.setup();
  render(<Root />);
  await open(user);
  const margherita = card('Margherita Medium');
  expect(within(margherita).getByRole('list', { hidden: true }).getAttribute('aria-hidden')).toBe('true');
  await user.click(within(margherita).getByRole('button', { name: /Margherita Medium/ }));
  expect(within(margherita).getByRole('list').getAttribute('aria-hidden')).toBe('false');
  expect(within(margherita).getByText('3 of its gaps are asked at the top.')).toBeTruthy();
});

test('a gap shared by many recipes is asked once, at the top, and answering it moves them on', async () => {
  const user = userEvent.setup();
  render(<Root />);
  await open(user);
  const top = within(screen.getByRole('region', { name: 'First, these' }));
  // One at a time: his cheese blend, his sauce and basil (every pizza), then ketchup, chicken cubes, mayonnaise, the sausage.
  expect(top.getByRole('heading', { name: 'First, these · 7 to go' })).toBeTruthy();
  expect(top.getAllByRole('form').length).toBe(1);
  await user.click(top.getByRole('button', { name: 'Skip' }));
  expect(top.getAllByRole('form').length).toBe(1);
  while (!top.queryByRole('form', { name: 'Mozzarella Blend: how much does one batch make?' })) await user.click(top.getByRole('button', { name: 'Skip' }));
  const cheese = within(top.getByRole('form', { name: 'Mozzarella Blend: how much does one batch make?' }));
  await user.type(cheese.getByRole('textbox', { name: 'One batch makes (g)' }), '2000{Enter}');
  expect(readAll().at(-1)).toMatchObject({ question: 'yield:Mozzarella Blend', after: { kind: 'yield', qty: 2000 }, actor: { role: 'owner' } });
  expect(within(card('Margherita Medium')).getByText('2 things missing')).toBeTruthy();
  expect(top.getByRole('heading', { name: 'First, these · 6 to go' })).toBeTruthy();
});

test('a minute untouched locks the recipes again', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(<Root />);
  await open(user);
  act(() => { vi.advanceTimersByTime(RECIPES_IDLE_MS + 10); });
  expect(screen.getByRole('heading', { name: 'CheesyBeez recipes' })).toBeTruthy();
  expect(screen.queryByText('Margherita Medium')).toBeNull();
});
