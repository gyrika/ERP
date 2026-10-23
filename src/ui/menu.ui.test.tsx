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
  // One switch: on (green, "Available") means it can be sold.
  const sw = row.getByRole('switch', { name: 'Available today: BBQ Chicken' });
  expect([sw.getAttribute('aria-checked'), sw.textContent]).toEqual(['true', 'Available']);
  await user.click(sw);
  expect([sw.getAttribute('aria-checked'), sw.textContent]).toEqual(['false', 'Sold out today']);
  expect(row.getByText('Sold out')).toBeTruthy(); // the dish's own tag, readable from across the room
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

const rowOf = (name: string) => screen.getByText(name, { selector: 'b' }).closest('li')!;

test('the owner adds a pasta and writes its recipe later: names stay unique, every size needs a price, the counter offers it at once', async () => {
  const user = userEvent.setup();
  history.replaceState(null, '', '/#menu');
  render(<Root />);
  await user.click(await screen.findByRole('button', { name: 'Pasta' }));
  await user.click(screen.getByRole('button', { name: '+ Add a pasta' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Add a pasta' }));
  expect(sheet.getByRole('list', { name: 'Steps' }).textContent).toBe('NameWhat goes in itPrice');
  await user.type(sheet.getByLabelText('English'), 'Italian Pasta');
  await user.click(sheet.getByRole('button', { name: 'Next' }));
  expect(sheet.getByRole('alert').textContent).toContain('Italian Pasta is already on the menu');

  await user.clear(sheet.getByLabelText('English'));
  await user.type(sheet.getByLabelText('English'), 'Chicken Alfredo{Enter}');
  // The recipe opens for him with no PIN; Later skips it.
  expect(sheet.queryByLabelText('Owner PIN')).toBeNull();
  await user.click(sheet.getByRole('button', { name: 'Later' }));
  expect(sheet.getByText(/No recipe yet: until you write it, its sales don't take stock/)).toBeTruthy();
  await user.type(sheet.getByLabelText('Single price'), '1100');
  await user.type(sheet.getByLabelText('Medium price'), '2100');
  await user.click(sheet.getByRole('button', { name: 'Add to the menu' }));
  expect(sheet.getByRole('alert').textContent).toContain('Type a price for Large');
  await user.type(sheet.getByLabelText('Large price'), '2900');
  await user.click(sheet.getByRole('button', { name: 'Add to the menu' }));

  expect(screen.getByRole('status').textContent).toContain("Chicken Alfredo is on the counter · no recipe yet, so its sales don't take stock");
  expect(screen.getByText('S 1,100 · M 2,100 · L 2,900')).toBeTruthy();
  expect(rowOf('Chicken Alfredo').textContent).toContain("No recipe yet: its sales don't take stock.");
  expect(readAll().find((x) => x.type === 'menu.item_added')).toMatchObject({
    itemId: 'new-chicken-alfredo',
    item: { category: 'pasta', name: { en: 'Chicken Alfredo' }, description: '', prices: { S: 110000, M: 210000, L: 290000 } },
  });
  expect(readAll().some((x) => x.type === 'recipe.answer_set')).toBe(false);

  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('button', { name: 'Pasta' }));
  const card = within(screen.getByText('Chicken Alfredo').closest('.card') as HTMLElement);
  expect(card.getByRole('button', { name: 'from 1100' })).toBeTruthy();
});

test('a dish in one flow: name, what goes in it (from a similar dish, no PIN), then the price with its margin; one Undo takes it all back', async () => {
  const user = userEvent.setup();
  history.replaceState(null, '', '/#menu');
  render(<Root />);
  await user.click(await screen.findByRole('button', { name: '+ Add a pizza' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Add a pizza' }));
  await user.type(sheet.getByLabelText('English'), 'BBQ Prawn{Enter}');
  expect(sheet.getByRole('heading', { name: 'BBQ Prawn' })).toBeTruthy();

  expect(sheet.queryByLabelText('Owner PIN')).toBeNull(); // the recipe is open to him as he is signed in

  // The dishes most like it come first ("BBQ" in the name); one tap fills both sizes.
  const starts = within(sheet.getByRole('group', { name: 'Start from' }));
  expect(starts.getAllByRole('button')[0].textContent).toMatch(/^BBQ /);
  await user.click(starts.getAllByRole('button')[0]);
  expect((sheet.getByRole('combobox', { name: 'Line 1: what goes in' }) as HTMLSelectElement).value).toBe('10inch Dough Ball');
  // Each line says quietly where it comes from: his kitchen, or a supplier, with what it costs.
  const sources = [...document.querySelectorAll('.redit__src')].map((e) => e.textContent);
  expect(sources[0]).toMatch(/^Made in your kitchen/);
  expect(sources.some((t) => /^[A-Z][\w /&'-]+ · (Rs [\d,.]+|no price yet)$/.test(t ?? '') && !t!.startsWith('Made'))).toBe(true);
  await user.click(sheet.getByRole('button', { name: 'Large' }));
  expect((sheet.getByRole('combobox', { name: 'Line 1: what goes in' }) as HTMLSelectElement).value).toBe('12inch Dough Ball');
  await user.click(sheet.getByRole('button', { name: 'Next' }));

  await user.type(sheet.getByLabelText('Medium price'), '2300');
  await user.type(sheet.getByLabelText('Large price'), '3300');
  expect(sheet.getAllByText(/^Costs Rs [\d,.]+/).length).toBe(2);
  expect(readAll().some((x) => x.type === 'menu.item_added')).toBe(false); // nothing saved before the last step
  await user.click(sheet.getByRole('button', { name: 'Add to the menu' }));

  expect(screen.getByRole('status').textContent).toMatch(/^BBQ Prawn is on the counter · M (earns \d+%|costs Rs [\d,.]+ so far) · L /);
  const events = readAll();
  expect(events.find((x) => x.type === 'menu.item_added')).toMatchObject({ itemId: 'new-bbq-prawn' });
  for (const size of ['M', 'L']) {
    expect(events.find((x) => x.type === 'recipe.answer_set' && x.question === `recipe:new-bbq-prawn:${size}`))
      .toMatchObject({ before: null, after: { kind: 'own' }, actor: { role: 'owner' } });
  }
  expect(rowOf('BBQ Prawn').textContent).not.toContain('No recipe yet');

  await user.click(screen.getByRole('button', { name: 'Undo' }));
  expect(screen.queryByRole('button', { name: 'Change BBQ Prawn' })).toBeNull();
  expect(readAll().filter((x) => x.type === 'recipe.answer_set' && x.after === null).length).toBe(2);
});

test('a dish with no recipe: Write the recipe from its row, no PIN', async () => {
  const user = userEvent.setup();
  history.replaceState(null, '', '/#menu');
  render(<Root />);
  await screen.findByRole('heading', { name: 'Menu' });
  await user.click(within(rowOf('Sausages')).getByRole('button', { name: 'Write the recipe' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Sausages: recipe' }));
  expect(sheet.queryByLabelText('Owner PIN')).toBeNull();
  await user.click(within(sheet.getByRole('group', { name: 'Start from' })).getByRole('button', { name: 'BBQ Sausages' }));
  await user.click(sheet.getByRole('button', { name: 'Save recipe' }));
  expect(screen.getByRole('status').textContent).toMatch(/^Sausages: recipe saved · M /);
  expect(readAll().filter((x) => x.type === 'recipe.answer_set').map((x) => x.question)).toEqual(['recipe:sausages:M', 'recipe:sausages:L']);
  expect(rowOf('Sausages').textContent).not.toContain('No recipe yet');
});

test('the owner deletes a dish he added (a test, say); Undo brings it back; printed items only hide', async () => {
  const user = userEvent.setup();
  history.replaceState(null, '', '/#menu');
  render(<Root />);
  await user.click(await screen.findByRole('button', { name: '+ Add a pizza' }));
  const add = within(screen.getByRole('dialog', { name: 'Add a pizza' }));
  await user.type(add.getByLabelText('English'), 'Test Pizza{Enter}');
  await user.click(add.getByRole('button', { name: 'Later' }));
  await user.type(add.getByLabelText('Medium price'), '100');
  await user.type(add.getByLabelText('Large price'), '200');
  await user.click(add.getByRole('button', { name: 'Add to the menu' }));
  await user.click(screen.getByRole('button', { name: 'Change Test Pizza' }));
  await user.click(within(screen.getByRole('dialog', { name: 'Change Test Pizza' })).getByRole('button', { name: 'Delete' }));
  expect(screen.queryByRole('button', { name: 'Change Test Pizza' })).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('Deleted Test Pizza');
  await user.click(screen.getByRole('button', { name: 'Undo' }));
  await user.click(screen.getByRole('button', { name: 'Change Test Pizza' }));
  expect(within(screen.getByRole('dialog', { name: 'Change Test Pizza' })).getByLabelText('Large price')).toHaveProperty('value', '200');
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('button', { name: 'Change Margherita' }));
  expect(within(screen.getByRole('dialog')).queryByRole('button', { name: 'Delete' })).toBeNull();
});
