import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { UpdateScreen } from './UpdateScreen.tsx';

/** What the shop server's health check answers right now; 'down' is the installer having stopped it. */
let health: object | 'down' = 'down';
const step = (phase: string, percent: number) => ({ phase, percent, version: '1.0.10', at: Date.now() });

beforeEach(() => {
  health = 'down';
  sessionStorage.clear();
  history.replaceState(null, '', '/');
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (health === 'down') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(health), { status: 200 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** The server answers this from now on; give the screen time for a few looks. */
const answer = (h: object | 'down') => act(async () => { health = h; await new Promise((r) => setTimeout(r, 40)); });
const show = (props: Partial<Parameters<typeof UpdateScreen>[0]> = {}) => render(<UpdateScreen reload={() => {}} idleMs={5} activeMs={5} {...props} />);

test('an update the counter can follow: notice while downloading, whole screen through the restart, then reload into the new version', async () => {
  const reload = vi.fn();
  show({ reload });
  await answer({ ok: true, version: '1.0.9' });
  expect(screen.queryByRole('status')).toBeNull();
  await answer({ ok: true, version: '1.0.9', update: step('downloading', 32) });
  expect(screen.getByRole('status').textContent).toBe('Update 1.0.10 is downloading (49%). The POS restarts in about a minute.');
  await answer({ ok: true, version: '1.0.9', update: step('backup', 61) });
  expect(screen.getByRole('status').textContent).toMatch(/^Saving a backup before update 1.0.10/);
  await answer('down');
  expect(screen.getByRole('dialog', { name: 'Updating CheesyBeez' })).toBeTruthy();
  expect(screen.getByText('Installing version 1.0.10')).toBeTruthy();
  expect(screen.getByText(/Orders already taken are safe/)).toBeTruthy();
  expect(reload).not.toHaveBeenCalled();
  await answer({ ok: true, version: '1.0.10', update: step('starting', 85) });
  expect(reload).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem('cb.updatedTo')).toBe('1.0.10');
});

test('after the reload: "Updated to 1.0.10" for a moment', () => {
  sessionStorage.setItem('cb.updatedTo', '1.0.10');
  show();
  expect(screen.getByRole('status').textContent).toBe('Updated to 1.0.10');
});

test('the new version does not start: the screen says it is going back, through the second restart', async () => {
  show();
  await answer({ ok: true, version: '1.0.9' });
  await answer({ ok: true, version: '1.0.9', update: step('going-back', 90) });
  await answer('down');
  expect(screen.getByRole('dialog', { name: 'Going back to the previous version' })).toBeTruthy();
  expect(screen.getByText('Version 1.0.10 did not start. This takes a few minutes.')).toBeTruthy();
  await answer({ ok: true, version: '1.0.9' });
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('a server that is simply down shows nothing here', async () => {
  show();
  await answer('down');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
});

test('a window brought back from minimised looks at once, not at its next slowed-down timer', async () => {
  const reload = vi.fn();
  health = { ok: true, version: '1.0.9' };
  show({ reload, idleMs: 60_000 });
  await answer({ ok: true, version: '1.0.10' });
  expect(reload).not.toHaveBeenCalled();
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await new Promise((r) => setTimeout(r, 20)); });
  expect(reload).toHaveBeenCalledTimes(1);
});
