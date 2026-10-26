import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { adjustStock } from '../services/inventoryStore.ts';
import { InventoryView } from './InventoryView.tsx';

// SCRUM-163: the money on the shelves, on Items.

beforeEach(() => localStorage.clear());
afterEach(cleanup);

test('Items shows the stock value, each tab its share, and its last 30 days', async () => {
  adjustStock('inv-0001', 2); // two 25 kg bags of flour at Rs 6,400
  render(<InventoryView />);
  const value = within(screen.getByRole('region', { name: 'Stock value' }));
  expect(value.getByText('Rs 12,800')).toBeTruthy();
  expect(value.getByText(/not counted: not in the total/)).toBeTruthy();
  const tabs = within(screen.getByRole('navigation', { name: 'Items' }));
  expect(tabs.getByRole('link', { name: /^Raw materials/ }).textContent).toBe('Raw materialsRs 12,800');
  expect(tabs.getByRole('link', { name: /^Finished/ }).textContent).toBe('FinishedRs 0');
  // The trend is worked out after the screen shows.
  expect((await value.findByRole('img', { name: /^Last 30 days: from Rs 0 to Rs 12,800/ })).tagName).toBe('svg');
});

test('#items/item/<id> (from Visual Flow) opens that item straight on its History', () => {
  render(<InventoryView openId="inv-0001" />);
  expect(screen.getByRole('tab', { name: 'History' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByText(/^Nothing yet: no counts, deliveries, waste or price changes for Pizza Flour/)).toBeTruthy();
});
