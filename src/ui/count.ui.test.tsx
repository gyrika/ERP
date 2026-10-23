import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { addEvents, readAll } from './eventLog.ts';
import { InventoryView } from './InventoryView.tsx';
import type { SyncEvent } from '../domain/sync.ts';

// Count day (SCRUM-89): blind count, units, reasons for a gap.

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const MOZZ = 'Mozzarella (Prabhat)'; // inv-0006, a 2 kg block
const actor = { id: 'm', name: 'Manager', role: 'manager' as const };
const counted = (itemId: string, at: number, base: number): SyncEvent =>
  ({ id: `c-${itemId}-${at}`, shopId: 'shop-demo-cheesybeez', at, orderNumber: 0, actor, type: 'stock.counted', itemId, counted: base, expected: 0, entries: [], reason: null, valueCents: 0, tier: 'daily' });

const openCount = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.click(screen.getByRole('button', { name }));
  await user.click(screen.getByRole('tab', { name: 'Count' }));
  return within(screen.getByRole('form', { name: `Count ${name}` }));
};

test("today's count lists what is due; a first count sets the starting amount", async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  const count = screen.getByRole('button', { name: /^Count \(\d+ due\)$/ });
  expect(count.textContent).toMatch(/\d+ due today/);
  await user.click(count);

  const form = within(screen.getByRole('form', { name: /^Count / }));
  expect(form.getByText(/1 of \d+ · \w+ · first count/)).toBeTruthy();
  await user.type(form.getByRole('textbox', { name: 'Full packs' }), '2');
  await user.click(form.getByRole('button', { name: '½' }));
  expect(form.getByText(/^= /)).toBeTruthy();
  await user.click(form.getByRole('button', { name: 'Next' }));

  expect(readAll().at(-1)).toMatchObject({ type: 'stock.counted', reason: null, entries: [{ unit: 'pack', qty: 2 }, { unit: 'pack', qty: 0.5 }] });
  expect(screen.getByRole('status').textContent).toMatch(/matches\.Undo/);
  expect(screen.getByText(/^2 of \d+/)).toBeTruthy();
});

test('blind count: no expected amount before counting; a big gap asks why and saves the reason', async () => {
  // No sales yet, so mozzarella is a monthly item: last counted 40 days ago, it is due.
  addEvents([counted('inv-0006', Date.now() - 40 * 24 * 3600_000, 6000)]);
  const user = userEvent.setup();
  render(<InventoryView />);
  const mozz = screen.getByRole('heading', { name: MOZZ }).closest('article')!;
  expect(within(mozz).getByText(/^Count due/)).toBeTruthy(); // the shelf amount is hidden while due

  const form = await openCount(user, MOZZ);
  expect(screen.queryByText(/6 kg/)).toBeNull();
  await user.type(form.getByRole('textbox', { name: 'Full packs' }), '2');
  await user.type(form.getByRole('textbox', { name: 'Opened pack, weighed' }), '1.3');
  await user.click(form.getByRole('button', { name: 'kg' }));
  expect(form.getByText('= 5.3 kg')).toBeTruthy();
  await user.click(form.getByRole('button', { name: 'Next' }));

  expect(screen.getByText(/^700 g short · Rs [\d,]+/)).toBeTruthy(); // 11.7%: over the 10% allowance
  expect(screen.getByText(/You counted 5.3 kg; sales and deliveries say 6 kg/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Spoiled or expired' }));
  expect(readAll().at(-1)).toMatchObject({ type: 'stock.counted', itemId: 'inv-0006', counted: 5300, expected: 6000, reason: 'spoiled' });

  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(within(mozz).getByText('2¾ packs · 5.3 kg')).toBeTruthy();
});

test('Other needs a note saying what happened; the reason and note go on the count', async () => {
  addEvents([counted('inv-0006', Date.now() - 40 * 24 * 3600_000, 6000)]);
  const user = userEvent.setup();
  render(<InventoryView />);
  const form = await openCount(user, MOZZ);
  await user.type(form.getByRole('textbox', { name: 'Full packs' }), '2');
  await user.click(form.getByRole('button', { name: 'Next' })); // 4 kg of 6 kg: a third short

  const why = within(screen.getByRole('group', { name: 'Why' }));
  expect(why.getAllByRole('button').map((b) => b.textContent)).toEqual(['Spoiled or expired', 'Dropped or spilled', 'Wrong entry', 'Other']);
  await user.click(why.getByRole('button', { name: 'Other' }));
  const save = screen.getByRole('button', { name: 'Save' });
  expect(save).toHaveProperty('disabled', true); // nothing is saved until it says what happened
  expect(readAll().at(-1)).toMatchObject({ type: 'stock.counted', reason: null });
  await user.type(screen.getByRole('textbox', { name: 'What happened' }), '  The walk-in fridge was off overnight  ');
  await user.click(save);
  expect(readAll().at(-1)).toMatchObject({ type: 'stock.counted', counted: 4000, expected: 6000, reason: 'other', note: 'The walk-in fridge was off overnight' });
});

test('a gap under both allowances (10% and Rs 2,000) is not asked about', async () => {
  addEvents([counted('inv-0006', Date.now() - 40 * 24 * 3600_000, 6000)]);
  const user = userEvent.setup();
  render(<InventoryView />);
  const form = await openCount(user, MOZZ);
  await user.type(form.getByRole('textbox', { name: 'Full packs' }), '2');
  await user.type(form.getByRole('textbox', { name: 'Opened pack, weighed' }), '1.9');
  await user.click(form.getByRole('button', { name: 'kg' }));
  await user.click(form.getByRole('button', { name: 'Next' })); // 5.9 kg of 6 kg: under 2%
  expect(screen.queryByRole('group', { name: 'Why' })).toBeNull();
  expect(readAll().at(-1)).toMatchObject({ type: 'stock.counted', counted: 5900, reason: null });
});

test('a small gap matches with no question; Undo takes the count back', async () => {
  addEvents([counted('inv-0006', Date.now() - 2 * 24 * 3600_000, 6000)]);
  const user = userEvent.setup();
  render(<InventoryView />);
  const form = await openCount(user, MOZZ);
  await user.type(form.getByRole('textbox', { name: 'Opened pack, weighed' }), '5990');
  await user.click(form.getByRole('button', { name: 'Next' }));
  expect(readAll().at(-1)).toMatchObject({ type: 'stock.counted', counted: 5990, reason: null });
  await user.click(screen.getByRole('button', { name: 'Undo' }));
  expect(readAll().at(-1)).toMatchObject({ type: 'stock.count_undone' });
  expect(screen.getByRole('form', { name: `Count ${MOZZ}` })).toBeTruthy(); // back on the item
});

test('another unit is learned once for the item and counted in', async () => {
  const user = userEvent.setup();
  render(<InventoryView />);
  const form = await openCount(user, MOZZ);
  await user.click(form.getByRole('button', { name: 'Other unit…' }));
  await user.type(form.getByRole('textbox', { name: 'Unit name' }), 'Slab');
  await user.type(form.getByRole('textbox', { name: /One Slab holds/ }), '500');
  await user.click(form.getByRole('button', { name: 'Save unit' }));
  expect(readAll().at(-1)).toMatchObject({ type: 'stock.unit_set', itemId: 'inv-0006', name: 'Slab', base: 500 });
  const again = within(screen.getByRole('form', { name: `Count ${MOZZ}` }));
  expect(again.getByRole('button', { name: 'Slab · 500 g' }).getAttribute('aria-pressed')).toBe('true');
  await user.type(again.getByRole('textbox', { name: 'Full packs' }), '3');
  expect(again.getByText(/= 1.5 kg/)).toBeTruthy();
});
