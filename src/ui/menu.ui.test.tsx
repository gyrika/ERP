import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setMenuState } from '../domain/menu.ts';
import { EMPTY_MENU_STATE } from '../domain/menuEdits.ts';
import { readAll } from './eventLog.ts';
import { Root } from './Root.tsx';

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/'); setMenuState(EMPTY_MENU_STATE); });
afterEach(() => { cleanup(); setMenuState(EMPTY_MENU_STATE); });

const panel = () => within(screen.getByRole('complementary', { name: 'Current order' }));

test("the owner changes a price and a name: the counter shows it at once; an order already sent keeps its price", async () => {
  const user = userEvent.setup();
  render(<Root />);
  // An order sent at the printed price (Margherita M 1450).
  await user.click(screen.getAllByRole('button', { name: 'M 1450' })[0]);
  await user.click(panel().getByRole('button', { name: 'Send to kitchen' }));

  history.replaceState(null, '', '/#menu');
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  await user.click(await screen.findByRole('button', { name: 'Change Margherita' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Change Margherita' }));
  await user.clear(sheet.getByLabelText('Medium price'));
  await user.type(sheet.getByLabelText('Medium price'), '1600');
  expect(sheet.getByText('Printed 1,450')).toBeTruthy();
  await user.type(sheet.getByLabelText('Sinhala'), 'මාගරීටා');
  await user.click(sheet.getByRole('button', { name: 'Save' }));
  expect(screen.getByRole('status').textContent).toContain('Saved Margherita');
  expect(screen.getByText('M 1,600 · L 1,990')).toBeTruthy();

  const e = readAll().find((x) => x.type === 'menu.item_set')!;
  expect(e).toMatchObject({ itemId: 'margherita', before: {}, after: { prices: { M: 160000 }, name: { si: 'මාගරීටා' } } });

  await user.keyboard('{Escape}');
  expect(screen.getAllByRole('button', { name: 'M 1600' }).length).toBeGreaterThan(0);
  expect(within(panel().getByRole('region', { name: 'Waiting to pay' })).getByRole('button', { name: /^1001/ }).textContent).toContain('1,450');
});

test('sold out for today: greyed on the counter, cannot be added; Undo brings it back', async () => {
  const user = userEvent.setup();
  history.replaceState(null, '', '/#menu');
  render(<Root />);
  const row = within((await screen.findByRole('button', { name: 'Change BBQ Chicken' })).closest('li')!);
  await user.click(row.getByRole('button', { name: 'Available' }));
  expect(row.getByRole('button', { name: 'Sold out today' })).toBeTruthy();
  await user.keyboard('{Escape}');
  const card = screen.getByText('BBQ Chicken').closest('.card')!;
  expect(within(card as HTMLElement).getByText('Sold out')).toBeTruthy();
  expect((within(card as HTMLElement).getByRole('button', { name: 'L 2500' }) as HTMLButtonElement).disabled).toBe(true);
});

test('hidden items leave the counter; back to the printed menu in one tap', async () => {
  const user = userEvent.setup();
  history.replaceState(null, '', '/#menu');
  render(<Root />);
  await user.click(await screen.findByRole('button', { name: 'Change Seafood' }));
  await user.click(screen.getByRole('checkbox', { name: /Hide from the menu/ }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByText('Hidden')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Change Seafood' }));
  await user.click(screen.getByRole('button', { name: 'Back to the printed menu' }));
  expect(screen.queryByText('Hidden')).toBeNull();
  expect(screen.queryByText('Changed')).toBeNull();
});

test('the owner adds a pasta: names stay unique, every size needs a price, and the counter offers it at once', async () => {
  const user = userEvent.setup();
  history.replaceState(null, '', '/#menu');
  render(<Root />);
  await user.click(await screen.findByRole('button', { name: 'Pasta' }));
  await user.click(screen.getByRole('button', { name: '+ Add a pasta' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Add a pasta' }));
  await user.type(sheet.getByLabelText('English'), 'Italian Pasta');
  await user.type(sheet.getByLabelText('Single price'), '1100');
  await user.type(sheet.getByLabelText('Medium price'), '2100');
  await user.click(sheet.getByRole('button', { name: 'Add to the menu' }));
  expect(sheet.getByRole('alert').textContent).toContain('Italian Pasta is already on the menu');

  await user.clear(sheet.getByLabelText('English'));
  await user.type(sheet.getByLabelText('English'), 'Chicken Alfredo');
  await user.click(sheet.getByRole('button', { name: 'Add to the menu' }));
  expect(sheet.getByRole('alert').textContent).toContain('Type a price for Large');
  await user.type(sheet.getByLabelText('Large price'), '2900');
  await user.click(sheet.getByRole('button', { name: 'Add to the menu' }));

  expect(screen.getByRole('status').textContent).toContain('Added Chicken Alfredo');
  expect(screen.getByText('S 1,100 · M 2,100 · L 2,900')).toBeTruthy();
  expect(readAll().find((x) => x.type === 'menu.item_added')).toMatchObject({
    itemId: 'new-chicken-alfredo',
    item: { category: 'pasta', name: { en: 'Chicken Alfredo' }, description: '', prices: { S: 110000, M: 210000, L: 290000 } },
  });

  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('button', { name: 'Pasta' }));
  const card = within(screen.getByText('Chicken Alfredo').closest('.card') as HTMLElement);
  expect(card.getByRole('button', { name: 'from 1100' })).toBeTruthy();

  history.replaceState(null, '', '/#menu');
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  await screen.findByRole('heading', { name: 'Menu' });
  await user.click(screen.getByRole('button', { name: 'Pasta' }));
  expect(screen.getByRole('button', { name: 'Change Chicken Alfredo' })).toBeTruthy();
});

test('Undo right after adding takes the new item off the menu', async () => {
  const user = userEvent.setup();
  history.replaceState(null, '', '/#menu');
  render(<Root />);
  await user.click(await screen.findByRole('button', { name: '+ Add a pizza' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Add a pizza' }));
  await user.type(sheet.getByLabelText('English'), 'Hot Butter Cuttlefish');
  await user.type(sheet.getByLabelText('Medium price'), '2300');
  await user.type(sheet.getByLabelText('Large price'), '3300');
  await user.click(sheet.getByRole('button', { name: 'Add to the menu' }));
  expect(screen.getByRole('button', { name: 'Change Hot Butter Cuttlefish' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Undo' }));
  expect(screen.queryByRole('button', { name: 'Change Hot Butter Cuttlefish' })).toBeNull();
});
