import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { SyncEvent } from '../domain/sync.ts';
import { pairFromUrl } from '../services/pairing.ts';
import { shopSource } from '../services/ownerData.ts';
import { Root } from './Root.tsx';

const sale = (n: number): SyncEvent => ({
  type: 'order.paid', id: `p${n}`, shopId: 'shop', at: Date.now(), orderNumber: 1000 + n,
  actor: { id: 'n', name: 'Nimal', role: 'cashier' }, total: 250000, tender: 'cash', tendered: 250000,
});

/** The cloud's GET /api/v1/events, holding `stored`; records every `after` it was asked for. */
const cloud = (stored: SyncEvent[], status = 200) => {
  const asked: number[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    const after = Number(new URL(url, 'https://cloud.test').searchParams.get('after'));
    asked.push(after);
    if (status !== 200) return new Response('{}', { status });
    const events = stored.slice(after).map((event, i) => ({ event, deviceId: 'd', seq: after + i + 1, receivedAt: 0 }));
    return Response.json({ events, lastSeq: after + events.length, more: false, serverTime: 0 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return asked;
};

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv('VITE_SITE', 'cloud');
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

test('the cloud site without an owner link: a welcome, no register, no shop data', () => {
  render(<Root />);
  expect(screen.getByRole('heading', { name: "The owner's page" })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'See the demo' })).toBeTruthy();
  expect(screen.queryByRole('complementary', { name: 'Current order' })).toBeNull();
});

test("the owner's link: kept on the phone, taken out of the address bar, then the feed", async () => {
  cloud([sale(1), sale(2)]);
  history.replaceState(null, '', '/?owner=secret-owner-token#owner');
  pairFromUrl();
  expect(location.search).toBe('');
  expect(localStorage.getItem('cb.owner.token')).toBe('secret-owner-token');

  render(<Root />);
  expect(await screen.findByRole('button', { name: /^Sales today Rs 5,000/ })).toBeTruthy();
  expect(await screen.findByText('2 orders', undefined, { timeout: 3000 })).toBeTruthy(); // once counted up
  // No counter screens on a phone: the black screen explains, but links nowhere.
  expect(screen.queryByRole('link', { name: /See the records/ })).toBeNull();
  expect(screen.queryByRole('navigation', { name: 'Owner sections' })).toBeNull(); // no counter screens on a phone
  expect(screen.getByText(/^Updated /)).toBeTruthy();
});

test('after the first load, only what is new is fetched', async () => {
  localStorage.setItem('cb.owner.token', 'secret');
  const stored = [sale(1), sale(2)];
  const asked = cloud(stored);
  const source = shopSource();
  const first = await source.next(0);
  expect(first.events).toHaveLength(2);
  stored.push(sale(3));
  const more = await source.next(first.cursor);
  expect(more.events.map((e) => e.id)).toEqual(['p3']);
  expect(asked).toEqual([0, 2]);
});

test('a link that was withdrawn says so plainly', async () => {
  localStorage.setItem('cb.owner.token', 'old');
  cloud([], 401);
  render(<Root />);
  expect(await screen.findByText('This link is no longer valid. Ask for a new one.')).toBeTruthy();
});
