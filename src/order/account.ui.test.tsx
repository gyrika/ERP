import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Account } from '../domain/accounts.ts';
import { setMenuState } from '../domain/menu.ts';
import { EMPTY_MENU_STATE } from '../domain/menuEdits.ts';
import { OrderSite } from './OrderSite.tsx';

/** The cloud as the page sees it: accounts on or off, signed in or not, and what the page sent. */
let google: string | null = null;
let account: Account | null = null;
let sent: { url: string; body: Record<string, unknown> | null }[] = [];

const kasun = (over: Partial<Account> = {}): Account => ({
  profile: { name: 'Kasun Perera', phone: '0771234567', email: 'kasun@example.com' },
  addresses: [
    { id: 'adr-home', label: 'Home', address: '12 Temple Rd, Thalwila', pin: { lat: 7.01, lng: 79.91 }, lastUsedAt: 2 },
    { id: 'adr-work', label: '', address: 'Office, 4 Lake Rd, Marawila', pin: null, lastUsedAt: 1 },
  ],
  orders: [{
    id: 'o-111111111', createdAt: Date.UTC(2026, 10, 10, 13), kind: 'pickup', status: 'collected', total: 320000, orderNumber: 41,
    lines: [{ itemId: 'margherita', qty: 1, size: 'L', adds: [], outs: [] }, { itemId: 'gone-dish', qty: 1, adds: [], outs: [] }],
  }],
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, '');
  setMenuState(EMPTY_MENU_STATE);
  google = null;
  account = null;
  sent = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    if (init?.method === 'POST') sent.push({ url, body });
    if (url === '/api/v1/shop') return Response.json({ name: 'CheesyBeez Thalwila', open: true, delivery: { perKm: 5000, maxKm: 5 } });
    if (url === '/api/v1/account') return Response.json({ google, account });
    if (url === '/api/v1/delivery-quote') return Response.json({ km: 1.4, fee: 10000 });
    if (url === '/api/v1/account/profile') { account = { ...account!, profile: { ...account!.profile, name: String(body!.name), phone: '0779999999' } }; return Response.json({ account }); }
    if (url === '/api/v1/account/addresses/remove') { account = { ...account!, addresses: account!.addresses.filter((a) => a.id !== body!.id) }; return Response.json({ account }); }
    if (url === '/api/v1/account/sign-out') return Response.json({ ok: true });
    if (url === '/api/v1/account/delete') return Response.json({ deleted: true });
    if (url === '/api/v1/orders') return Response.json({ id: 'o-aaaaaaaaaa', token: 't', total: 0 });
    throw new Error(`unexpected ${url}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setMenuState(EMPTY_MENU_STATE); });

test('accounts off: no Sign in anywhere, ordering as before', async () => {
  render(<OrderSite />);
  await screen.findByText((_, el) => el?.classList.contains('o-pill--open') ?? false);
  await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/v1/account')).toBe(true));
  expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
});

test('signed out: Sign in opens the sheet with Google and says ordering still works without it', async () => {
  google = 'client.apps.googleusercontent.com';
  const user = userEvent.setup();
  render(<OrderSite />);
  await user.click(await screen.findByRole('button', { name: 'Sign in' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Your account' }));
  expect(sheet.getByText('You can still order without signing in.')).toBeTruthy();
  // Google's own script is asked for only now, from Google.
  expect([...document.querySelectorAll('script')].some((s) => s.src === 'https://accounts.google.com/gsi/client')).toBe(true);
});

test('signed in: initials in the header; Order again puts what is on today in the basket and opens checkout, filled in', async () => {
  google = 'client.apps.googleusercontent.com';
  account = kasun();
  const user = userEvent.setup();
  render(<OrderSite />);
  await user.click(await screen.findByRole('button', { name: 'Your account, Kasun Perera' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Your account' }));
  expect(sheet.getByRole('heading', { name: 'Hi, Kasun' })).toBeTruthy();
  expect(sheet.getByText(/a dish no longer on the menu/)).toBeTruthy();
  await user.click(sheet.getByRole('button', { name: 'Order again (what is on today)' }));

  const checkout = within(screen.getByRole('dialog', { name: 'Your order' }));
  expect(checkout.getAllByText(/Margherita/).length).toBeGreaterThan(0);
  expect((checkout.getByLabelText('Your name') as HTMLInputElement).value).toBe('Kasun Perera');
  expect((checkout.getByLabelText('Phone number') as HTMLInputElement).value).toBe('0771234567');
});

test('delivery when signed in: the newest address is filled and priced from its pin; another saved one is one tap', async () => {
  google = 'client.apps.googleusercontent.com';
  account = kasun();
  localStorage.setItem('cb.order.kind', JSON.stringify('delivery'));
  localStorage.setItem('cb.order.basket', JSON.stringify([{ itemId: 'margherita', qty: 1, size: 'L', adds: [], outs: [] }]));
  const user = userEvent.setup();
  render(<OrderSite />);
  await user.click(await screen.findByRole('button', { name: /View order/ }));
  const checkout = within(screen.getByRole('dialog', { name: 'Your order' }));
  expect((checkout.getByLabelText('Delivery address') as HTMLTextAreaElement).value).toBe('12 Temple Rd, Thalwila');
  expect(await checkout.findByText(/Location added/)).toBeTruthy();
  expect(sent.find((s) => s.url === '/api/v1/delivery-quote')?.body).toEqual({ pin: { lat: 7.01, lng: 79.91 } });

  const saved = within(checkout.getByRole('group', { name: 'Your saved addresses' }));
  await user.click(saved.getByRole('button', { name: 'Office, 4 Lake Rd, Mara…' }));
  expect((checkout.getByLabelText('Delivery address') as HTMLTextAreaElement).value).toBe('Office, 4 Lake Rd, Marawila');
  expect(checkout.getByRole('button', { name: /Share my location/ })).toBeTruthy();
});

test('details, addresses and leaving: save a change, remove an address, delete takes a second tap', async () => {
  google = 'client.apps.googleusercontent.com';
  account = kasun();
  const user = userEvent.setup();
  render(<OrderSite />);
  await user.click(await screen.findByRole('button', { name: 'Your account, Kasun Perera' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Your account' }));
  expect(sheet.queryByRole('button', { name: 'Save' })).toBeNull();
  const name = sheet.getByLabelText('Your name');
  await user.clear(name);
  await user.type(name, 'Kasun P');
  await user.click(sheet.getByRole('button', { name: 'Save' }));
  expect(sent.find((s) => s.url === '/api/v1/account/profile')?.body).toEqual({ name: 'Kasun P', phone: '077 123 4567' });

  await user.click(sheet.getByRole('button', { name: 'Remove Home' }));
  expect(sheet.queryByText('12 Temple Rd, Thalwila')).toBeNull();
  expect(sheet.getByRole('link', { name: 'Download my data' }).getAttribute('href')).toBe('/api/v1/account/export');

  await user.click(sheet.getByRole('button', { name: 'Delete my account' }));
  expect(sent.some((s) => s.url === '/api/v1/account/delete')).toBe(false);
  await user.click(sheet.getByRole('button', { name: 'Tap again to delete everything' }));
  expect(sent.some((s) => s.url === '/api/v1/account/delete')).toBe(true);
  expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
  expect(screen.queryByRole('dialog', { name: 'Your account' })).toBeNull();
});
