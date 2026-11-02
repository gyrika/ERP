import test from 'node:test';
import assert from 'node:assert/strict';
import { mayRecord } from './auth.ts';
import { checkValueEvent, nextPlaceName, placeOfCard, valueColumn, valuePlacesFromEvents, type ValueEvent } from './valuePlaces.ts';

const owner = { id: 'o', name: 'Owner', role: 'owner' as const };
const base = { id: 'e', shopId: 's', at: 1, orderNumber: 0 as const, actor: owner };
const place = (placeId: string, name: string, archived = false): ValueEvent =>
  ({ ...base, type: 'value.place_set', placeId, before: null, after: { name, archived } });
const put = (nodeId: string, placeId: string | null): ValueEvent => ({ ...base, type: 'value.card_set', nodeId, placeId });
const items = [{ id: 'stock:flour', cents: 7000, y: 0 }, { id: 'stock:cheese', cents: 2000, y: 100 }, { id: 'res:other', cents: 1000, y: 200 }];

test('no places: nothing to draw, and nothing moves', () => {
  const v = valuePlacesFromEvents([]);
  const c = valueColumn(v, items, 100);
  assert.equal(placeOfCard(v, 'stock:flour'), null);
  assert.deepEqual([c.cards.length, c.links.length, c.itemY.size], [0, 0, 0]);
});

test('every card starts in the first place; the places add up to the whole cost', () => {
  const v = valuePlacesFromEvents([place('va-1', 'Kitchen 1'), place('va-2', 'Register'), put('res:other', 'va-2')]);
  const [a, b] = valueColumn(v, items, 100).cards;
  assert.deepEqual([a.name, a.adds, a.soFar, a.share], ['Kitchen 1', 9000, 9000, 0.9]);
  assert.deepEqual([b.name, b.adds, b.soFar, b.index], ['Register', 1000, 10000, 1]);
});

test('a card goes back to the first place when its place is removed or its choice cleared', () => {
  const v = valuePlacesFromEvents([place('va-1', 'A'), place('va-2', 'B'), put('stock:flour', 'va-2'), place('va-2', 'B', true)]);
  assert.equal(placeOfCard(v, 'stock:flour'), 'va-1');
  assert.equal(valueColumn(v, items, 100).cards.length, 1);
  const w = valuePlacesFromEvents([place('va-1', 'A'), place('va-2', 'B'), put('stock:flour', 'va-2'), put('stock:flour', null)]);
  assert.equal(placeOfCard(w, 'stock:flour'), 'va-1');
});

test('undoing an added place removes it; names count on without clashing', () => {
  const undone = valuePlacesFromEvents([place('va-1', 'A'), { ...base, type: 'value.place_set', placeId: 'va-1', before: { name: 'A', archived: false }, after: null } as ValueEvent]);
  assert.equal(undone.list.length, 0);
  assert.equal(nextPlaceName(valuePlacesFromEvents([])), 'Place 1');
  assert.equal(nextPlaceName(valuePlacesFromEvents([place('va-1', 'place 2')])), 'Place 3');
});

test('each card gets one line, stacked by place with no card on another', () => {
  const v = valuePlacesFromEvents([place('va-1', 'A'), place('va-2', 'B'), put('stock:cheese', 'va-2')]);
  const c = valueColumn(v, items, 100);
  assert.equal(c.links.length, items.length);
  assert.equal(new Set(c.itemY.values()).size, items.length);
  assert.ok(c.itemY.get('stock:cheese')! > c.itemY.get('res:other')!);
  assert.ok(c.addY > Math.max(...c.itemY.values()));
});

test('only the owner records value addition, and only well formed events pass', () => {
  assert.equal(mayRecord('owner', 'value.place_set'), true);
  assert.equal(mayRecord('manager', 'value.card_set'), false);
  assert.equal(mayRecord('cashier', 'value.place_set'), false);
  assert.equal(checkValueEvent(place('va-1', 'Kitchen 1') as never), null);
  assert.ok(checkValueEvent(place('nope', 'Kitchen 1') as never));
  assert.ok(checkValueEvent(place('va-1', ' ') as never));
  assert.ok(checkValueEvent(put('semi:Dough', 'va-1') as never));
  assert.equal(checkValueEvent(put('res:bills', null) as never), null);
});
