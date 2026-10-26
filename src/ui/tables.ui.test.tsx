import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TableEvent } from '../domain/events.ts';
import { appendEvent, readAll } from './eventLog.ts';
import { Root } from './Root.tsx';

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, '', '/');
});
afterEach(cleanup);

const owner = { id: 'fake-owner-1', name: 'Owner', role: 'owner' as const };
const cameras = { id: 'vision', name: 'Cameras', role: 'vision' as const };
const layout = () => appendEvent({
  type: 'table.layout_set', at: Date.now(), orderNumber: 0, actor: owner,
  tables: [{ id: 't1', label: '1', seats: 2 }, { id: 't2', label: '2', seats: 4 }, { id: 't3', label: '3', seats: 4 }],
});
/** What a camera would have said (the worker writes these on the shop PC). */
const seen = (tableId: string, from: 'free' | 'occupied', to: 'occupied' | 'needs_cleaning') => appendEvent({
  type: 'table.state_changed', at: Date.now(), orderNumber: 0, actor: cameras, tableId, from, to, confidence: 0.95,
});
const floor = () => within(screen.getByRole('main', { name: 'Tables' }));
/** The floor is loaded when first opened (lazy), so wait for it. */
const opened = () => screen.findByRole('main', { name: 'Tables' }, { timeout: 5000 });
const tableEvents = () => readAll().filter((e): e is Extract<typeof e, TableEvent> => e.type === 'table.state_set' || e.type === 'table.state_set_undone');

test('no table layout yet: no Tables chip, and F1 stays on the Register', async () => {
  const user = userEvent.setup();
  render(<Root />);
  await user.keyboard('{F1}');
  // The chip and the floor's fold load on demand: once they have, there is still nothing to show.
  await act(async () => { await import('./TablesChip.tsx'); await import('./tablesStore.ts'); });
  expect(screen.queryByRole('button', { name: /^Tables/ })).toBeNull();
  expect(screen.queryByRole('main', { name: 'Tables' })).toBeNull();
  expect(screen.getByRole('complementary', { name: 'Current order' })).toBeTruthy();
});

test('the chip says how many tables are free; F1 flips to the floor and back, Esc goes back too', async () => {
  layout();
  seen('t2', 'free', 'occupied');
  const user = userEvent.setup();
  render(<Root />);
  expect(await screen.findByRole('button', { name: 'Tables: 2 of 3 free' })).toBeTruthy();

  await user.keyboard('{F1}');
  await opened();
  const tiles = floor().getAllByRole('option');
  expect(tiles.map((t) => t.getAttribute('aria-label'))).toEqual([
    expect.stringMatching(/^Table 1, free, \d\d:\d\d$/),
    expect.stringMatching(/^Table 2, occupied, \d\d:\d\d$/),
    expect.stringMatching(/^Table 3, free, \d\d:\d\d$/),
  ]);
  await user.keyboard('{F1}');
  expect(screen.queryByRole('main', { name: 'Tables' })).toBeNull();

  await user.click(await screen.findByRole('button', { name: 'Tables: 2 of 3 free' }));
  expect(await opened()).toBeTruthy();
  await user.keyboard('{Escape}');
  await expect.poll(() => screen.queryByRole('main', { name: 'Tables' })).toBeNull();
  expect(screen.getByRole('complementary', { name: 'Current order' })).toBeTruthy();
});

test('a dirty table: arrows pick it, C marks it cleaned (free), Ctrl+Z undoes it; each is an event', async () => {
  layout();
  seen('t2', 'free', 'occupied');
  seen('t2', 'occupied', 'needs_cleaning');
  const user = userEvent.setup();
  render(<Root />);
  expect(await screen.findByRole('button', { name: 'Tables: 2 of 3 free, 1 to clean' })).toBeTruthy();
  await user.keyboard('{F1}');
  await opened();
  expect(floor().getByRole('option', { selected: true }).getAttribute('aria-label')).toMatch(/^Table 1,/);

  await user.keyboard('{ArrowRight}');
  expect(floor().getByRole('option', { selected: true }).getAttribute('aria-label')).toMatch(/^Table 2, needs cleaning/);
  await user.keyboard('c');
  expect(floor().getByRole('option', { selected: true }).getAttribute('aria-label')).toMatch(/^Table 2, free/);
  expect(tableEvents()).toMatchObject([{ type: 'table.state_set', tableId: 't2', from: 'needs_cleaning', to: 'free', orderNumber: 0 }]);
  expect(tableEvents()[0].actor.role).not.toBe('vision');

  await user.keyboard('{Control>}z{/Control}');
  expect(floor().getByRole('option', { selected: true }).getAttribute('aria-label')).toMatch(/^Table 2, needs cleaning/);
  expect(tableEvents().map((e) => e.type)).toEqual(['table.state_set', 'table.state_set_undone']);
});

test('by touch: tap a table, then Reserved, Free, and the visible Undo', async () => {
  layout();
  const user = userEvent.setup();
  render(<Root />);
  await user.click(await screen.findByRole('button', { name: 'Tables: 3 of 3 free' }));
  await opened();
  await user.click(floor().getByRole('option', { name: /^Table 3,/ }));
  await user.click(floor().getByRole('button', { name: /^Reserved/ }));
  expect(floor().getByRole('option', { name: /^Table 3, reserved/ })).toBeTruthy();
  await user.keyboard('f');
  expect(floor().getByRole('option', { name: /^Table 3, free/ })).toBeTruthy();
  await user.click(floor().getByRole('button', { name: /^Undo/ }));
  expect(floor().getByRole('option', { name: /^Table 3, reserved/ })).toBeTruthy();
  expect(tableEvents().map((e) => [e.type, e.type === 'table.state_set' ? e.to : e.type === 'table.state_set_undone' && e.undoneEventId.length > 0])).toEqual([
    ['table.state_set', 'reserved'], ['table.state_set', 'free'], ['table.state_set_undone', true],
  ]);
});

test('works with no cameras: Seated (O) marks a table taken by hand', async () => {
  layout();
  const user = userEvent.setup();
  render(<Root />);
  await user.keyboard('{F1}');
  await opened();
  await user.keyboard('o');
  expect(floor().getByRole('option', { name: /^Table 1, occupied/ })).toBeTruthy();
  await user.keyboard('{F1}');
  expect(await screen.findByRole('button', { name: 'Tables: 2 of 3 free' })).toBeTruthy();
});
