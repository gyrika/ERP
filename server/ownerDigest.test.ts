import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forkBuilder, startOwnerDigest, type DigestBuilder } from './ownerDigest.ts';
import type { SyncedEvent, SyncEvent } from '../src/domain/sync.ts';

// The owner's digest from the shop PC to the cloud (SCRUM-198): nothing at all unless ChatGPT is connected.

const stored = (n: number) => Array.from({ length: n }, (_, i) => ({ seq: i + 1, event: { id: `e${i + 1}`, type: 'kitchen.seen', shopId: 's', at: i, orderNumber: 1, ticketId: 't' } })) as unknown as SyncedEvent[];

function shop(answerWanted: () => Response) {
  const log = { reads: 0, puts: [] as { digest: { computedAt: number } }[], added: 0, builders: 0, stopped: 0 };
  const rows = { all: stored(2) };
  const clock = { t: 1_000_000 };
  const builder = (): DigestBuilder => {
    log.builders++;
    return {
      add: async (events) => { log.added += events.length; },
      build: async (now) => JSON.stringify({ computedAt: now }),
      stop: () => { log.stopped++; },
    };
  };
  const running = startOwnerDigest({
    url: 'https://cloud.test', token: 'tok', tenantId: 's', now: () => clock.t, every: 3_600_000, builder,
    store: { pull: async (_tenant, after, limit) => { log.reads++; return rows.all.filter((r) => r.seq > after).slice(0, limit); } },
    fetch: (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/wanted')) return answerWanted();
      log.puts.push(JSON.parse(String(init?.body)));
      return new Response('{}');
    }) as typeof fetch,
  });
  return { log, rows, clock, running };
}

test('ChatGPT not connected: no history read, no worker, nothing sent', async () => {
  const s = shop(() => new Response(JSON.stringify({ wanted: false })));
  assert.equal(await s.running.poll(), false);
  s.running.stop();
  assert.deepEqual([s.log.reads, s.log.builders, s.log.puts.length], [0, 0, 0]);
});

test('switched off, or an older cloud: quiet too', async () => {
  const s = shop(() => new Response('{}', { status: 404 }));
  assert.equal(await s.running.poll(), false);
  s.running.stop();
  assert.deepEqual([s.log.reads, s.log.builders], [0, 0]);
});

test('connected: sends only what is new to the worker; uploads at most every 10 minutes, at least every half hour', async () => {
  const s = shop(() => new Response(JSON.stringify({ wanted: true })));
  assert.equal(await s.running.poll(), true);
  assert.equal(s.log.puts[0].digest.computedAt, 1_000_000);
  assert.equal(s.log.added, 2);

  assert.equal(await s.running.poll(), false, 'nothing new');
  s.rows.all = stored(3);
  assert.equal(await s.running.poll(), false, 'new, but too soon');
  assert.equal(s.log.added, 3, 'only the new one went to the worker');
  s.clock.t += 11 * 60_000;
  assert.equal(await s.running.poll(), true, 'new, and 10 minutes on');
  s.clock.t += 11 * 60_000;
  assert.equal(await s.running.poll(), false, 'nothing new yet');
  s.clock.t += 20 * 60_000;
  assert.equal(await s.running.poll(), true, 'half an hour on, the clock alone is enough');
  assert.equal(s.log.builders, 1, 'one worker throughout');
  s.running.stop();
  assert.equal(s.log.puts.length, 3);
});

test('ChatGPT disconnected: the worker goes away and its memory with it', async () => {
  let wanted = true;
  const s = shop(() => new Response(JSON.stringify({ wanted })));
  await s.running.poll();
  wanted = false;
  await s.running.poll();
  assert.equal(s.log.stopped, 1);
  wanted = true;
  assert.equal(await s.running.poll(), true, 'connected again: from the start');
  assert.equal(s.log.added, 4);
  s.running.stop();
});

test('the cloud down: the next pass tries again', async () => {
  let down = true;
  const s = shop(() => (down ? new Response('', { status: 503 }) : new Response(JSON.stringify({ wanted: true }))));
  await assert.rejects(s.running.poll());
  down = false;
  assert.equal(await s.running.poll(), true);
  s.running.stop();
});

test('the real worker builds a digest in its own process', async () => {
  const worker = forkBuilder();
  try {
    await worker.add([{ id: 'd1', shopId: 's', type: 'stock.draft_set', at: 1, orderNumber: 0, supplierId: 'sup_prima', lines: [{ itemId: 'inv-0001', packs: 3 }],
      actor: { id: 'o', name: 'Owner', role: 'owner' } } as SyncEvent]);
    const digest = JSON.parse(await worker.build(1_000_000));
    assert.equal(digest.computedAt, 1_000_000);
    assert.equal(digest.suppliers.find((x: { id: string }) => x.id === 'sup_prima').draft[0].packs, 3);
  } finally { worker.stop(); }
});

test('a stuck worker is given up on, with an error the next pass can start over from', async () => {
  const worker = forkBuilder(undefined, 1);
  await assert.rejects(worker.build(1), /worker/);
  worker.stop();
});
