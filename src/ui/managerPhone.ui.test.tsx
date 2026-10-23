import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SyncEvent } from '../domain/sync.ts';
import * as photos from '../services/photos.ts';
import { CountFlow } from './CountFlow.tsx';
import { addEvents, readAll } from './eventLog.ts';
import { ManagerView } from './ManagerView.tsx';
import { OwnerShell } from './OwnerShell.tsx';

// The manager's phone app (SCRUM-94): a big gap needs a shelf photo; the phone shows counts and stock only.

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const actor = { id: 'm', name: 'Manager', role: 'manager' as const };
const counted = (itemId: string, at: number, base: number): SyncEvent =>
  ({ id: `c-${itemId}-${at}`, shopId: 'shop-demo-cheesybeez', at, orderNumber: 0, actor, type: 'stock.counted', itemId, counted: base, expected: 0, entries: [], reason: null, valueCents: 0, tier: 'daily' });

test('on the phone a big gap asks for a shelf photo after the reason; Save waits for it', async () => {
  addEvents([counted('inv-0006', Date.now() - 40 * 24 * 3600_000, 6000)]);
  const shrink = vi.spyOn(photos, 'shrinkPhoto').mockResolvedValue('/9j/AAAA');
  const user = userEvent.setup();
  const { useInventory } = await import('../services/inventoryStore.ts');
  function Phone() {
    const { items } = useInventory();
    return <CountFlow photoRequired rows={items} onClose={() => {}} due={[{ id: 'inv-0006', tier: 'daily', state: 'due', lastCountedAt: 1 }]} />;
  }
  render(<Phone />);
  await user.type(screen.getByRole('textbox', { name: 'Full packs' }), '2');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Wrong entry' }));

  expect(screen.getByText('A photo of the shelf, so the owner sees what you saw.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  expect(readAll().filter((e) => e.type === 'stock.counted')).toHaveLength(1); // nothing saved yet

  await user.upload(screen.getByLabelText('Shelf photo'), new File(['x'], 'shelf.jpg', { type: 'image/jpeg' }));
  expect(shrink).toHaveBeenCalledOnce();
  expect(await screen.findByRole('img', { name: /^Shelf photo of / })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Save' }));

  const saved = readAll().at(-1) as Extract<SyncEvent, { type: 'stock.counted' }>;
  expect(saved).toMatchObject({ type: 'stock.counted', reason: 'wrong-entry', counted: 4000 });
  expect(saved.photo).toMatch(/^ph-/);
  expect(photos.waitingPhotos()).toBe(1); // kept on the phone until the shop PC has it
  expect(within(screen.getByRole('dialog')).getByText(/gap of Rs [\d,]+ saved/)).toBeTruthy();
});

test('the counter PC asks only for the reason (no camera there)', async () => {
  addEvents([counted('inv-0006', Date.now() - 40 * 24 * 3600_000, 6000)]);
  const user = userEvent.setup();
  const { useInventory } = await import('../services/inventoryStore.ts');
  function Counter() {
    const { items } = useInventory();
    return <CountFlow photoRequired={false} rows={items} onClose={() => {}} due={[{ id: 'inv-0006', tier: 'daily', state: 'due', lastCountedAt: 1 }]} />;
  }
  render(<Counter />);
  await user.type(screen.getByRole('textbox', { name: 'Full packs' }), '2');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Wrong entry' }));
  expect(readAll().at(-1)).toMatchObject({ type: 'stock.counted', reason: 'wrong-entry' });
  expect(screen.queryByLabelText('Shelf photo')).toBeNull();
});

test('the manager phone app shows Manager and Inventory only, no Register and no Edit lists', () => {
  vi.stubEnv('VITE_SITE', 'cloud');
  localStorage.setItem('cb.manager.token', 'k'.repeat(43));
  render(<OwnerShell current="manager"><ManagerView /></OwnerShell>);
  const nav = within(screen.getByRole('navigation', { name: 'Owner sections' }));
  expect(nav.getAllByRole('link').map((a) => a.getAttribute('aria-label'))).toEqual(['Manager', 'Inventory']);
  expect(screen.queryByText('Register')).toBeNull();
  expect(screen.queryByText('Switch user')).toBeNull(); // the phone belongs to one manager
  expect(screen.queryByRole('button', { name: 'Edit lists' })).toBeNull();
  vi.unstubAllEnvs();
});
