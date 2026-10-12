import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createPool } from 'mysql2/promise';
import type { SyncEvent } from '../src/domain/sync.ts';
import { mysqlStore } from './store.ts';

/**
 * The MySQL store against a real database. Skipped unless TEST_DATABASE_URL
 * points at a database where server/schema.sql has been run, e.g.
 *   TEST_DATABASE_URL=mysql://pos_app:secret@localhost:3306/cheesybeez npm run test:domain
 * Each run uses a fresh shop id, so it never touches real data.
 */
const url = process.env.TEST_DATABASE_URL;

test('MySQL store: idempotent push, seq order, tenant isolation, pull paging', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  const store = mysqlStore(createPool({ uri: url!, supportBigNumbers: true }));
  const shop = `test-${randomBytes(4).toString('hex')}`;
  const otherShop = `${shop}-b`;
  try {
    const { device, token } = await store.addDevice(shop, 'Test shop', 'counter');
    const { device: other } = await store.addDevice(otherShop, 'Other', 'counter');
    assert.deepEqual(await store.deviceByToken(token), device);
    assert.equal(await store.deviceByToken('nope'), null);

    const ev = (id: string): SyncEvent => ({ id, shopId: shop, at: 1, orderNumber: 1001, ticketId: 't', type: 'kitchen.seen' });
    const first = await store.push(device, [ev('a'), ev('b')], 100);
    const again = await store.push(device, [ev('b'), ev('c')], 200);
    assert.equal(first.stored.length, 2);
    assert.deepEqual(again.stored.map((s) => s.event.id), ['c'], 'a repeat is not stored or streamed again');
    assert.equal(again.accepted[0].seq, first.accepted[1].seq, 'a repeat gets its original seq');
    assert.ok(again.accepted[1].seq > first.accepted[1].seq);

    const pulled = await store.pull(shop, 0, 2);
    assert.deepEqual(pulled.map((s) => s.event.id), ['a', 'b']);
    assert.deepEqual(pulled[0].event, ev('a'), 'the body comes back exactly as sent');
    assert.equal(pulled[0].receivedAt, 100);
    assert.equal(await store.lastSeq(shop), again.accepted[1].seq);

    await store.push(other, [{ ...ev('x'), shopId: otherShop }], 300);
    assert.deepEqual((await store.pull(shop, 0, 100)).map((s) => s.event.id), ['a', 'b', 'c'], 'never another shop\'s events');
  } finally {
    await store.close();
  }
});
