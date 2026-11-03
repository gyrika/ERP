import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readAll, readStored } from './eventLog.ts';
import { TestDataTab } from './TestDataTab.tsx';

// Settings › Test data: one time, one button, then Undo (src/domain/freshStart.ts).

const owner = { id: 'o', name: 'Nisal', role: 'owner' as const };

beforeEach(() => {
  localStorage.clear();
  // A test sale already on this PC, from before the cut-off.
  localStorage.setItem('cb.events.v0', JSON.stringify([
    { id: 'test-sale', shopId: 's', at: 1000, orderNumber: 1, actor: owner, type: 'order.paid', total: 100, tender: 'cash', tendered: 100 },
  ]));
  let n = 0;
  // The shop server's /fresh-start: it writes the record and hands it back.
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.ownerPin !== '1234') return Response.json({ message: "that is not the owner's PIN" }, { status: 401 });
    return Response.json({ events: [{ id: `f${++n}`, shopId: 's', at: Date.now(), orderNumber: 0, actor: owner, type: 'shop.started_fresh', before: body.before }] });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('Clear test data: the test sale stops counting at once; Undo puts it back', async () => {
  const user = userEvent.setup();
  render(<TestDataTab ownerPin="1234" />);
  expect(screen.queryByRole('status')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Clear test data' }));

  expect((await screen.findByRole('status')).textContent).toMatch(/Test data before .* is cleared/);
  expect(readAll().map((e) => e.id)).not.toContain('test-sale');
  expect(readStored().map((e) => e.id)).toContain('test-sale'); // nothing deleted

  await user.click(screen.getByRole('button', { name: 'Undo' }));
  await vi.waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  expect(readAll().map((e) => e.id)).toContain('test-sale');
});

test("a wrong PIN says so; nothing changes", async () => {
  const user = userEvent.setup();
  render(<TestDataTab ownerPin="9999" />);
  await user.click(screen.getByRole('button', { name: 'Clear test data' }));
  expect((await screen.findByRole('alert')).textContent).toMatch("owner's PIN");
  expect(readAll().map((e) => e.id)).toContain('test-sale');
});
