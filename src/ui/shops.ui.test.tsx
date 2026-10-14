import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ShopsView } from './ShopsView.tsx';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('Shops lists every shop with its state, and each opens that shop\'s own page', async () => {
  const now = Date.now();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    latest: '1.0.5',
    shops: [
      { id: 'cheesybeez-thalwila-2862', name: 'CheesyBeez Thalwila', version: '1.0.5', update: { phase: 'done', version: '1.0.5', at: now - 600_000 }, lastSeenAt: now - 20_000, lastSaleAt: now - 300_000, eventsToday: 42 },
      { id: 'test-shop', name: 'Test shop', version: '1.0.3', update: null, lastSeenAt: null, lastSaleAt: null, eventsToday: 0 },
    ],
  })));
  render(<ShopsView onBack={() => {}} />);

  const real = await screen.findByRole('link', { name: /CheesyBeez Thalwila/ });
  expect(real.getAttribute('href')).toBe('#shops/cheesybeez-thalwila-2862');
  expect(real.textContent).toContain('Online');
  expect(real.textContent).toContain('Last sale 5 min ago · 42 events today');
  expect(screen.getByRole('link', { name: /Test shop/ }).textContent).toContain('Version 1.0.3 · 1.0.5 waiting');
  expect(screen.getByText('1 of 2 online · latest release 1.0.5')).toBeTruthy();
});

test('the cloud out of reach says so, plainly', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'the cloud answered 503' }, { status: 502 })));
  render(<ShopsView onBack={() => {}} />);
  expect((await screen.findByRole('alert')).textContent).toContain('the cloud answered 503');
});
