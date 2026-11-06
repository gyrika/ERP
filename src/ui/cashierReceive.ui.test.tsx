import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as inventoryStore from '../services/inventoryStore.ts';
import * as authService from '../services/auth.ts';
import type { Actor } from '../domain/auth.ts';
import { purchasesFromEvents } from '../domain/purchaseOrders.ts';
import { readAll } from './eventLog.ts';
import { ReceiveSheet, ReceiveView } from './WorkViews.tsx';

/**
 * SCRUM-226: the cashier receives a delivery at the counter (F7) and pays it from the drawer.
 * Short waits for the rest, a changed price waits for a manager, extra still needs a manager's PIN.
 */
const nimal: Actor = { id: 'staff-nimal', name: 'Nimal', role: 'cashier' };
const ravi: Actor = { id: 'staff-ravi', name: 'Ravi', role: 'manager' };
const signedIn = (who: Actor) => vi.spyOn(authService, 'currentCashier').mockReturnValue(who);

beforeEach(() => { localStorage.clear(); signedIn(nimal); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** 3 packs of flour on order from Prima, at Rs 6,400 a pack. */
const orderFlour = () => act(() => {
  inventoryStore.placeOrder('sup_prima', [{ itemId: 'inv-0001', packs: 3, unitPriceCents: 640000 }]);
});
/** Receive at the counter, on the flour order (picked when the list of deliveries shows). */
const openAtCounter = async (user: ReturnType<typeof userEvent.setup>) => {
  const page = render(<ReceiveSheet manages={false} onClose={() => {}} onDone={() => {}} />);
  const card = screen.queryByRole('button', { name: /^Prima \/ David Stores \(Wholesale\) · PO-/ });
  if (card) await user.click(card);
  return page;
};
const typeInto = async (user: ReturnType<typeof userEvent.setup>, name: string, text: string) => {
  const field = screen.getByRole('textbox', { name });
  await user.clear(field);
  await user.type(field, text);
};
const last = (type: string) => readAll().filter((e) => e.type === type).at(-1);

test('a short delivery: the cashier saves it without a PIN, the rest stays on order, and pays it from the drawer', async () => {
  const user = userEvent.setup();
  orderFlour();
  await openAtCounter(user);
  await typeInto(user, 'Packs of Pizza Flour', '2');
  // Ticked by the amount: the primary is Save GRN, not Manager approves.
  await user.click(screen.getByRole('button', { name: 'Save GRN' }));

  const grn = last('stock.grn') as Extract<ReturnType<typeof readAll>[number], { type: 'stock.grn' }>;
  expect(grn.approvedBy).toBeNull();
  expect(grn.shortDecision).toBe('wait');
  expect(grn.actor.role).toBe('cashier');
  expect(screen.getByText(/the rest stays on order/)).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Pay Rs 12,800 from drawer' }));
  const paid = last('money.out') as Extract<ReturnType<typeof readAll>[number], { type: 'money.out' }>;
  expect(paid).toMatchObject({ what: 'supplier', from: 'drawer', cents: 1_280_000, supplierId: 'sup_prima', grnIds: [grn.id] });
  expect(screen.getByText(/Rs 12,800 paid from the drawer/)).toBeTruthy();
  // Its Undo is right there; the order is still open for the last pack.
  await user.click(screen.getByRole('button', { name: 'Undo payment' }));
  expect(last('money.out_undone')).toMatchObject({ outId: paid.id });
  expect(purchasesFromEvents(readAll()).open.map((o) => o.status)).toEqual(['partly']);
});

test('a changed price: saved at the counter, the item keeps its price until a manager decides on the GRN', async () => {
  const user = userEvent.setup();
  orderFlour();
  const before = inventoryStore.readItems().find((i) => i.id === 'inv-0001')!.workingPriceCents;
  const { unmount } = await openAtCounter(user);
  await typeInto(user, 'Delivered price per pack of Pizza Flour', '6600');
  // Typing the price ticks the item: Save GRN is next.
  await user.click(screen.getByRole('button', { name: 'Save GRN' }));
  expect(screen.getByText(/the new price goes to a manager to decide/)).toBeTruthy();
  expect(readAll().some((e) => e.type === 'stock.price_set')).toBe(false);
  expect(inventoryStore.readItems().find((i) => i.id === 'inv-0001')!.workingPriceCents).toBe(before);
  unmount();

  // The owner's To do opens #receive/<GRN id>: the manager decides there.
  signedIn(ravi);
  const grn = last('stock.grn')!;
  render(<ReceiveView openGrn={grn.id} />);
  expect(screen.getByText(/Saved at the counter by Nimal/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Use new price' }));
  expect(last('stock.grn_price_reviewed')).toMatchObject({ grnId: grn.id, use: true });
  expect(last('stock.price_set')).toMatchObject({ itemId: 'inv-0001', after: 660_000, grnId: grn.id });
  expect(screen.queryByRole('button', { name: 'Use new price' })).toBeNull();
});

test('more than was ordered still needs a manager at the counter', async () => {
  const user = userEvent.setup();
  orderFlour();
  await openAtCounter(user);
  await typeInto(user, 'Packs of Pizza Flour', '4');
  expect(screen.getByRole('button', { name: 'Manager approves' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Save GRN' })).toBeNull();
});
