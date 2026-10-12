import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OnlineOrder } from '../domain/online.ts';
import { lock } from '../services/serverAuth.ts';
import { Root } from './Root.tsx';

const order = (id: string, name: string): OnlineOrder => ({
  id, createdAt: Date.now() - 120_000, status: 'new', name, phone: '0771234567', note: 'Ring the bell', total: 360000, orderNumber: null, readyBy: null, reason: null,
  lines: [{ itemId: 'devilled-chicken', qty: 2, size: 'L', adds: [], outs: ['no-onion'] }],
});

/** The shop server: the counter's login and its online orders, remembering the answers it was given. */
function shopServer() {
  const s = { open: true, orders: [order('o-aaaaaaaaaa', 'Kasun'), order('o-bbbbbbbbbb', 'Nimali')], answers: [] as unknown[] };
  const view = () => Response.json({ available: true, open: s.open, connected: true, orders: s.orders });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url === '/api/v1/login') return Response.json({ actor: { id: 's-nimal', name: 'Nimal', role: 'cashier' }, expiresAt: Date.now() + 3_600_000, serverTime: Date.now() });
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
  await user.click(screen.getByRole('button', { name: 'Not taking orders' }));
  expect(server.open).toBe(true);
  expect(await screen.findByRole('button', { name: 'Taking orders' })).toBeTruthy();
});
