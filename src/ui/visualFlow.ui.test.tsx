import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setMenuState } from '../domain/menu.ts';
import { EMPTY_MENU_STATE } from '../domain/menuEdits.ts';
import { readAll } from './eventLog.ts';
import { adjustStock } from '../services/inventoryStore.ts';
import { Root } from './Root.tsx';

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/#flow'); setMenuState(EMPTY_MENU_STATE); });
afterEach(() => { cleanup(); setMenuState(EMPTY_MENU_STATE); });

const panel = () => within(screen.getByRole('complementary', { name: 'Details' }));

test('the owner sees how a pizza is made, from flour through the dough to the pizza, and each opening is recorded', async () => {
  render(<Root />);
  expect(await screen.findByRole('main', { name: 'Visual Flow' })).toBeTruthy();
  expect(screen.getByRole('button', { name: /^Showing Margherita Large/ })).toBeTruthy();
  // The canvas draws its cards a moment after the page: wait for them (a slow runner is slower).
  for (const name of ['Pizza Dough Culture', 'Pizza Dough Batch', '12inch Dough Ball']) {
    expect(await screen.findByText(name, { selector: '.vf-node__name' }, { timeout: 5000 })).toBeTruthy();
  }
  expect(panel().getByRole('heading', { name: 'Margherita Large' })).toBeTruthy();
  expect(readAll().some((e) => e.type === 'recipe.viewed')).toBe(true);
});

test('a change is a draft with Undo; Publish makes it the recipe, a new version, and Undo takes it back', async () => {
  const user = userEvent.setup();
  render(<Root />);
  await screen.findByRole('main', { name: 'Visual Flow' });

  // Add basil to the pizza from the panel.
  await user.click(panel().getByRole('button', { name: 'Add an ingredient' }));
  await user.keyboard('Raw · Basil');
  await user.keyboard('{Enter}');
  expect(await screen.findByText('Basil goes into Margherita Large: type how much')).toBeTruthy();
  expect(readAll().at(-1)).toMatchObject({ type: 'recipe.draft_set', question: 'recipe:margherita:L', after: { kind: 'own' }, actor: { role: 'owner' } });
  // Nothing counts yet: no answer was written.
  expect(readAll().some((e) => e.type === 'recipe.answer_set')).toBe(false);

  // The new line is open in the panel: 10% of it is lost.
  const waste = panel().getByRole('textbox', { name: 'How much of Basil is lost' });
  await user.clear(waste);
  await user.type(waste, '10{Enter}');
  const last = readAll().at(-1) as { after: { lines: { name: string; waste?: number }[] } };
  expect(last.after.lines.find((l) => l.name === 'stock:inv-0060')?.waste).toBe(0.1);

  await user.click(screen.getByRole('button', { name: 'Publish 1 change' }));
  expect(await screen.findByText(/^Published 1 change/)).toBeTruthy();
  expect(readAll().at(-1)).toMatchObject({ type: 'recipe.answer_set', question: 'recipe:margherita:L', before: null, after: { kind: 'own' } });
  expect(screen.queryByRole('button', { name: /^Publish/ })).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Undo' }));
  const [back, reopened] = readAll().slice(-2);
  expect(back).toMatchObject({ type: 'recipe.answer_set', after: null });
  expect(reopened).toMatchObject({ type: 'recipe.draft_set', question: 'recipe:margherita:L' });
  expect(await screen.findByRole('button', { name: 'Publish 1 change' })).toBeTruthy();
});

test('three views of the same drawing: 2 for cost, 3 for what it earns', async () => {
  const user = userEvent.setup();
  render(<Root />);
  await screen.findByRole('main', { name: 'Visual Flow' });
  await user.keyboard('2');
  expect(screen.getByRole('button', { name: 'Cost' }).getAttribute('aria-pressed')).toBe('true');
  expect(panel().getByText('Costs to make')).toBeTruthy();
  expect(panel().getByText('Labour')).toBeTruthy();
  await user.keyboard('3');
  expect(panel().getByText('Profit each')).toBeTruthy();
  expect(await screen.findByText('Profit', { selector: '.vf-node__name' }, { timeout: 5000 })).toBeTruthy();
});

test('ordering a raw material from its card asks who from, at what price and how many packs, then fills that cart', async () => {
  const user = userEvent.setup();
  render(<Root />);
  await screen.findByRole('main', { name: 'Visual Flow' });
  // A plain click: a full mouse press starts React Flow's drag, which jsdom cannot run.
  fireEvent.click(await screen.findByText('Pizza Flour', { selector: '.vf-node__name' }, { timeout: 5000 }));
  await user.click(panel().getByRole('button', { name: 'Order from supplier' }));
  // Nothing is in a cart until Add to cart.
  expect(readAll().some((e) => e.type === 'stock.draft_set')).toBe(false);

  const order = within(panel().getByRole('region', { name: 'Order Pizza Flour' }));
  const packs = order.getByRole('textbox', { name: 'Packs of Pizza Flour' });
  await user.clear(packs);
  await user.type(packs, '3');
  await user.click(order.getByRole('button', { name: 'Add to cart' }));
  expect(readAll().at(-1)).toMatchObject({ type: 'stock.draft_set', lines: [expect.objectContaining({ itemId: 'inv-0001', packs: 3 })] });
  expect(order.getByRole('link', { name: 'Open cart' })).toBeTruthy();
});

test('Stock (4): each card shows what it holds in money, the dish what stands behind it, and a raw item opens its history', async () => {
  const user = userEvent.setup();
  adjustStock('inv-0001', 2); // two 25 kg bags of flour: Rs 12,800
  render(<Root />);
  await screen.findByRole('main', { name: 'Visual Flow' });
  await user.keyboard('4');
  expect(screen.getByRole('button', { name: 'Stock' }).getAttribute('aria-pressed')).toBe('true');
  const flour = (await screen.findByText('Pizza Flour', { selector: '.vf-node__name' }, { timeout: 5000 })).closest('.vf-node')!;
  expect(flour.querySelector('.vf-node__value')?.textContent).toBe('Rs 12,800 · 100%');
  expect(screen.getByText('Rs 12,800 behind it')).toBeTruthy();
  fireEvent.click(flour);
  expect(panel().getByText('Rs 256 a kg')).toBeTruthy();
  expect(panel().getAllByText('Rs 12,800').length).toBeGreaterThan(0);
  expect(panel().getByRole('link', { name: 'History' }).getAttribute('href')).toBe('#items/item/inv-0001');
});
