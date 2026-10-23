import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { menuCost, questionKind, type Answer } from '../domain/costing.ts';
import { SEED_INVENTORY } from '../domain/inventoryData.ts';
import { setMenuState } from '../domain/menu.ts';
import { EMPTY_MENU_STATE } from '../domain/menuEdits.ts';
import { answerQuestion } from '../services/inventoryStore.ts';
import { Root } from './Root.tsx';

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/#menu'); setMenuState(EMPTY_MENU_STATE); });
afterEach(() => { cleanup(); setMenuState(EMPTY_MENU_STATE); });

const row = (name: string) => screen.getByText(name, { selector: 'b' }).closest('li')!;

test('each item shows its cost so far; one with no recipe says its sales take no stock (SCRUM-129)', () => {
  render(<Root />);
  expect(row('Margherita').textContent).toMatch(/Cost so far M \d+ · L \d+ · 3 to answer in Recipes/);
  expect(row('Sausages').textContent).toContain("No recipe yet: its sales don't take stock.");
  expect(within(row('Sausages')).getByRole('button', { name: 'Write the recipe' })).toBeTruthy();
  expect(within(row('Margherita')).queryByRole('button', { name: 'Write the recipe' })).toBeNull();
  // The recipe questions live in one place now: the Recipes screen.
  expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull();
});

test('when every gap of a pizza is answered it shows its cost and margin', () => {
  const ctx = { items: SEED_INVENTORY, answers: new Map<string, Answer>() };
  for (const q of new Set([...menuCost('margherita', 'M', ctx).missing, ...menuCost('margherita', 'L', ctx).missing])) {
    answerQuestion(q, questionKind(q) === 'yield' ? { kind: 'yield', qty: 2000 } : { kind: 'price', cents: 20000, qty: 100 }, null);
  }
  render(<Root />);
  expect(row('Margherita').textContent).toMatch(/Cost M \d+ \d+% · L \d+ \d+%/);
  expect(row('Margherita').textContent).not.toContain('to answer');
});
