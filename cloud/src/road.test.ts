import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orsRoadKm } from './road.ts';

const SHOP = { lat: 6.8235, lng: 79.8901 };
const HOME = { lat: 6.84, lng: 79.9 };

test('openrouteservice: the road km from the shop, asked with the key; any trouble is null, never an error', async () => {
  const sent: { url: string; init: RequestInit }[] = [];
  const answer = (status: number, body: unknown) => (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;

  assert.equal(await orsRoadKm('k', answer(200, { routes: [{ summary: { distance: 4630, duration: 600 } }] }))(SHOP, HOME), 4.63);
  assert.equal(sent[0].url, 'https://api.openrouteservice.org/v2/directions/driving-car');
  assert.equal((sent[0].init.headers as Record<string, string>).authorization, 'k');
  assert.deepEqual(JSON.parse(String(sent[0].init.body)), { coordinates: [[79.8901, 6.8235], [79.9, 6.84]] }, 'longitude first');

  assert.equal(await orsRoadKm(undefined, answer(200, {}))(SHOP, HOME), null, 'no key: not asked');
  assert.equal(sent.length, 1);
  assert.equal(await orsRoadKm('k', answer(429, { error: 'Quota exceeded' }))(SHOP, HOME), null);
  assert.equal(await orsRoadKm('k', answer(200, { routes: [] }))(SHOP, HOME), null);
  assert.equal(await orsRoadKm('k', (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch)(SHOP, HOME), null);
});
