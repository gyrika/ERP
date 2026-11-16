import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BillLine } from './SetupWizard.tsx';
import { setupClient } from '../services/setupClient.ts';
import { readStored } from './eventLog.ts';

// Settings › Printer: the owner's line on every bill (SCRUM-256).

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test("the owner types his line and saves it with his PIN; Sinhala is refused before it reaches the printer", async () => {
  const user = userEvent.setup();
  const call = vi.spyOn(setupClient, 'billLine').mockImplementation(async (text) => ({
    events: [{ id: 'b1', shopId: 's', at: 1, orderNumber: 0, actor: { id: 'o', name: 'Owner', role: 'owner' }, type: 'shop.bill_line_set', text }],
  }));
  render(<BillLine ownerPin="1234" />);
  const field = screen.getByLabelText('Your line on every bill');
  await user.type(field, 'ස්තූතියි');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByRole('alert').textContent).toMatch(/English letters/);
  expect(call).not.toHaveBeenCalled();

  await user.clear(field);
  await user.type(field, 'Fresh dough every morning');
  expect(screen.getByText(/71 letters left/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(call).toHaveBeenCalledWith('Fresh dough every morning', '1234');
  expect(readStored().some((e) => e.type === 'shop.bill_line_set')).toBe(true);
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true); // saved: nothing new to save
});
