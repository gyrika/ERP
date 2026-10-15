import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SyncEvent } from '../src/domain/sync.ts';
import { startManagerInbox, takesFromPhone } from './managerInbox.ts';
import type { Device } from './store.ts';

// The manager phones' counts, from the cloud's inbox into the shop (SCRUM-94).

const SHOP = 'shop-a';
const ravi = { id: 'staff-ravi', name: 'Ravi', role: 'manager' as const };
const counted = (id: string, actor: { id: string; name: string; role: string } = ravi): SyncEvent => ({
  id, shopId: SHOP, at: 5000, orderNumber: 0, actor, type: 'stock.counted', itemId: 'inv-0006',
  counted: 1000, expected: 2000, entries: [], reason: 'unknown', valueCents: -260000, tier: 'daily',
} as SyncEvent);

test('what the shop takes from a phone: stock by a manager or owner; count lists by an owner', () => {
  assert.equal(takesFromPhone(counted('a')), true);
  assert.equal(takesFromPhone(counted('b', { ...ravi, role: 'cashier' })), false);
  assert.equal(takesFromPhone({ ...counted('c'), type: 'stock.tier_set', tier: 'daily' } as SyncEvent), false);
  assert.equal(takesFromPhone({ ...counted('d'), actor: { ...ravi, role: 'owner' }, type: 'stock.tier_set', tier: 'daily' } as SyncEvent), true);
  assert.equal(takesFromPhone({ id: 'k', shopId: SHOP, at: 1, orderNumber: 1, ticketId: 't', type: 'kitchen.seen' }), false);
});

test('takes what is new, in pages, files it under one local device, and moves its place on', async () => {
  const inbox = [counted('c1'), counted('bad', { ...ravi, role: 'cashier' }), { ...counted('other'), shopId: 'shop-b' } as SyncEvent, counted('c2')]
    .map((event, i) => ({ seq: i + 1, event }));
  let cursor = 0;
  const filed: { device: string; ids: string[] }[] = [];
  const device: Device = { id: 'dev-phones', tenantId: SHOP, kind: 'manager' };
  const seen: string[] = [];
  const fakeFetch = (async (url: string) => {
    seen.push(url);
    const after = Number(new URL(url).searchParams.get('after'));
    const page = inbox.filter((x) => x.seq > after);
    return new Response(JSON.stringify({ events: page, lastSeq: page.at(-1)?.seq ?? after }));
  }) as typeof fetch;
  const run = startManagerInbox({
    url: 'https://cloud.test', token: 't', tenantId: SHOP, every: 60_000, fetch: fakeFetch,
    device: async () => device,
    ingest: async (d, events) => { filed.push({ device: d.id, ids: events.map((e) => e.id) }); },
    cursor: () => cursor, setCursor: (s) => { cursor = s; },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(filed, [{ device: 'dev-phones', ids: ['c1', 'c2'] }], 'a cashier\'s and another shop\'s are left out');
  assert.equal(cursor, 4);
  assert.equal(await run.poll(), 0, 'nothing twice');
  assert.match(seen.at(-1)!, /after=4$/);
  run.stop();
});
