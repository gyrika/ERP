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

test('Warehouse view: each ingredient says where it is kept; picking one shows its split and sets its home (SCRUM-184)', async () => {
  const user = userEvent.setup();
  adjustStock('inv-0001', 2); // in Warehouse 1, its home
  render(<Root />);
  await screen.findByRole('main', { name: 'Visual Flow' });
  await user.keyboard('5');
  expect(screen.getByRole('button', { name: 'Warehouse' }).getAttribute('aria-pressed')).toBe('true');
  const flour = (await screen.findByText('Pizza Flour', { selector: '.vf-node__name' }, { timeout: 5000 })).closest('.vf-node')!;
  expect(flour.querySelector('.vf-node__value')?.textContent).toBe('Warehouse 1');
  expect(flour.querySelector('.vf-place')?.getAttribute('aria-label')).toBe('Warehouse 1 50 kg');
  fireEvent.click(flour);
  const key = within(screen.getByRole('complementary', { name: 'Warehouses' }));
  expect(key.getByText('Warehouse 1 50 kg')).toBeTruthy();
  await user.click(within(key.getByRole('group', { name: 'Where Pizza Flour is kept' })).getByRole('button', { name: 'Warehouse 2' }));
  expect(readAll().at(-1)).toMatchObject({ type: 'stock.home_set', stockKey: 'stock:inv-0001', after: 'wh-2' });
  expect(flour.querySelector('.vf-node__value')?.textContent).toBe('Warehouse 2');
});

test('one filter and one warehouse: Raw in Warehouse 1 dims every card that is not both; the dish in focus stays bright (SCRUM-187)', async () => {
  const user = userEvent.setup();
  adjustStock('inv-0001', 2); // Pizza Flour, kept in Warehouse 1
  render(<Root />);
  await screen.findByRole('main', { name: 'Visual Flow' });
  const flour = (await screen.findByText('Pizza Flour', { selector: '.vf-node__name' }, { timeout: 5000 })).closest('.vf-node')!;
  const culture = screen.getByText('Pizza Dough Culture', { selector: '.vf-node__name' }).closest('.vf-node')!;
  const show = within(screen.getByRole('group', { name: 'Show' }));
  const rooms = within(screen.getByRole('group', { name: 'Warehouse' }));
  await user.click(show.getByRole('button', { name: 'Raw' }));
  await user.click(rooms.getByRole('button', { name: 'Warehouse 1' }));
  expect(flour.className).not.toContain('vf-node--dim');
  expect(culture.className).toContain('vf-node--dim'); // semi-processed
  await user.click(show.getByRole('button', { name: 'Semi-processed' })); // one at a time: Semi instead of Raw
  expect(show.getByRole('button', { name: 'Raw' }).getAttribute('aria-pressed')).toBe('false');
  expect(flour.className).toContain('vf-node--dim');
  await user.click(show.getByRole('button', { name: 'All' }));
  await user.click(rooms.getByRole('button', { name: 'Warehouse 2' })); // one at a time
  expect(rooms.getByRole('button', { name: 'Warehouse 1' }).getAttribute('aria-pressed')).toBe('false');
  expect(flour.className).toContain('vf-node--dim'); // not kept there
  expect(document.querySelector('.vf-node--focus')!.className).not.toContain('vf-node--dim');
  await user.click(rooms.getByRole('button', { name: 'Warehouse 2' })); // off again
  expect(flour.className).not.toContain('vf-node--dim');
});

test('the drawing says its point first, folds the small inputs into one card, and a tapped card lights its path', async () => {
  render(<Root />);
  await screen.findByRole('main', { name: 'Visual Flow' });
  expect(await screen.findByText(/^Mozzarella Blend is \d+% of what a Margherita Large costs \(Rs [\d,]+ of Rs [\d,]+\)\.$/, { selector: '.sr-only' })).toBeTruthy();
  // No labels on the lines: the amounts are on the cards.
  expect(document.querySelector('.react-flow__edgelabel-renderer button')).toBeNull();

  const small = (await screen.findByText(/^\+\d+ small items$/, { selector: '.vf-node__name' }, { timeout: 5000 })).closest('.vf-node')!;
  expect(screen.queryByText('Instant yeast', { selector: '.vf-node__name' })).toBeNull();
  fireEvent.click(small);
  await userEvent.setup().click(within(panel().getByRole('list', { name: 'Small items' })).getByRole('button', { name: /Instant yeast/ }));
  expect(panel().getByRole('heading', { name: 'Instant yeast' })).toBeTruthy();

  // Tapping the flour lights the dough's path; the cheese steps back.
  fireEvent.click(screen.getByText('Pizza Flour', { selector: '.vf-node__name' }));
  const card = (name: string) => screen.getByText(name, { selector: '.vf-node__name' }).closest('.vf-node')!;
  expect(card('Pizza Dough Batch').className).not.toContain('vf-node--faded');
  expect(card('Margherita Large').className).not.toContain('vf-node--faded');
  expect(card('Mozzarella Blend').className).toContain('vf-node--faded');
});
