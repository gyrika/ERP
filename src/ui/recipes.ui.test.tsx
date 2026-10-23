import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setMenuState } from '../domain/menu.ts';
import { EMPTY_MENU_STATE } from '../domain/menuEdits.ts';
import { readAll } from './eventLog.ts';
import { Root } from './Root.tsx';

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/#recipes'); setMenuState(EMPTY_MENU_STATE); });
afterEach(() => { cleanup(); vi.useRealTimers(); setMenuState(EMPTY_MENU_STATE); });

const card = (name: string) => screen.getByText(name, { selector: '.rcard__name' }).closest('.rcard') as HTMLElement;

/** The recipes open for the owner as signed in: no PIN. */
const open = async (_user?: ReturnType<typeof userEvent.setup>) => {
  await screen.findByRole('heading', { name: /^(Recipes of the finished items|Semi-processed)$/ });
};
/** Items › another tab (the recipes are part of the items they make). */
const toTab = async (_user: ReturnType<typeof userEvent.setup>, hash: string) => {
  act(() => { location.hash = hash; window.dispatchEvent(new HashChangeEvent('hashchange')); });
  await open();
};

test('the recipes open for the owner as signed in, with no PIN, and each opening is recorded', async () => {
  render(<Root />);
  await open();
  expect(screen.queryByLabelText('Owner PIN')).toBeNull();
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
  // His cheese, sauce and basil answers (2026-10-23) complete it.
  expect(within(margherita).getByText(/^Complete · costs [\d,.]+ · earns \d+%$/)).toBeTruthy();
});

test('a gap shared by many recipes is asked once, at the top, and answering it moves them on', async () => {
  const user = userEvent.setup();
  render(<Root />);
  await open(user);
  const top = within(screen.getByRole('region', { name: 'First, these' }));
  // One at a time: ketchup, chicken cubes, mayonnaise, the sausage (his cheese, sauce and basil are answered).
  expect(top.getByRole('heading', { name: 'First, these · 4 to go' })).toBeTruthy();
  expect(top.getAllByRole('form').length).toBe(1);
  await user.click(top.getByRole('button', { name: 'Skip' }));
  expect(top.getAllByRole('form').length).toBe(1);
  while (!top.queryByRole('form', { name: /^Ketchup:/ })) await user.click(top.getByRole('button', { name: 'Skip' }));
  const ketchup = within(top.getByRole('form', { name: /^Ketchup:/ }));
  await user.type(ketchup.getByRole('textbox', { name: 'Rs' }), '450');
  await user.type(ketchup.getByRole('textbox', { name: 'for (g)' }), '400{Enter}');
  expect(readAll().at(-1)).toMatchObject({ question: 'ingredient:Ketchup', after: { kind: 'price', cents: 45000, qty: 400 }, actor: { role: 'owner' } });
  expect(within(card('Chicken Burger')).getByText('Waiting on Mayonnaise price')).toBeTruthy();
  expect(top.getByRole('heading', { name: 'First, these · 3 to go' })).toBeTruthy();
});

test('the owner adds a semi-processed item; it is offered in every recipe and can be deleted while unused', async () => {
  const user = userEvent.setup();
  history.replaceState(null, '', '/#items/semi');
  render(<Root />);
  // Semi-processed items are items, not recipes: no PIN to see them.
  expect(screen.queryByLabelText('Owner PIN')).toBeNull();
  expect(within(screen.getByRole('region', { name: 'Made in your kitchen' })).getByText('Pizza Sauce Batch')).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'New semi-processed item' }));
  const form = within(screen.getByRole('form', { name: 'New semi-processed item' }));
  expect(document.activeElement).toBe(form.getByRole('textbox', { name: 'Name' }));
  await user.type(form.getByRole('textbox', { name: 'Name' }), 'Pizza Sauce Batch');
  await user.type(form.getByRole('textbox', { name: 'One batch makes' }), '1000');
  await user.selectOptions(form.getByRole('combobox', { name: 'Line 1: what goes in' }), 'Sugar');
  await user.type(form.getByRole('textbox', { name: 'Line 1: how much' }), '1000');
  await user.click(form.getByRole('button', { name: 'Save' }));
  expect(form.getByRole('alert').textContent).toBe('Your recipe book already has that name.');

  await user.clear(form.getByRole('textbox', { name: 'Name' }));
  await user.type(form.getByRole('textbox', { name: 'Name' }), 'Syrup');
  expect(form.getByText(/^One batch costs [\d,.]+ · [\d,.]+ per 100 g$/)).toBeTruthy();
  await user.click(form.getByRole('button', { name: 'Save' }));
  const saved = readAll().at(-1) as unknown as { question: string };
  expect(saved).toMatchObject({
    type: 'recipe.answer_set', question: expect.stringMatching(/^prep:k[a-z0-9]+$/), before: null, actor: { role: 'owner' },
    after: { kind: 'prep', name: 'Syrup', makes: { qty: 1000, unit: 'g' }, lines: [{ name: 'stock:inv-0003', qty: 1000, unit: 'g' }] },
  });
  expect(within(card('Syrup')).getByText(/^Makes 1,000 g · costs [\d,.]+ a batch$/)).toBeTruthy();

  // Offered in a dish's recipe, under what his kitchen makes, by its id.
  await toTab(user, '#items/recipe');
  await user.click(within(card('Sausages Medium')).getByRole('button', { name: 'Write it' }));
  const dish = within(screen.getByRole('form', { name: 'Sausages Medium: recipe' }));
  await user.selectOptions(dish.getByRole('combobox', { name: 'Line 1: what goes in' }), 'Syrup');
  expect((dish.getByRole('combobox', { name: 'Line 1: what goes in' }) as HTMLSelectElement).value).toBe(`kitchen:${saved.question.slice(5)}`);
  expect(dish.getByText('g', { selector: '.redit__unit' })).toBeTruthy();
  await user.click(dish.getByRole('button', { name: 'Cancel' }));

  await toTab(user, '#items/semi');
  await user.click(within(card('Syrup')).getByRole('button', { name: /Syrup/ }));
  await user.click(within(card('Syrup')).getByRole('button', { name: 'Delete' }));
  expect(readAll().at(-1)).toMatchObject({ question: saved.question, after: null });
  expect(screen.queryByText('Syrup', { selector: '.rcard__name' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Undo' }));
  expect(card('Syrup')).toBeTruthy();
});

test('a name his recipes use but nothing makes is offered first; saving it completes those dishes', async () => {
  const user = userEvent.setup();
  history.replaceState(null, '', '/#items/semi');
  render(<Root />);
  await user.click(screen.getByRole('button', { name: 'New semi-processed item' }));
  const form = within(screen.getByRole('form', { name: 'New semi-processed item' }));
  await user.click(form.getByRole('button', { name: 'Fried Chicken Cubes · 6 dishes' }));
  expect((form.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Fried Chicken Cubes');
  expect(form.getByText(/^Your recipes already use Fried Chicken Cubes/)).toBeTruthy();
  await user.type(form.getByRole('textbox', { name: 'One batch makes' }), '800');
  await user.selectOptions(form.getByRole('combobox', { name: 'Line 1: what goes in' }), 'Chicken');
  await user.type(form.getByRole('textbox', { name: 'Line 1: how much' }), '1000');
  await user.click(form.getByRole('button', { name: 'Save' }));
  expect(readAll().at(-1)).toMatchObject({ after: { kind: 'prep', name: 'Fried Chicken Cubes', makes: { qty: 800, unit: 'g' } } });
  await user.click(within(card('Fried Chicken Cubes')).getByRole('button', { name: /Fried Chicken Cubes/ }));
  expect(within(card('Fried Chicken Cubes')).getByText('Added here · in 6 recipes')).toBeTruthy();
  expect(within(card('Fried Chicken Cubes')).queryByRole('button', { name: 'Delete' })).toBeNull();
  await toTab(user, '#items/recipe');
  expect(card('BBQ Chicken Medium').querySelector('.rcard__status')!.textContent).not.toMatch(/Fried Chicken Cubes/);
});
