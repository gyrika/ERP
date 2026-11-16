import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App.tsx';
import { setKitchenScreen } from './kitchenScreen.ts';
import { heldList } from './testHeld.ts';

// The bill flies to the list (SCRUM-246): leaving the right panel, it lands on its row on the left.
// jsdom has no Web Animations, so only the landing (the row's glow) shows here, as with reduced motion.

beforeEach(() => { localStorage.clear(); setKitchenScreen(true); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const row = (n: number) => document.querySelector(`[data-rail-order="${n}"]`)!;
const landed = (n: number) => Boolean(row(n)?.classList.contains('rail__row--landed'));

test('Send: the bill leaves the panel and lands on its row', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getAllByRole('button', { name: 'L 2,500' })[0]);
  expect(landed(1001)).toBe(false); // the first item only starts the bill
  await user.click(screen.getByRole('button', { name: 'Send to kitchen' }));
  expect(landed(1001)).toBe(true);
});

test('New order (Esc): the bill on screen lands on its row; an empty one goes nowhere', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getAllByRole('button', { name: 'L 2,500' })[0]);
  await user.keyboard('{Escape}');
  expect(landed(1001)).toBe(true);
  // Opening it from the list and back to an empty order: nothing flies from an empty panel.
  await user.click(heldList().getByRole('button', { name: /^1001/ }));
  expect(document.querySelectorAll('.obadge--flying')).toHaveLength(0);
});

test('only the first time: a bill opened again from the list and left does not fly again (SCRUM-250)', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getAllByRole('button', { name: 'L 2,500' })[0]);
  await user.keyboard('{Escape}');
  expect(landed(1001)).toBe(true); // first time: it flies
  row(1001).classList.remove('rail__row--landed');
  await user.click(heldList().getByRole('button', { name: /^1001/ }));
  await user.keyboard('{Escape}');
  expect(landed(1001)).toBe(false); // seen it once: no flight, no glow
});

test('with Web Animations: a copy of the badge flies, then is gone', async () => {
  let finish: (() => void) | undefined;
  const animate = vi.fn(function () { const a = { onfinish: null as null | (() => void), oncancel: null }; finish = () => a.onfinish?.(); return a; });
  Object.defineProperty(HTMLElement.prototype, 'animate', { value: animate, configurable: true });
  const rect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () { return { left: 10, top: 10, width: 80, height: 60, right: 90, bottom: 70, x: 10, y: 10, toJSON() {} } as DOMRect; };
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getAllByRole('button', { name: 'L 2,500' })[0]);
  await user.click(screen.getByRole('button', { name: 'Send to kitchen' }));
  const ghost = document.querySelector('.obadge--flying')!;
  expect(ghost.textContent).toContain('1001');
  expect(ghost.getAttribute('aria-hidden')).toBe('true');
  finish!();
  expect(document.querySelector('.obadge--flying')).toBeNull();
  expect(landed(1001)).toBe(true);
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
  Element.prototype.getBoundingClientRect = rect;
});
