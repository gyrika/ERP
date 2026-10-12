import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SyncEvent, SyncedEvent } from './sync.ts';
import { clockOffsetMs, newRemoteEvents, pendingEvents, retryDelayMs, syncStatus } from './sync.ts';

const ev = (id: string): SyncEvent =>
  ({ id, shopId: 'shop-1', at: 0, orderNumber: 1001, ticketId: 't1', type: 'kitchen.seen' });
const synced = (id: string, seq: number): SyncedEvent => ({ event: ev(id), deviceId: 'd1', seq, receivedAt: 0 });

test('pending: only unconfirmed events, oldest first, one batch at a time', () => {
  const local = ['a', 'b', 'c', 'd'].map(ev);
  assert.deepEqual(pendingEvents(local, new Set(['b'])).map((e) => e.id), ['a', 'c', 'd']);
  assert.deepEqual(pendingEvents(local, new Set(), 2).map((e) => e.id), ['a', 'b']);
  assert.deepEqual(pendingEvents(local, new Set(['a', 'b', 'c', 'd'])), []);
});

test('remote: applied in server order, never twice', () => {
  const incoming = [synced('c', 7), synced('a', 3), synced('b', 5), synced('a', 3)];
  assert.deepEqual(newRemoteEvents(new Set(['b']), incoming).map((s) => s.event.id), ['a', 'c']);
});

test('retry backs off 1 s, 2 s, 4 s … and never waits more than a minute', () => {
  assert.deepEqual([0, 1, 2, 3].map(retryDelayMs), [1000, 2000, 4000, 8000]);
  assert.equal(retryDelayMs(20), 60_000);
});

test('clock offset from one round trip', () => {
  // Sent at 1000, answered at 1200 (device clock); server said 5100 → device is 4000 ms behind.
  assert.equal(clockOffsetMs(5100, 1000, 1200), 4000);
});

test('status: offline beats pending beats synced', () => {
  assert.equal(syncStatus(false, 0), 'offline');
  assert.equal(syncStatus(true, 3), 'pending');
  assert.equal(syncStatus(true, 0), 'synced');
});
