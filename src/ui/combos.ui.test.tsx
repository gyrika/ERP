import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setMenuState } from '../domain/menu.ts';
import { EMPTY_MENU_STATE } from '../domain/menuEdits.ts';
import type { Combo } from '../domain/types.ts';
import { currentCashier } from '../services/auth.ts';
import { appendEvent, readAll } from './eventLog.ts';
import { Root } from './Root.tsx';

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/'); setMenuState(EMPTY_MENU_STATE); });
afterEach(() => { cleanup(); setMenuState(EMPTY_MENU_STATE); });

const panel = () => within(screen.getByRole('complementary', { name: 'Current order' }));

const FAMILY: Combo = {
  name: { en: 'Family Box' },
  price: 360000,
  slots: [
    { qty: 1, size: 'L', usual: 'devilled-chicken', options: { 'devilled-chicken': 0, margherita: 0, seafood: 50000 } },
    { qty: 2, usual: 'chicken-burger', options: { 'chicken-burger': 0, 'fish-burger': 0 } },
    { qty: 1, size: 'S', usual: 'italian-pasta', options: { 'italian-pasta': 0 } },
  ],
};

const addFamilyBox = () =>
  appendEvent({ type: 'menu.combo_set', at: Date.now(), orderNumber: 0, actor: currentCashier(), itemId: 'combo-family-box', before: null, after: FAMILY });

test('one tap sells a whole combo with its usual picks; it goes to the kitchen as dishes', async () => {
  const user = userEvent.setup();
  addFamilyBox();
  render(<Root />);
  await user.click(screen.getByRole('button', { name: 'Combos' }));
  await user.click(screen.getByRole('button', { name: 'Add Family Box, 3600' }));

  const box = within(panel().getByRole('region', { name: 'Family Box' }));
  expect(box.getByText('Devilled Chicken')).toBeTruthy();
  expect(box.getAllByText('Chicken Burger')).toHaveLength(2);
  expect(box.getByText('Italian Pasta')).toBeTruthy();
  expect(box.getByText('Saves Rs 799 on separate prices')).toBeTruthy();
  expect(panel().getByText('3,600', { selector: '.total' })).toBeTruthy();

  // Send works straight away: nothing to pick first.
  await user.click(panel().getByRole('button', { name: 'Send to kitchen' }));
  const sent = readAll().find((e) => e.type === 'order.sent') as { lines: { itemId: string; box?: { name: string; share: number } }[] };
  expect(sent.lines.map((l) => l.itemId)).toEqual(['devilled-chicken', 'chicken-burger', 'chicken-burger', 'italian-pasta']);
  expect(sent.lines.every((l) => l.box?.name === 'Family Box')).toBe(true);
  expect(sent.lines.reduce((s, l) => s + l.box!.share, 0)).toBe(360000);
});

test('a dish in the box changes pick in its own sheet; the dearer pick adds its extra; Remove takes the whole box', async () => {
  const user = userEvent.setup();
  addFamilyBox();
  render(<Root />);
  await user.click(screen.getByRole('button', { name: 'Combos' }));
  await user.click(screen.getByRole('button', { name: 'Add Family Box, 3600' }));
  await user.click(within(panel().getByRole('region', { name: 'Family Box' })).getByText('Devilled Chicken'));

  const sheet = within(screen.getByRole('dialog'));
  expect(sheet.queryByRole('button', { name: 'Increase quantity' })).toBeNull();
  await user.click(sheet.getByRole('button', { name: 'Seafood · +500' }));
  await user.click(sheet.getByRole('button', { name: /^Update/ }));
  const box = within(panel().getByRole('region', { name: 'Family Box' }));
  expect(box.getByText('Seafood')).toBeTruthy();
  expect(box.getByText('+500')).toBeTruthy();
  expect(panel().getByText('4,100', { selector: '.total' })).toBeTruthy();

  await user.click(box.getByText('Seafood'));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove the box' }));
  expect(panel().queryByRole('region', { name: 'Family Box' })).toBeNull();
});

test('a manager or the owner builds a combo on Items › Finished; it is one audited event with Undo', async () => {
  const user = userEvent.setup();
  history.replaceState(null, '', '/#menu');
  render(<Root />);
  await user.click(await screen.findByRole('button', { name: 'Combos' }));
  await user.click(screen.getByRole('button', { name: '+ Add a combo' }));
  const sheet = within(screen.getByRole('dialog', { name: 'New combo' }));
  await user.type(sheet.getByLabelText('Name'), 'Lunch One');
  await user.click(sheet.getByRole('button', { name: '+ Burger' }));
  await user.click(sheet.getByRole('button', { name: '+ Pasta' }));
  await user.click(within(sheet.getByRole('group', { name: 'Size' })).getByRole('button', { name: 'Single' }));
  await user.type(sheet.getByLabelText('Box price'), '1300');
  expect(sheet.getByText('The customer saves Rs 149 on the usual box.')).toBeTruthy();
  await user.click(sheet.getByRole('button', { name: 'Put on the menu' }));

  const e = readAll().find((x) => x.type === 'menu.combo_set') as unknown as { itemId: string; before: null; after: Combo };
  expect(e.itemId).toBe('combo-lunch-one');
  expect(e.before).toBeNull();
  expect(e.after).toEqual({
    name: { en: 'Lunch One' }, price: 130000,
    slots: [
      { qty: 1, usual: 'chicken-burger', options: { 'chicken-burger': 0 } },
      { qty: 1, size: 'S', usual: 'italian-pasta', options: { 'italian-pasta': 0 } },
    ],
  });
  expect(screen.getByRole('status').textContent).toContain('Saved Lunch One');
  expect(screen.getByText('Lunch One')).toBeTruthy();
});
