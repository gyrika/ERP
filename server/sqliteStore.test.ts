import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SyncEvent } from '../src/domain/sync.ts';
import { sqliteStore } from './sqliteStore.ts';
import { PinTaken } from './store.ts';

const SHOP = 'shop-a';
const ev = (id: string, shopId = SHOP): SyncEvent => ({ id, shopId, at: 1, orderNumber: 1001, ticketId: 't', type: 'kitchen.seen' });

test('SQLite store: idempotent push, seq order, tenant isolation, paging', async () => {
  const store = sqliteStore(':memory:');
  const { device, token } = await store.addDevice(SHOP, 'Shop A', 'counter');
  const { device: other } = await store.addDevice('shop-b', 'Shop B', 'counter');
  assert.deepEqual(await store.deviceByToken(token), device);
  assert.equal(await store.deviceByToken('nope'), null);

  const first = await store.push(device, [ev('a'), ev('b')], 100);
  const again = await store.push(device, [ev('b'), ev('c')], 200);
  assert.deepEqual(first.accepted.map((a) => a.seq), [1, 2]);
  assert.deepEqual(again.accepted, [{ id: 'b', seq: 2 }, { id: 'c', seq: 3 }]);
  assert.deepEqual(again.stored.map((s) => s.event.id), ['c'], 'a repeat is not stored or streamed again');

  await store.push(other, [ev('x', 'shop-b')], 300);
  assert.deepEqual((await store.pull(SHOP, 0, 2)).map((s) => s.event.id), ['a', 'b']);
  assert.deepEqual((await store.pull(SHOP, 2, 10)).map((s) => s.event.id), ['c'], "never another shop's events");
  assert.deepEqual((await store.pull(SHOP, 0, 1))[0].event, ev('a'), 'the body comes back exactly as sent');
  assert.equal(await store.lastSeq(SHOP), 3);
  await store.close();
});

test('SQLite store: staff before any device, unique PINs, deactivate, per-device sessions', async () => {
  const store = sqliteStore(':memory:');
  const nisal = await store.addStaff(SHOP, 'Nisal Vimukthi', 'owner', '1234');
  await assert.rejects(store.addStaff(SHOP, 'Someone', 'cashier', '1234'), PinTaken);
  const { device } = await store.addDevice(SHOP, 'Shop A', 'counter');
  const { device: other } = await store.addDevice(SHOP, 'Shop A', 'kitchen');
  assert.equal((await store.staffByPin(SHOP, '1234'))?.id, nisal.id);
  await store.startSession(device, nisal, 1000, 2000);
  assert.deepEqual(await store.sessions(device, [nisal.id]), [{ staffId: nisal.id, role: 'owner', startedAt: 1000, expiresAt: 2000 }]);
  assert.deepEqual(await store.sessions(other, [nisal.id]), []);
  assert.equal(await store.deactivateStaff(SHOP, nisal.id), true);
  assert.equal(await store.staffByPin(SHOP, '1234'), null);
  await store.close();
});

test('SQLite store: a file that survives a restart, and the database refuses to change history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-sqlite-'));
  const file = join(dir, 'pos.sqlite');
  try {
    let store = sqliteStore(file);
    const { device, token } = await store.addDevice(SHOP, 'Shop A', 'counter');
    await store.push(device, [ev('a')], 1);
    const nisal = await store.addStaff(SHOP, 'Nisal Vimukthi', 'owner', '1234');
    await store.startSession(device, nisal, 1, 2);
    await store.close();

    store = sqliteStore(file); // opening again applies no migration twice
    assert.deepEqual(await store.deviceByToken(token), device);
    assert.equal(await store.lastSeq(SHOP), 1);
    await store.close();

    const raw = new DatabaseSync(file);
    assert.throws(() => raw.exec("UPDATE events SET type = 'x'"), /never changed/);
    assert.throws(() => raw.exec('DELETE FROM events'), /never deleted/);
    assert.throws(() => raw.exec('DELETE FROM sessions'), /never deleted/);
    raw.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backups: a checked copy taken while the store is open, the newest 14 kept, nothing to do without a database', async () => {
  const { backupDatabase } = await import('./sqliteBackup.ts');
  const dir = mkdtempSync(join(tmpdir(), 'cb-backup-'));
  try {
    assert.equal(backupDatabase(dir, 'nightly'), null, 'MySQL shop, or not set up yet');
    const store = sqliteStore(join(dir, 'pos.sqlite'));
    const { device } = await store.addDevice(SHOP, 'Shop A', 'counter');
    await store.push(device, [ev('a'), ev('b')], 1);
    // The server keeps running (and writing) while the copy is made.
    const r = backupDatabase(dir, 'before-1.0.4', 14, new Date('2026-10-13T04:00:00Z'))!;
    assert.match(r.file, /pos-20261013-040000-before-1\.0\.4\.sqlite$/);
    assert.equal(r.events, 2);
    await store.push(device, [ev('c')], 2);
    const copy = new DatabaseSync(r.file, { readOnly: true });
    assert.equal((copy.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n, 2, 'the moment it was taken');
    copy.close();

    for (let d = 1; d <= 16; d++) backupDatabase(dir, 'nightly', 14, new Date(Date.UTC(2026, 10, d, 4)));
    const kept = readdirSync(join(dir, 'backups')).sort();
    assert.equal(kept.length, 14);
    assert.equal(kept[0], 'pos-20261103-040000-nightly.sqlite', 'the oldest ones go first');
    await store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
