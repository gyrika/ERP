import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as serverAuth from '../services/serverAuth.ts';
import { OwnerShell } from './OwnerShell.tsx';
import { Root } from './Root.tsx';
import { clearBadges, setBadge } from './shellBadges.ts';

// The owner area: the menu on the left, the chosen tab on the right.

beforeEach(() => { localStorage.clear(); clearBadges(); history.replaceState(null, '', '/'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const shell = (props: Partial<Parameters<typeof OwnerShell>[0]> = {}) =>
  render(<OwnerShell current="owner" onRegister={() => {}} {...props}><main aria-label="Panel">the tab</main></OwnerShell>);

test('the menu lists every tab with the current one marked; the tab shows on the right', () => {
  shell({ current: 'menu' });
  const nav = within(screen.getByRole('navigation', { name: 'Owner sections' }));
  expect(nav.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['#owner', '#manager', '#menu', '#recipes', '#inventory', '#suppliers', '#setup']);
  expect(nav.getByRole('link', { name: 'Menu' }).getAttribute('aria-current')).toBe('page');
  expect(screen.getByRole('main', { name: 'Panel' }).textContent).toBe('the tab');
  expect(screen.getByRole('button', { name: 'Register' })).toBeTruthy();
});

test('on a narrow screen the Menu button opens the drawer; Esc, the dark side or a tab closes it', async () => {
  const user = userEvent.setup();
  const { container } = shell();
  const toggle = screen.getByRole('button', { name: 'Open menu' });
  const open = () => container.querySelector('.oshell')!.getAttribute('data-open');
  expect([open(), toggle.getAttribute('aria-expanded')]).toEqual(['false', 'false']);
  await user.click(toggle);
  expect([open(), toggle.getAttribute('aria-expanded')]).toEqual(['true', 'true']);
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Owner'); // the keyboard lands on the current tab
  await user.keyboard('{Escape}');
  expect(open()).toBe('false');
  await user.click(toggle);
  await user.click(container.querySelector('.oshell__scrim')!);
  expect(open()).toBe('false');
  await user.click(toggle);
  await user.click(screen.getByRole('link', { name: 'Suppliers' }));
  expect(open()).toBe('false');
});

test('keyboard: Ctrl+number jumps to a tab; up and down move along the menu', async () => {
  const user = userEvent.setup();
  shell();
  await user.keyboard('{Control>}5{/Control}');
  expect(location.hash).toBe('#inventory');
  screen.getByRole('link', { name: 'Owner' }).focus();
  await user.keyboard('{ArrowDown}');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Manager');
  await user.keyboard('{ArrowUp}{ArrowUp}');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Shop setup'); // round the end
});

test('a small number shows where something waits, without changing the tab\'s name', () => {
  shell();
  expect(document.querySelector('.oshell__badge')).toBeNull();
  act(() => { setBadge('inventory', 3); setBadge('owner', 2); });
  const inventory = screen.getByRole('link', { name: 'Inventory' });
  expect(document.getElementById(inventory.getAttribute('aria-describedby')!)!.textContent).toBe('3 to order');
  expect(document.getElementById(screen.getByRole('link', { name: 'Owner' }).getAttribute('aria-describedby')!)!.textContent).toBe('2 to look at');
  act(() => setBadge('inventory', 0));
  expect(screen.getByRole('link', { name: 'Inventory' }).getAttribute('aria-describedby')).toBeNull();
});

test('the person signed in is at the bottom, with Switch user', async () => {
  vi.spyOn(serverAuth, 'signedIn').mockReturnValue({ id: 's1', name: 'Ravi', role: 'manager' });
  const user = userEvent.setup();
  const onSwitch = vi.fn();
  const { container } = shell({ onSwitch });
  const who = within(container.querySelector<HTMLElement>('.oshell__who')!);
  expect(who.getByText('Ravi')).toBeTruthy();
  await user.click(who.getByRole('button', { name: 'Switch user' }));
  expect(onSwitch).toHaveBeenCalledTimes(1);
});

test('the Register, the Kitchen and the receipt preview have no owner menu', () => {
  for (const hash of ['', '#kitchen', '#receipt']) {
    history.replaceState(null, '', `/${hash}`);
    const { unmount } = render(<Root />);
    expect(screen.queryByRole('navigation', { name: 'Owner sections' })).toBeNull();
    unmount();
  }
  history.replaceState(null, '', '/#owner');
  render(<Root />);
  expect(screen.getByRole('navigation', { name: 'Owner sections' })).toBeTruthy();
});
