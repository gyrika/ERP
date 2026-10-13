import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { PullResponse, PushRequest, StreamMessage, SyncEvent, SyncTransport } from '../domain/sync.ts';
import { act, cleanup, render, screen } from '@testing-library/react';
import { startSync } from '../services/syncClient.ts';
import { SyncSign } from './SyncSign.tsx';
import { addEvents, appendEvent, markSynced, readAll, readOutbox } from './eventLog.ts';
import { readTickets } from './kitchenStore.ts';

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const flush = () => vi.advanceTimersByTimeAsync(0);

/** A server in memory: stores pushes, can go down, and lets the test send stream messages. */
function fakeServer() {
  const stored: SyncEvent[] = [];
  let down = false;
  let onMessage: ((m: StreamMessage) => void) | null = null;
  const transport: SyncTransport = {
    push: vi.fn(async (req: PushRequest) => {
      if (down) throw new Error('offline');
      req.events.forEach((e) => { if (!stored.some((s) => s.id === e.id)) stored.push(e); });
      return { accepted: req.events.map((e) => ({ id: e.id, seq: stored.findIndex((s) => s.id === e.id) + 1 })), serverTime: 0 };
    }),
    pull: vi.fn(async (after: number): Promise<PullResponse> => {
      if (down) throw new Error('offline');
      const events = stored.slice(after).map((event, i) => ({ event, deviceId: 'd', seq: after + i + 1, receivedAt: 0 }));
      return { events, lastSeq: after + events.length, more: false, serverTime: 0 };
    }),
    stream: (_after, cb) => { onMessage = cb; cb({ type: 'hello', lastSeq: stored.length, serverTime: 0 }); return () => {}; },
  };
  return { transport, stored, setDown: (v: boolean) => { down = v; }, send: (m: StreamMessage) => onMessage?.(m) };
}

const sent = (id: string, ticketId: string): SyncEvent => ({
  id, shopId: 'shop', at: Date.now(), actor: { id: 'a', name: 'A', role: 'cashier' }, orderNumber: 2001,
  type: 'order.sent', ticketId, lines: [{ id: `l-${id}`, itemId: 'margherita', qty: 1, size: 'M', adds: [], outs: [], sent: true }], addOn: false,
});

test('a new event goes to the server and leaves the outbox only once confirmed', async () => {
  const server = fakeServer();
  const stop = startSync(server.transport);
  await flush();
  const e = appendEvent({ type: 'kitchen.seen', at: 1, orderNumber: 1001, ticketId: 't' });
  expect(readOutbox()).toEqual([e.id]);
  await flush();
  expect(server.stored.map((s) => s.id)).toEqual([e.id]);
  expect(readOutbox()).toEqual([]);
  stop();
});

test('offline: the sale is kept, and pushed after the back-off once the server is back', async () => {
  const server = fakeServer();
  server.setDown(true);
  const stop = startSync(server.transport);
  appendEvent({ type: 'kitchen.seen', at: 1, orderNumber: 1001, ticketId: 't' });
  await flush();
  expect(server.stored).toEqual([]);
  expect(readOutbox()).toHaveLength(1);

  server.setDown(false);
  await vi.advanceTimersByTimeAsync(5000);
  expect(server.stored).toHaveLength(1);
  expect(readOutbox()).toEqual([]);
  stop();
});

test('events from other devices arrive once and show on the kitchen screen', async () => {
  const server = fakeServer();
  server.stored.push(sent('remote-1', 'tk-1'));
  const stop = startSync(server.transport);
  await flush();
  expect(readTickets().map((t) => t.number)).toEqual([2001]);

  const live = sent('remote-2', 'tk-2');
  server.send({ type: 'event', data: { event: live, deviceId: 'd', seq: 2, receivedAt: 0 } });
  server.send({ type: 'event', data: { event: live, deviceId: 'd', seq: 2, receivedAt: 0 } });
  expect(readAll().filter((e) => e.id === 'remote-2')).toHaveLength(1);
  expect(readTickets()).toHaveLength(2);
  expect(readOutbox()).toEqual([]); // events from elsewhere are never pushed back
  stop();
});

test('demo events are never queued for the server', () => {
  addEvents([sent('demo-1', 'tk')]);
  expect(readOutbox()).toEqual([]);
});

test('synced catalog creation events stay local after routine events are pruned', () => {
  const actor = { id: 'manager', name: 'Ravi', role: 'manager' as const };
  addEvents([
    {
      id: 'old-item',
      shopId: 'shop',
      at: 1,
      orderNumber: 0,
      actor,
      type: 'stock.item_added',
      item: {
        id: 'inv-new',
        name: 'Sea Salt',
        category: 'General',
        baseUnit: 'pcs',
        packQty: 1,
        supplierIds: ['sup-new'],
        workingPriceCents: 0,
      },
    },
    {
      id: 'old-supplier',
      shopId: 'shop',
      at: 1,
      orderNumber: 0,
      actor,
      type: 'stock.supplier_added',
      supplier: { id: 'sup-new', name: 'Fresh Farms' },
      linkedItemIds: [],
    },
    { ...sent('old-order', 'old-ticket'), at: 1 },
  ]);

  markSynced([], Date.now());

  expect(readAll().map((event) => event.id)).toEqual(['old-item', 'old-supplier']);
});

test('offline sign: how many orders wait, and gone once they are sent', async () => {
  const server = fakeServer();
  server.setDown(true);
  const stop = startSync(server.transport);
  render(<SyncSign />);
  await act(async () => {
    appendEvent({ type: 'kitchen.seen', at: 1, orderNumber: 1001, ticketId: 't' });
    appendEvent({ type: 'kitchen.bumped', at: 2, orderNumber: 1001, ticketId: 't' });
    appendEvent({ type: 'kitchen.seen', at: 3, orderNumber: 1002, ticketId: 'u' });
    await flush();
  });
  expect(screen.getByRole('status').textContent).toBe('Offline · 2 orders waiting');

  server.setDown(false);
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(screen.queryByRole('status')).toBeNull();
  stop();
});
