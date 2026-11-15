import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { CrashScreen } from './CrashScreen.tsx';

const Broken = (): never => { throw new Error('Unknown menu item: new-egg-kottu'); };

test('a screen that fails to draw shows why and Reload, never an empty window', () => {
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
  render(<CrashScreen><Broken /></CrashScreen>);
  expect(screen.getByRole('heading', { name: 'This screen could not open' })).toBeTruthy();
  expect(screen.getByText('Unknown menu item: new-egg-kottu')).toBeTruthy();
  const reload = screen.getByRole('button', { name: 'Reload' });
  expect(document.activeElement).toBe(reload);
  quiet.mockRestore();
});
