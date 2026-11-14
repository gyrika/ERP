import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayRecord } from './auth.ts';
import { EMPTY_MENU_STATE, menuStateFromEvents } from './menuEdits.ts';
import { isWebp, photoChoice, undoChoice, validPhotoChoice } from './menuPhotos.ts';

const A = 'a'.repeat(64), B = 'b'.repeat(64);
const set = (itemId: string, photo: string | null, at = 1) =>
  ({ id: `p${at}`, shopId: 's', at, orderNumber: 0, actor: { id: 'o', name: 'Owner', role: 'owner' }, type: 'menu.photo_set', itemId, photo });

test("an item's photo: a photo id, none (null), or '' back to never chosen", () => {
  const state = menuStateFromEvents([set('margherita', A, 1), set('seafood', null, 2), set('margherita', B, 3), set('bbq-chicken', A, 4), set('bbq-chicken', '', 5)]);
  assert.equal(photoChoice(state, 'margherita'), B);
  assert.equal(photoChoice(state, 'seafood'), null);
  assert.equal(photoChoice(state, 'bbq-chicken'), undefined);
  assert.equal(photoChoice(state, 'never'), undefined);
  // Undo sends what it was: '' for an item that had never been given one.
  assert.equal(undoChoice(undefined), '');
  assert.equal(undoChoice(null), null);
  assert.equal(undoChoice(A), A);
});

test('a shop that never chose a photo carries no photos (cheesybeez.com and old tests see the same state)', () => {
  assert.deepEqual(menuStateFromEvents([]), EMPTY_MENU_STATE);
  assert.deepEqual(menuStateFromEvents([set('margherita', A, 1), set('margherita', '', 2)]), EMPTY_MENU_STATE);
});

test('what a photo change may carry; who may make it', () => {
  for (const ok of [A, null, '']) assert.equal(validPhotoChoice(ok), true, String(ok));
  for (const bad of ['A'.repeat(64), 'a'.repeat(63), 'data:image/webp;base64,xx', undefined, 7, {}]) assert.equal(validPhotoChoice(bad), false, String(bad));
  assert.equal(mayRecord('owner', 'menu.photo_set'), true);
  assert.equal(mayRecord('manager', 'menu.photo_set'), true);
  assert.equal(mayRecord('cashier', 'menu.photo_set'), false);
  assert.equal(mayRecord('kitchen', 'menu.photo_set'), false);
});

test('only a WebP file passes as a menu photo', () => {
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56]);
  assert.equal(isWebp(webp), true);
  assert.equal(isWebp(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), false); // a JPEG
  assert.equal(isWebp(webp.slice(0, 12)), false);
});
