import { afterEach, expect, test } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppInstall } from './AppInstall.tsx';

// The QR code on the bill opens cheesybeez.com at #app (SCRUM-257): how to put the app on this phone.

afterEach(() => { cleanup(); history.replaceState(null, '', '/'); });

test('not from the bill: nothing', () => {
  render(<AppInstall />);
  expect(screen.queryByRole('region', { name: 'Get the CheesyBeez app' })).toBeNull();
});

test('from the bill, a browser that offers it: one Install button; × hides it and drops #app', async () => {
  history.replaceState(null, '', '/#app');
  const user = userEvent.setup();
  render(<AppInstall />);
  const card = screen.getByRole('region', { name: 'Get the CheesyBeez app' });
  expect(card.textContent).toMatch(/Add to Home screen/); // before the browser offers it: the menu way
  let prompted = false;
  const offer = Object.assign(new Event('beforeinstallprompt'), { prompt: async () => { prompted = true; } });
  act(() => { window.dispatchEvent(offer); });
  await user.click(screen.getByRole('button', { name: 'Install app' }));
  expect(prompted).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('region', { name: 'Get the CheesyBeez app' })).toBeNull();
  expect(location.hash).toBe('');
});

test('from the bill on an iPhone: the two taps', () => {
  history.replaceState(null, '', '/#app');
  const ua = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent');
  Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', configurable: true });
  render(<AppInstall />);
  expect(screen.getByText('Share')).toBeTruthy();
  expect(screen.getByText('Add to Home Screen')).toBeTruthy();
  if (ua) Object.defineProperty(navigator, 'userAgent', ua); else delete (navigator as { userAgent?: string }).userAgent;
});
