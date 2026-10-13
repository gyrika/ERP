import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SyncEvent } from '../../src/domain/sync.ts';
import { startReplicator } from '../../server/replicator.ts';
import { memoryStore } from '../../server/store.ts';
import { createCloud, sha256Hex } from './cloud.ts';
import { fakeD1 } from './fakeD1.ts';

/** A shop server (memory store) and the real cloud code, joined by a network we can cut. */
async function world() {
  const { d1, db } = fakeD1();
  db.prepare("INSERT INTO shops (id, name, created_at) VALUES ('shop-a', 'A', 0)").run();
  db.prepare("INSERT INTO devices (id, tenant_id, kind, token_hash, created_at) VALUES ('cloud-dev', 'shop-a', 'shop_server', ?, 0)")
    .run(await sha256Hex('secret'));
  const cloud = createCloud(d1);
  let down = false;
  let calls = 0;
  const net = (async (url: string | URL | Request, init?: RequestInit) => {
    calls++;
    if (down) throw new TypeError('fetch failed');
    return cloud(new Request(String(url), init));
  }) as typeof fetch;

  const store = memoryStore();
  const { device } = await store.addDevice('shop-a', 'A', 'counter');
  const sell = (n: number, from = 0) => store.push(device, Array.from({ length: n }, (_, i): SyncEvent => (
    { id: `e${from + i}`, shopId: 'shop-a', at: 1, orderNumber: 1001, ticketId: 't', type: 'kitchen.seen' })), 2);
  const copied = () => (db.prepare("SELECT id FROM events WHERE tenant_id = 'shop-a' ORDER BY source_seq").all() as { id: string }[]).map((r) => r.id);
  const rep = startReplicator({
    store, tenantId: 'shop-a', url: 'https://cloud.test', token: 'secret', fetch: net, every: 3_600_000,
    about: () => ({ version: '1.0.4', update: { phase: 'done', percent: 100, version: '1.0.4', at: 7 } }),
  });
  const station = () => db.prepare("SELECT version, update_status, last_seen_at FROM devices WHERE id = 'cloud-dev'").get();
  return { rep, sell, copied, station, setDown: (v: boolean) => { down = v; }, calls: () => calls };
}

test('everything is copied once, in batches, and a second pass sends nothing', async () => {
  const w = await world();
  await w.sell(250);
  await w.rep.syncNow();
  assert.equal(w.copied().length, 250);
  assert.deepEqual(w.copied().slice(0, 3), ['e0', 'e1', 'e2']);
  const before = w.calls();
  await w.rep.syncNow();
  assert.equal(w.calls() - before, 1, 'up to date: one question, nothing sent');
  assert.equal(w.copied().length, 250);
  assert.ok(w.rep.status().upToDateAt);
  w.rep.stop();
});

test('internet down: sales go on; on reconnect the copy catches up, nothing lost or doubled', async () => {
  const w = await world();
  await w.sell(3);
  await w.rep.syncNow();
  w.setDown(true);
  await w.sell(5, 3);
  await w.rep.syncNow();
  assert.match(w.rep.status().lastError ?? '', /fetch failed/);
  assert.equal(w.copied().length, 3);

  w.setDown(false);
  await w.rep.syncNow();
  assert.deepEqual(w.copied(), ['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']);
  assert.equal(w.rep.status().lastError, null);
  w.rep.stop();
});

test('every pass, even with nothing to copy, tells the cloud this Station is alive and what it runs', async () => {
  const w = await world();
  await w.rep.syncNow();
  assert.deepEqual({ ...w.station() as object, last_seen_at: typeof (w.station() as { last_seen_at: unknown }).last_seen_at }, {
    version: '1.0.4', update_status: '{"phase":"done","percent":100,"version":"1.0.4","at":7}', last_seen_at: 'number',
  });
  w.rep.stop();
});
