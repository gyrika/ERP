import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Offer } from './offersInbox.ts';

// The offers inbox on cheesybeez.com (CRM): the offers this phone received, under a bell.

const NOW = Date.now();
const kept = vi.hoisted(() => ({ list: [] as Offer[], message: null as ((k: 'new' | 'open') => void) | null }));
vi.mock('./offersInbox.ts', async (real) => ({
  ...(await real<typeof import('./offersInbox.ts')>()),
  readOffers: async () => kept.list,
  onOfferMessage: (cb: (k: 'new' | 'open') => void) => { kept.message = cb; return () => {}; },
}));
const stop = vi.hoisted(() => vi.fn());
vi.mock('./Offers.tsx', async (real) => ({ ...(await real<typeof import('./Offers.tsx')>()), stopOffers: stop }));
const { OffersBell } = await import('./OffersInbox.tsx');

const offer = (id: string, title: string, hoursAgo: number): Offer => ({ id, title, body: `${title} body`, at: NOW - hoursAgo * 3_600_000 });

beforeEach(() => {
  localStorage.clear();
  kept.list = [offer('a', 'Weekend offer', 1), offer('b', 'We miss you at CheesyBeez', 100)];
});
afterEach(() => { cleanup(); stop.mockClear(); history.replaceState(null, '', '/'); });

test('no offers on this phone: no bell at all', async () => {
  kept.list = [];
  const { container } = render(<OffersBell />);
  await Promise.resolve();
  expect(container.innerHTML).toBe('');
});

test('offers on: the bell counts what is new; the list, newest first, marks it; opened, they are no longer new', async () => {
  localStorage.setItem('cb.order.offers', JSON.stringify({ phone: '+94771234567' }));
  localStorage.setItem('cb.order.offersSeen', String(NOW - 10 * 3_600_000)); // last opened 10 hours ago
  const user = userEvent.setup();
  render(<OffersBell />);
  await user.click(await screen.findByRole('button', { name: 'Your offers, 1 new' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Your offers' }));
  const items = sheet.getAllByRole('listitem');
  expect(items.map((li) => li.querySelector('b')?.textContent)).toEqual(['Weekend offer', 'We miss you at CheesyBeez']);
  expect(within(items[0]).getByText('New')).toBeTruthy();
  expect(within(items[1]).queryByText('New')).toBeNull();
  expect(sheet.getByText(/^Today, /)).toBeTruthy();
  expect(sheet.getByText(/Offers on 077 123 4567/)).toBeTruthy();
  await user.click(sheet.getByRole('button', { name: 'Order now' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('button', { name: 'Your offers' })).toBeTruthy();
});

test('a tapped notification opens the list (#inbox, or a message to the open page); Stop offers is there', async () => {
  localStorage.setItem('cb.order.offers', JSON.stringify({ phone: '+94771234567' }));
  history.replaceState(null, '', '/#inbox');
  const user = userEvent.setup();
  render(<OffersBell />);
  expect(await screen.findByRole('dialog', { name: 'Your offers' })).toBeTruthy();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(location.hash).toBe('');
  kept.message!('open');
  const sheet = within(await screen.findByRole('dialog', { name: 'Your offers' }));
  await user.click(sheet.getByRole('button', { name: 'Stop offers' }));
  expect(stop).toHaveBeenCalledTimes(1);
});
