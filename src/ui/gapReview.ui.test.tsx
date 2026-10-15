import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SyncEvent } from '../domain/sync.ts';
import { addEvents, readAll } from './eventLog.ts';
import { ManagerView } from './ManagerView.tsx';
import { OwnerView } from './OwnerView.tsx';

// The owner checks the gaps; the manager answers (SCRUM-95).

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const ravi = { id: 'r', name: 'Ravi', role: 'manager' as const };
const gap = (id: string, itemId: string, valueCents: number): SyncEvent =>
  ({ id, shopId: 'shop-demo-cheesybeez', at: Date.now() - 3600_000, orderNumber: 0, actor: ravi, type: 'stock.counted', itemId,
    counted: 1000, expected: 2000, entries: [], reason: 'spoiled', valueCents, tier: 'daily' });

test('the owner asks about a gap, the manager answers, the owner sees it and says OK', async () => {
  addEvents([gap('c1', 'inv-0006', -260000), gap('c2', 'inv-0001', -64000)]);
  const user = userEvent.setup();
  const owner = render(<OwnerView />);
  const card = await screen.findByRole('article', { name: '2 gaps in the counts to check' });
  await user.click(within(card).getByRole('button', { name: 'Check' }));
  const sheet = within(screen.getByRole('dialog'));
  const mozz = within(sheet.getByRole('listitem', { name: 'Mozzarella (Prabhat)' }));
  expect(mozz.getByText(/^1 kg short · Spoiled or expired · Ravi/)).toBeTruthy();
  expect(mozz.getByText('Rs 2,600')).toBeTruthy();
  await user.click(mozz.getByRole('button', { name: 'Ask' }));
  await user.type(mozz.getByRole('textbox', { name: 'Question about Mozzarella (Prabhat)' }), 'Spoiled how?');
  await user.click(mozz.getByRole('button', { name: 'Send' }));
  expect(readAll().at(-1)).toMatchObject({ type: 'stock.gap_reviewed', countId: 'c1', decision: 'ask', note: 'Spoiled how?' });
  expect(await mozz.findByText('Waiting for the answer.')).toBeTruthy();

  // The flour is fine: OK, and it leaves the list.
  await user.click(sheet.getByRole('button', { name: 'OK Pizza Flour' }));
  expect(readAll().at(-1)).toMatchObject({ type: 'stock.gap_reviewed', countId: 'c2', decision: 'ok' });
  owner.unmount();

  // The manager sees the question and answers it.
  const manager = render(<ManagerView />);
  const asks = within(screen.getByRole('region', { name: 'The owner asks' }));
  expect(asks.getByText(/: Spoiled how\?$/)).toBeTruthy();
  expect(asks.queryByText('Pizza Flour')).toBeNull();
  await user.type(asks.getByRole('textbox', { name: 'Your answer about Mozzarella (Prabhat)' }), 'Fridge door left open overnight.');
  await user.click(asks.getByRole('button', { name: 'Answer' }));
  expect(readAll().at(-1)).toMatchObject({ type: 'stock.gap_answered', countId: 'c1', note: 'Fridge door left open overnight.' });
  expect(screen.queryByRole('region', { name: 'The owner asks' })).toBeNull();
  manager.unmount();

  // Back with the owner: the answer is on the card; OK closes it.
  render(<OwnerView />);
  const back = await screen.findByRole('article', { name: /^Mozzarella \(Prabhat\): 1 kg short/ });
  expect(within(back).getByText('1 answer from the manager.')).toBeTruthy();
  await user.click(within(back).getByRole('button', { name: 'Check' }));
  expect(screen.getByText('Fridge door left open overnight.')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'OK Mozzarella (Prabhat)' }));
  expect(screen.queryByRole('article', { name: /^Mozzarella \(Prabhat\): / })).toBeNull();
});

test('three short counts in a row make a card', async () => {
  addEvents([gap('a', 'inv-0006', -10000), { ...gap('b', 'inv-0006', -20000), at: Date.now() - 1000 } as SyncEvent, { ...gap('c', 'inv-0006', -30000), at: Date.now() - 500 } as SyncEvent]);
  render(<OwnerView />);
  expect(await screen.findByRole('article', { name: 'Mozzarella (Prabhat) short 3 counts in a row' })).toBeTruthy();
});
