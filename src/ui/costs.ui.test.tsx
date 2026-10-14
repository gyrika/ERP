import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setMenuState } from '../domain/menu.ts';
import { EMPTY_MENU_STATE } from '../domain/menuEdits.ts';
import { readAll } from './eventLog.ts';
import { Root } from './Root.tsx';

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/#menu'); setMenuState(EMPTY_MENU_STATE); });
afterEach(() => { cleanup(); setMenuState(EMPTY_MENU_STATE); });

const row = (name: string) => screen.getByText(name, { selector: 'b' }).closest('li')!;

test('each item shows its cost so far, and the owner is asked only what his sheets leave open', async () => {
  render(<Root />);
  expect(row('Margherita').textContent).toMatch(/Cost so far M \d+ · L \d+ · 3 answers to go/);
  expect(row('Sausages').textContent).toContain('Cost: which of your recipes is it? (2 answers to go)');
  expect(screen.getByText(/Costs: 25 answers to go\./)).toBeTruthy();
});

test('an answer is saved at once as an audited event, completes what it can, and Undo takes it back', async () => {
  const user = userEvent.setup();
  render(<Root />);
  await user.click(screen.getByRole('button', { name: 'Answer' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Costs: answer the gaps' }));
  expect(sheet.getByText('25 questions left')).toBeTruthy();
  expect(sheet.getByRole('heading', { name: 'Mozzarella Blend: how much does one batch make?' })).toBeTruthy();
  expect(sheet.getByText(/1,000 g Mozzarella A, 1,000 g Mozzarella B/)).toBeTruthy();

  await user.type(sheet.getByRole('textbox', { name: 'One batch makes (g)' }), '2000{Enter}');
  expect(sheet.getByRole('status').textContent).toContain('Mozzarella Blend makes 2,000 g a batch.');
  expect(sheet.getByText('24 questions left')).toBeTruthy();
  expect(readAll().at(-1)).toMatchObject({
    type: 'recipe.answer_set', question: 'yield:Mozzarella Blend', before: null, after: { kind: 'yield', qty: 2000 },
  });

  // The sauce, then basil (his cheeses A and B are already on his price list).
  await user.type(sheet.getByRole('textbox', { name: 'One batch makes (g)' }), '3600{Enter}');
  await user.type(sheet.getByRole('textbox', { name: 'Rs' }), '200');
  await user.type(sheet.getByRole('textbox', { name: 'for (g)' }), '100{Enter}');
  expect(sheet.getByText('22 questions left')).toBeTruthy();

  await user.click(sheet.getByRole('button', { name: 'Undo' }));
  expect(sheet.getByText('23 questions left')).toBeTruthy(); // basil asked again
  expect(sheet.getByRole('heading', { name: 'Basil: what does it cost?' })).toBeTruthy();
  expect(readAll().at(-1)).toMatchObject({ question: 'ingredient:Basil', after: null });
});

test('when every gap of a pizza is answered it shows its cost and margin', async () => {
  const user = userEvent.setup();
  render(<Root />);
  await user.click(screen.getByRole('button', { name: 'Answer' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Costs: answer the gaps' }));
  await user.type(sheet.getByRole('textbox', { name: 'One batch makes (g)' }), '2000{Enter}');
  await user.type(sheet.getByRole('textbox', { name: 'One batch makes (g)' }), '3600{Enter}');
  await user.type(sheet.getByRole('textbox', { name: 'Rs' }), '200');
  await user.type(sheet.getByRole('textbox', { name: 'for (g)' }), '100{Enter}');
  await user.click(sheet.getByRole('button', { name: 'Close' }));

  expect(row('Margherita').textContent).toMatch(/Cost M \d+ \d+% · L \d+ \d+%/);
  expect(row('Margherita').textContent).not.toContain('to go');
});
