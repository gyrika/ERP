import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { prepQuestion, type Answer } from '../domain/costing.ts';
import type { SyncEvent } from '../domain/sync.ts';
import { adjustStock, readItems, setHome } from '../services/inventoryStore.ts';
import { warehousesFromEvents } from '../domain/warehouses.ts';
import { CountFlow } from './CountFlow.tsx';
import { ManagerView } from './ManagerView.tsx';
import { addEvents, readAll } from './eventLog.ts';

// SCRUM-228: semi-processed items are counted too, in their own unit, where they are kept.

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const DOUGH = 'kitchen:kdough1';
const owner = { id: 'o1', name: 'Nisal', role: 'owner' as const };
let n = 0;
/** His Dough (20 balls a batch), and one batch made: 20 balls on hand in its home. */
const makeDough = () => {
  adjustStock('inv-0001', 2); // flour for it
  const answer: Answer = {
    kind: 'prep', name: 'Dough', makes: { qty: 20, unit: 'pcs' },
    lines: [{ name: 'stock:inv-0001', qty: 2000, unit: 'g' }],
  };
  const ticketId = `t-dough-${++n}`;
  const at = Date.now() - 60_000;
  addEvents([
    { id: `a${n}`, shopId: 'shop-demo-cheesybeez', at, orderNumber: 0, actor: owner, type: 'recipe.answer_set', question: prepQuestion('kdough1'), before: null, after: answer },
    { id: `p${n}`, shopId: 'shop-demo-cheesybeez', at: at + 1, orderNumber: 0, actor: owner, type: 'prep.ordered', ticketId, prepId: DOUGH, name: 'Dough', qty: 20, unit: 'pcs' },
    { id: `s${n}`, shopId: 'shop-demo-cheesybeez', at: at + 2, orderNumber: 0, ticketId, type: 'kitchen.started' },
    { id: `b${n}`, shopId: 'shop-demo-cheesybeez', at: at + 3, orderNumber: 0, ticketId, type: 'kitchen.bumped' },
  ] as SyncEvent[]);
};
const doughDue = [{ id: `prep:${DOUGH}`, tier: 'daily' as const, state: 'never' as const, lastCountedAt: null }];

test('a semi-processed item is counted in its own unit, the cursor in the box; a match saves at once', async () => {
  const user = userEvent.setup();
  makeDough();
  render(<CountFlow due={doughDue} rows={readItems()} onClose={() => {}} photoRequired={false} />);
  expect(screen.getByRole('heading', { name: 'Dough' })).toBeTruthy();
  expect(screen.getByText(/Semi-processed · first count/)).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'How much is there' }));
  expect(within(screen.getByRole('group', { name: 'Counted in' })).getByRole('button', { name: 'pcs' })).toBeTruthy();
  await user.keyboard('20{Enter}');
  expect(readAll().at(-1)).toMatchObject({ type: 'stock.counted', itemId: `prep:${DOUGH}`, counted: 20, expected: 20, reason: null, warehouseId: 'wh-1', entries: [{ unit: 'pcs', qty: 20 }] });
  expect(screen.getByRole('status').textContent).toMatch(/^Dough: matches\./);
});

test('a big gap asks why, and the count corrects the stock in that warehouse', async () => {
  const user = userEvent.setup();
  setHome(warehousesFromEvents(readAll()), `semi:${DOUGH}`, 'wh-2'); // kept in Warehouse 2: the batch goes there
  makeDough();
  render(<CountFlow due={doughDue} rows={readItems()} onClose={() => {}} photoRequired={false} />);
  const rooms = screen.queryByRole('group', { name: 'Which warehouse' });
  if (rooms) await user.click(within(rooms).getByRole('button', { name: /^Warehouse 2/ }));
  await user.keyboard('10{Enter}');
  expect(screen.getByText(/^10 pcs short/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Spoiled or expired' }));
  expect(readAll().at(-1)).toMatchObject({ type: 'stock.counted', itemId: `prep:${DOUGH}`, counted: 10, expected: 20, reason: 'spoiled', warehouseId: 'wh-2' });
});

test('the Count page lists a semi-processed item under Daily once it has been made', () => {
  render(<ManagerView />);
  expect(within(screen.getByRole('region', { name: 'Daily counts' })).queryByText('Dough')).toBeNull();
  cleanup();
  makeDough();
  render(<ManagerView />);
  const daily = within(screen.getByRole('region', { name: 'Daily counts' }));
  expect(daily.getByText('Dough')).toBeTruthy();
  expect(daily.getAllByText('First count').length).toBeGreaterThan(0);
});
