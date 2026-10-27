import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Actor } from '../domain/auth.ts';
import { lock } from '../services/serverAuth.ts';
import { IDLE_LOCK_MS, Root } from './Root.tsx';

const STAFF: Record<string, Actor> = {
  1111: { id: 's-nimal', name: 'Nimal', role: 'cashier' },
  2580: { id: 's-ravi', name: 'Ravi', role: 'manager' },
  3333: { id: 's-kumar', name: 'Kumar', role: 'kitchen' },
  8765: { id: 's-owner', name: 'Owner', role: 'owner' },
};

/** The server's /api/v1/login, as far as the screens can tell. */
const server = vi.fn(async (_url: string, init: RequestInit) => {
  const { pin, purpose } = JSON.parse(String(init.body)) as { pin: string; purpose: string };
  const actor = STAFF[pin];
  if (!actor || (purpose === 'manager' && actor.role !== 'manager')) return new Response('{"error":"wrong_pin"}', { status: 401 });
  return Response.json({ actor, expiresAt: Date.now() + 3_600_000, serverTime: Date.now() });
});

const pair = (as = 'counter') => {
  localStorage.setItem('cb.sync.token', 'device-token');
  localStorage.setItem('cb.sync.kind', as);
};

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, '', '/');
  vi.stubGlobal('fetch', server);
  server.mockClear();
});
afterEach(() => {
  act(() => lock());
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const lockScreen = () => screen.queryByRole('main', { name: 'Log in' });
const panel = () => within(screen.getByRole('complementary', { name: 'Current order' }));

test('a paired counter opens locked; a wrong PIN says so; the right one opens the register; F4 locks', async () => {
  pair();
  const user = userEvent.setup();
  render(<Root />);
  expect(lockScreen()).toBeTruthy();

  await user.keyboard('9999');
  expect(await screen.findByText('Wrong PIN')).toBeTruthy();

  // Tapping works as well as typing.
  for (const d of '1111') await user.click(screen.getByRole('button', { name: d }));
  expect(await screen.findByRole('button', { name: 'Nimal: switch user' })).toBeTruthy();
  expect(lockScreen()).toBeNull();

  await user.keyboard('{F4}');
  expect(lockScreen()).toBeTruthy();
});

test('every order records who took it', async () => {
  pair();
  const user = userEvent.setup();
  render(<Root />);
  await user.keyboard('1111');
  await screen.findByRole('button', { name: 'Nimal: switch user' });
  await user.click(screen.getAllByRole('button', { name: 'L 2500' })[0]);
  await user.click(panel().getByRole('button', { name: 'Send to kitchen' }));
  const events = JSON.parse(localStorage.getItem('cb.events.v0') ?? '[]') as { type: string; actor?: Actor }[];
  expect(events.find((e) => e.type === 'order.sent')?.actor).toEqual(STAFF[1111]);
});

test('a cashier does not see the day’s takings; a manager does', async () => {
  pair();
  const user = userEvent.setup();
  render(<Root />);
  await user.keyboard('1111');
  await screen.findByRole('button', { name: 'Nimal: switch user' });
  await user.click(screen.getAllByRole('button', { name: 'L 2500' })[0]);
  await user.click(panel().getByRole('button', { name: 'Send to kitchen' }));
  await user.click(panel().getByRole('button', { name: /^1001/ }));
  await user.click(panel().getByRole('button', { name: 'Charge' }));
  await user.click(screen.getByRole('button', { name: /Exact/ }));
  await user.click(panel().getByRole('button', { name: 'Next order' }));
  expect(panel().queryByRole('region', { name: 'Paid today' })).toBeNull();

  await user.keyboard('{F4}2580');
  await screen.findByRole('button', { name: 'Ravi: switch user' });
  expect(panel().getByRole('region', { name: 'Paid today' })).toBeTruthy();
});

test('locking while the Kitchen view shows keeps the kitchen visible; the Register needs a PIN', async () => {
  pair();
  const user = userEvent.setup();
  render(<Root />);
  await user.keyboard('1111');
  await screen.findByRole('button', { name: 'Nimal: switch user' });
  await user.keyboard('{F2}');
  expect(screen.getByRole('main', { name: 'Orders to make' })).toBeTruthy();

  act(() => lock());
  expect(screen.getByRole('main', { name: 'Orders to make' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: /^Register/ }));
  expect(lockScreen()).toBeTruthy();
});

test('a kitchen login sees the Kitchen only; a kitchen device needs no login at all', async () => {
  pair();
  const user = userEvent.setup();
  const { unmount } = render(<Root />);
  await user.keyboard('3333');
  expect(await screen.findByRole('main', { name: 'Orders to make' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Register/ })).toBeNull();
  await user.keyboard('{F2}');
  expect(screen.getByRole('main', { name: 'Orders to make' })).toBeTruthy(); // F2 does not lead out
  await user.click(screen.getByRole('button', { name: /^Switch user/ }));
  expect(lockScreen()).toBeTruthy();
  unmount();

  pair('kitchen');
  render(<Root />);
  expect(screen.getByRole('main', { name: 'Orders to make' })).toBeTruthy();
  expect(lockScreen()).toBeNull();
});

test('the screen locks itself after a few quiet minutes', async () => {
  pair();
  render(<Root />);
  await userEvent.setup().keyboard('1111');
  await screen.findByRole('button', { name: 'Nimal: switch user' });

  // From here on the clock is ours; the next key restarts the idle timer on it.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fireEvent.keyDown(document.body, { key: 'Shift' });
  await act(() => vi.advanceTimersByTimeAsync(IDLE_LOCK_MS - 1000));
  fireEvent.keyDown(document.body, { key: 'Shift' }); // any key counts as activity
  await act(() => vi.advanceTimersByTimeAsync(IDLE_LOCK_MS - 1000));
  expect(lockScreen()).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(lockScreen()).toBeTruthy();
});

test('manager mode checks the PIN with the server: a cashier’s PIN does not open it', async () => {
  pair();
  const user = userEvent.setup();
  render(<Root />);
  await user.keyboard('1111');
  await screen.findByRole('button', { name: 'Nimal: switch user' });
  await user.keyboard('{Control>}m{/Control}');
  await user.keyboard('1111');
  await vi.waitFor(() => expect(server).toHaveBeenLastCalledWith('/api/v1/login', expect.objectContaining({
    body: JSON.stringify({ pin: '1111', purpose: 'manager' }),
  })));
  expect(screen.queryByText(/^Managing/)).toBeNull();
  await user.keyboard('2580');
  expect(await screen.findByText('Managing · Ravi')).toBeTruthy();
});

test('cashiers cannot open stock views or see their command; managers can', async () => {
  pair();
  history.replaceState(null, '', '/#inventory');
  const user = userEvent.setup();
  render(<Root />);
  await user.keyboard('1111');
  await screen.findByRole('button', { name: 'Nimal: switch user' });
  expect(screen.queryByRole('main', { name: 'Inventory' })).toBeNull();

  await user.keyboard('{Control>}m{/Control}2580');
  expect(await screen.findByText('Managing · Ravi')).toBeTruthy();
  await user.keyboard('{Control>}k{/Control}');
  expect(screen.getByRole('dialog', { name: 'Commands' })).toBeTruthy();
  expect(screen.queryByText('Inventory and stock')).toBeNull();
  expect(screen.queryByText('Suppliers')).toBeNull();
  await user.keyboard('{Escape}');

  await user.keyboard('{F4}2580');
  expect(await screen.findByRole('main', { name: 'Inventory' })).toBeTruthy();
});

test.each([
  ['manager', '2580'],
  ['owner', '8765'],
])('%s can open the suppliers view', async (_role, pin) => {
  pair();
  history.replaceState(null, '', '/#suppliers');
  const user = userEvent.setup();
  render(<Root />);
  await user.keyboard(pin);
  expect(await screen.findByRole('main', { name: 'Suppliers' })).toBeTruthy();
});

test('owner view: a cashier typing the address gets the Register; the owner or a manager gets the feed', async () => {
  pair();
  history.replaceState(null, '', '/#owner');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => (
    String(url).startsWith('/api/v1/events') ? Response.json({ events: [], lastSeq: 0, more: false, serverTime: 0 }) : server(url, init))));
  const user = userEvent.setup();
  render(<Root />);
  await user.keyboard('1111');
  await screen.findByRole('button', { name: 'Nimal: switch user' });
  expect(screen.queryByRole('main', { name: 'Owner' })).toBeNull();

  await user.keyboard('{F4}2580');
  expect(await screen.findByRole('main', { name: 'Owner' })).toBeTruthy();
});

test('the owner and managers see an Owner view key; a cashier does not', async () => {
  pair();
  const user = userEvent.setup();
  render(<Root />);
  await user.keyboard('1111');
  await screen.findByRole('button', { name: 'Nimal: switch user' });
  expect(screen.queryByRole('button', { name: /^Owner view/ })).toBeNull();
  await user.keyboard('{F4}2580');
  await screen.findByRole('button', { name: 'Ravi: switch user' });
  expect(screen.getByRole('button', { name: 'Owner view F3' })).toBeTruthy();
});

test('F3 flips a manager between the Register and the Owner view; a cashier stays on the Register', async () => {
  pair();
  const user = userEvent.setup();
  render(<Root />);
  const owner = () => screen.queryByRole('main', { name: 'Owner' });

  await user.keyboard('1111');
  await screen.findByRole('button', { name: 'Nimal: switch user' });
  expect(screen.queryByRole('button', { name: /^Owner view/ })).toBeNull();
  await user.keyboard('{F3}');
  expect(owner()).toBeNull();

  await user.keyboard('{F4}2580');
  await screen.findByRole('button', { name: 'Ravi: switch user' });
  await user.keyboard('{F3}');
  expect(owner()).toBeTruthy();
  await user.keyboard('{F3}');
  expect(owner()).toBeNull();
  expect(panel()).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Owner view F3' }));
  expect(owner()).toBeTruthy();
  await user.click(screen.getByRole('link', { name: 'Sell' })); // the register is the first part of the menu
  expect(panel()).toBeTruthy();
});

test("a manager sees no recipes (no Recipe on a dish), and typing the address gives the Register: the recipes are the owner's", async () => {
  pair();
  history.replaceState(null, '', '/#inventory');
  const user = userEvent.setup();
  render(<Root />);
  await user.keyboard('2580');
  const nav = within(await screen.findByRole('navigation', { name: 'Owner sections' }));
  expect(nav.getByRole('link', { name: 'Items' })).toBeTruthy();
  const tabs = within(screen.getByRole('navigation', { name: 'Items' }));
  // Semi-processed items are items, not recipes: managers see them too; the finished dishes' recipes stay the owner's.
  expect(tabs.getAllByRole('link').map((a) => a.firstChild?.textContent)).toEqual(['Raw materials', 'Semi-processed', 'Finished', 'Warehouses']);

  act(() => { location.hash = '#recipes'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
  expect(await screen.findByRole('complementary', { name: 'Current order' })).toBeTruthy();
  expect(screen.queryByLabelText('Owner PIN')).toBeNull();
});
