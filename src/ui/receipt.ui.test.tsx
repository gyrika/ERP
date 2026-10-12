import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { printReceipt } from '../services/printer.ts';
import { App } from './App.tsx';

// A paired counter: printing goes through the (mocked) server.
vi.mock('../services/printer.ts', () => ({ canPrint: () => true, printReceipt: vi.fn() }));
const print = vi.mocked(printReceipt);

beforeEach(() => { localStorage.clear(); print.mockReset(); print.mockResolvedValue('printed'); });
afterEach(cleanup);

const panel = () => within(screen.getByRole('complementary', { name: 'Current order' }));

const sellOne = async (user: ReturnType<typeof userEvent.setup>, how: RegExp | string) => {
  await user.click(screen.getAllByRole('button', { name: 'L 2500' })[0]);
  await user.click(panel().getByRole('button', { name: 'Send to kitchen' }));
  await user.click(panel().getByRole('button', { name: /^1001/ }));
  await user.click(panel().getByRole('button', { name: 'Charge' }));
  await user.click(screen.getByRole('button', { name: how }));
};

test('paying prints the receipt by itself; Print again prints a copy', async () => {
  const user = userEvent.setup();
  render(<App />);
  await sellOne(user, /Exact/);

  expect(print).toHaveBeenCalledTimes(1);
  expect(print.mock.calls[0][0]).toMatchObject({ number: 1001, tender: 'cash', total: 250000 });
  expect(print.mock.calls[0][2]).toEqual({ reprint: false });
  expect(panel().queryByText('Receipt not printed')).toBeNull();

  await user.click(panel().getByRole('button', { name: 'Print again' }));
  expect(print).toHaveBeenCalledTimes(2);
  expect(print.mock.calls[1][2]).toEqual({ reprint: true });
});

test('a failed print says so quietly, and Print again retries', async () => {
  print.mockResolvedValueOnce('failed');
  const user = userEvent.setup();
  render(<App />);
  await sellOne(user, 'Bank transfer');

  expect(await panel().findByText('Receipt not printed')).toBeTruthy();
  await user.click(panel().getByRole('button', { name: 'Print again' }));
  expect(print).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => expect(panel().queryByText('Receipt not printed')).toBeNull());
});
