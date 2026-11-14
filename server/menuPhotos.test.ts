import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { fileMenuPhotos, memoryMenuPhotos, menuPhotoId } from './menuPhotos.ts';
import { memoryStore } from './store.ts';
import { validatePush } from './validate.ts';

const SHOP = 'shop-a';
const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2, 3, 4]);

async function start() {
  const store = memoryStore();
  const server = createApp({ store, menuPhotos: memoryMenuPhotos(), now: () => 5000 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const counter = await store.addDevice(SHOP, 'Shop A', 'counter');
  const kitchen = await store.addDevice(SHOP, 'Shop A', 'kitchen');
  const upload = (token: string | null, bytes: Buffer) => fetch(`${base}/api/v1/menu-photos`, {
    method: 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: JSON.stringify({ data: bytes.toString('base64') }),
  });
  const stop = () => new Promise<void>((r) => server.close(() => r()));
  return { base, upload, stop, counter: counter.token, kitchen: kitchen.token };
}

test('the counter adds a menu photo; it is kept by its SHA-256 and anyone on the network can see it, cached for good', async () => {
  const s = await start();
  const r = await s.upload(s.counter, webp);
  assert.equal(r.status, 200);
  const { id } = await r.json() as { id: string };
  assert.equal(id, menuPhotoId(webp));
  const got = await fetch(`${s.base}/api/v1/menu-photos/${id}.webp`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/webp');
  assert.match(got.headers.get('cache-control') ?? '', /immutable/);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), webp);
  assert.equal((await fetch(`${s.base}/api/v1/menu-photos/${'0'.repeat(64)}.webp`)).status, 404);
  assert.equal((await fetch(`${s.base}/api/v1/menu-photos/../../settings.json`)).status, 404);
  await s.stop();
});

test('only the counter adds menu photos, only small WebP pictures', async () => {
  const s = await start();
  assert.equal((await s.upload(null, webp)).status, 401);
  assert.equal((await s.upload(s.kitchen, webp)).status, 403);
  assert.equal((await s.upload(s.counter, Buffer.from('not a picture at all'))).status, 400);
  const big = Buffer.concat([webp, Buffer.alloc(300_001)]);
  assert.equal((await s.upload(s.counter, big)).status, 400);
  await s.stop();
});

test('menu photos on disk: one file per photo, read back by id; nothing outside the folder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'menu-photos-'));
  try {
    const photos = fileMenuPhotos(dir);
    const id = await photos.put(webp);
    assert.deepEqual(await photos.get(id), webp);
    assert.equal(await photos.get('../x'), null);
    assert.equal(await photos.get('f'.repeat(64)), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a photo change passes the server and the cloud only for an item on the menu, naming a photo, none or ''", () => {
  const owner = { id: 'p1', shopId: SHOP, at: 1, orderNumber: 0, actor: { id: 'o', name: 'Owner', role: 'owner' }, type: 'menu.photo_set' };
  for (const photo of ['a'.repeat(64), null, '']) {
    assert.ok(!('reason' in validatePush({ events: [{ ...owner, itemId: 'margherita', photo }] }, SHOP)), String(photo));
    assert.ok(!('reason' in validatePush({ events: [{ ...owner, itemId: 'new-chicken-alfredo', photo }] }, SHOP)), String(photo));
  }
  assert.ok('reason' in validatePush({ events: [{ ...owner, itemId: 'margherita', photo: 'data:image/webp;base64,AAAA' }] }, SHOP));
  assert.ok('reason' in validatePush({ events: [{ ...owner, itemId: 'not-on-menu', photo: null }] }, SHOP));
});
