import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OnlineOrder } from '../domain/online.ts';
import { lock } from '../services/serverAuth.ts';
import { Root } from './Root.tsx';

const order = (id: string, name: string, more: Partial<OnlineOrder> = {}): OnlineOrder => ({
  id, createdAt: Date.now() - 120_000, status: 'new', kind: 'pickup', name, phone: '0771234567', address: null, pin: null, note: 'Ring the bell',
  deliveryFee: 0, distanceKm: null, total: 360000, orderNumber: null, readyBy: null, reason: null,
  lines: [{ itemId: 'devilled-chicken', qty: 2, size: 'L', adds: [], outs: ['no-onion'] }], ...more,
});

/** The shop server: the counter's login and its online orders, remembering the answers it was given. */
function shopServer() {
  const s = { open: true, orders: [order('o-aaaaaaaaaa', 'Kasun'), order('o-bbbbbbbbbb', 'Nimali')], answers: [] as unknown[] };
  const view = () => Response.json({ available: true, open: s.open, connected: true, orders: s.orders });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url === '/api/v1/login') return Response.json({ actor: { id: 's-nimal', name: 'Nimal', role: 'cashier' }, expiresAt: Date.now() + 3_600_000, serverTime: Date.now() });
    if (url === '/api/v1/fleet') return new Response('{}', { status: 404 }); // a shop PC: no Shops screen
    if (url === '/api/v1/online' && !body) return view();
    if (url === '/api/v1/online/open') { s.open = body.open; return view(); }
    const id = url.replace('/api/v1/online/', '');
    s.answers.push({ id, ...body });
    s.orders = s.orders.map((o) => (o.id === id ? { ...o, ...body } : o));
    return view();
  }));
  return s;
}

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, '', '/');
  localStorage.setItem('cb.sync.token', 'device-token');
  localStorage.setItem('cb.sync.kind', 'counter');
});
afterEach(() => { act(() => lock()); cleanup(); vi.unstubAllGlobals(); });

test('an online order: seen at the counter, accepted with a time, in the kitchen with the number the customer was told', async () => {
  const server = shopServer();
  const user = userEvent.setup();
  render(<Root />);
  await user.keyboard('1111');
  await user.click(await screen.findByRole('button', { name: 'Online orders: 2 new' }));

  const sheet = within(screen.getByRole('dialog', { name: 'Online orders' }));
  const kasun = within(sheet.getByRole('article', { name: 'Online order from Kasun' }));
  expect(kasun.getByText('2 × Devilled Chicken · Large · No onion')).toBeTruthy();
  expect(kasun.getByText('“Ring the bell”')).toBeTruthy();
  await user.click(kasun.getByRole('button', { name: '20 min' }));

  expect(server.answers[0]).toMatchObject({ id: 'o-aaaaaaaaaa', status: 'accepted', orderNumber: 1001 });
  const readyBy = (server.answers[0] as { readyBy: number }).readyBy;
  expect(Math.abs(readyBy - (Date.now() + 20 * 60_000))).toBeLessThan(5_000);
  expect(await sheet.findByText('Ready by', { exact: false })).toBeTruthy();

  // Declining asks why, in one more tap.
  const nimali = within(sheet.getByRole('article', { name: 'Online order from Nimali' }));
  await user.click(nimali.getByRole('button', { name: 'Decline' }));
  await user.click(nimali.getByRole('button', { name: 'Too busy right now' }));
  expect(server.answers[1]).toEqual({ id: 'o-bbbbbbbbbb', status: 'declined', reason: 'Too busy right now' });

  await user.keyboard('{Escape}');
  const panel = within(screen.getByRole('complementary', { name: 'Current order' }));
  const pickup = new Date(readyBy).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const row = within(panel.getByRole('region', { name: 'Waiting to pay' })).getByRole('button', { name: /^1001/ });
  expect(within(row).getByText(`Online · ${pickup}`)).toBeTruthy();
  await user.keyboard('{F2}');
  const ticket = within(within(screen.getByRole('main', { name: 'Orders to make' })).getByRole('article', { name: 'Order 1001' }));
  expect(ticket.getByText(`Online · pickup ${pickup}`)).toBeTruthy();
});

test('the switch: not taking orders until the counter says so', async () => {
  const server = shopServer();
  server.open = false;
  server.orders = [];
  const user = userEvent.setup();
  render(<Root />);
  await user.keyboard('1111');
  await user.click(await screen.findByRole('button', { name: 'Online orders: off' }));
  const toggle = screen.getByRole('switch', { name: 'Take online orders' });
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(toggle.textContent).toContain('Offline');
  await user.click(toggle);
  expect(server.open).toBe(true);
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  expect(toggle.textContent).toContain('Online');
});

test('a delivery: the address and map for the rider, accepted with a ride time, Out as he leaves, the fee in the total', async () => {
  const server = shopServer();
  server.orders = [order('o-cccccccccc', 'Kasun', {
    kind: 'delivery', address: '12 Station Rd, Thalawathugoda', pin: { lat: 6.82351, lng: 79.89012 }, deliveryFee: 25000, distanceKm: 4.6, total: 385000,
  })];
  const user = userEvent.setup();
  render(<Root />);
  await user.keyboard('1111');
  await user.click(await screen.findByRole('button', { name: 'Online orders: 1 new' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Online orders' }));
  const kasun = within(sheet.getByRole('article', { name: 'Delivery order from Kasun' }));
  expect(kasun.getByText('12 Station Rd, Thalawathugoda', { exact: false })).toBeTruthy();
  expect(kasun.getByRole('link', { name: 'Map' }).getAttribute('href')).toBe('https://www.google.com/maps/search/?api=1&query=6.82351,79.89012');
  expect(kasun.getByText('· 4.6 km')).toBeTruthy();
  expect(kasun.queryByRole('button', { name: '15 min' })).toBeNull();
  await user.click(kasun.getByRole('button', { name: 'Decline' }));
  expect(kasun.getByRole('button', { name: 'Too far to deliver' })).toBeTruthy();
  await user.click(kasun.getByRole('button', { name: 'Back' }));
  await user.click(kasun.getByRole('button', { name: '45 min' }));
  expect(server.answers[0]).toMatchObject({ status: 'accepted', orderNumber: 1001 });

  await user.click(await sheet.findByRole('button', { name: 'Order 1001: out with the rider' }));
  expect(server.answers[1]).toEqual({ id: 'o-cccccccccc', status: 'out' });
  expect(await sheet.findByText('On the way · collect 3,850')).toBeTruthy();

  await user.keyboard('{Escape}');
  const panel = within(screen.getByRole('complementary', { name: 'Current order' }));
  const row = within(panel.getByRole('region', { name: 'Waiting to pay' })).getByRole('button', { name: /^1001/ });
  expect(within(row).getByText(/^Delivery · /)).toBeTruthy();
  await user.keyboard('{F2}');
  const ticket = within(within(screen.getByRole('main', { name: 'Orders to make' })).getByRole('article', { name: 'Order 1001' }));
  expect(ticket.getByText(/^Delivery · by /)).toBeTruthy();
});
