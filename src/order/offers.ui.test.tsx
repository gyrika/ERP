import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// The offers sign-up on cheesybeez.com (CRM). The QR code on a receipt opens it at #offers.

vi.mock('./pwa.ts', () => ({ isOrderAppHost: () => true }));
vi.mock('./api.ts', async (real) => ({
  ...(await real<typeof import('./api.ts')>()),
  api: { pushKey: vi.fn(async () => ({ key: 'BAAA' })) },
}));
const { Offers } = await import('./Offers.tsx');

const scrolled = vi.fn();
beforeEach(() => {
  localStorage.clear();
  // A phone that can take notifications.
  Object.assign(navigator, { serviceWorker: {} });
  Object.assign(window, { PushManager: class {}, Notification: class {} });
  Element.prototype.scrollIntoView = scrolled;
});
afterEach(() => { cleanup(); scrolled.mockClear(); history.replaceState(null, '', '/'); });

test('from the receipt (#offers): the sign-up is open, ready for the number, and brought into view', async () => {
  history.replaceState(null, '', '/#offers');
  render(<Offers />);
  expect(await screen.findByRole('textbox', { name: 'Your mobile number' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Get our offers on this phone' })).toBeTruthy();
  expect(screen.getByText('A few a month. No app, no SMS, no login. Stop any time.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Turn on offers' })).toBeTruthy();
  expect(screen.getByText(/your phone asks “Allow notifications\?” Tap Allow\./)).toBeTruthy();
  expect(scrolled).toHaveBeenCalledTimes(1);
});

test('an ordinary visit: one quiet line and Get offers; nothing moves the page', async () => {
  render(<Offers />);
  expect(await screen.findByRole('button', { name: 'Get offers' })).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: 'Your mobile number' })).toBeNull();
  expect(scrolled).not.toHaveBeenCalled();
});
