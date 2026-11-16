import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App } from './App.tsx';
import { SHOW_AFTER_MS } from './KeyHints.tsx';

// Hold Alt: every key on the screen shows (SCRUM-245); letting go hides it.

beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const keysOn = () => document.documentElement.dataset.keys === 'on';
const hold = () => fireEvent.keyDown(window, { key: 'Alt', altKey: true });
const release = () => fireEvent.keyUp(window, { key: 'Alt' });

test('held, the keys show; let go, they hide', () => {
  render(<App />);
  hold();
  expect(keysOn()).toBe(false); // not on a quick press
  act(() => { vi.advanceTimersByTime(SHOW_AFTER_MS); });
  expect(keysOn()).toBe(true);
  expect(document.querySelector('.keylegend')?.textContent).toContain('Ctrl ZUndo');
  expect(document.querySelector('.keylegend')?.closest('[aria-hidden]')).toBeTruthy();
  release();
  expect(keysOn()).toBe(false);
});

test('a quick Alt+1 never flashes the keys, and still picks the first menu tab', () => {
  render(<App />);
  hold();
  fireEvent.keyDown(window, { key: '1', altKey: true });
  release();
  act(() => { vi.advanceTimersByTime(SHOW_AFTER_MS * 2); });
  expect(keysOn()).toBe(false);
  expect(screen.getAllByRole('button', { pressed: true })[0].getAttribute('data-keyhint')).toBe('1');
});

test('Alt+Tab away (no keyup comes): the keys hide', () => {
  render(<App />);
  hold();
  act(() => { vi.advanceTimersByTime(SHOW_AFTER_MS); });
  expect(keysOn()).toBe(true);
  fireEvent.blur(window);
  expect(keysOn()).toBe(false);
});

test('Alt alone does not hand focus to the browser menu', () => {
  render(<App />);
  const down = new KeyboardEvent('keydown', { key: 'Alt', cancelable: true });
  window.dispatchEvent(down);
  expect(down.defaultPrevented).toBe(true);
  const up = new KeyboardEvent('keyup', { key: 'Alt', cancelable: true });
  window.dispatchEvent(up);
  expect(up.defaultPrevented).toBe(true);
});
