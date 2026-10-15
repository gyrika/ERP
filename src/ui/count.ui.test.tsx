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
  const bar = within(screen.getByRole('region', { name: "Today's count" }));
  expect(bar.getByText(/^Today's count · \d+ items$/)).toBeTruthy();
  await user.click(bar.getByRole('button', { name: 'Start' }));

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
  await user.type(form.getByRole('textbox', { name: 'Opened pack, weighed' }), '1.4');
  await user.click(form.getByRole('button', { name: 'kg' }));
  expect(form.getByText('= 5.4 kg')).toBeTruthy();
  await user.click(form.getByRole('button', { name: 'Next' }));

  expect(screen.getByText(/^600 g short · Rs [\d,]+/)).toBeTruthy();
  expect(screen.getByText(/You counted 5.4 kg; sales and deliveries say 6 kg/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Spoiled or expired' }));
  expect(readAll().at(-1)).toMatchObject({ type: 'stock.counted', itemId: 'inv-0006', counted: 5400, expected: 6000, reason: 'spoiled' });

  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(within(mozz).getByText('2¾ packs · 5.4 kg')).toBeTruthy();
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
