import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayRecord } from './auth.ts';
import { cookTimeMs } from './kitchen.ts';
import { MENU, cookMinutesOf, itemById, menuSections, setMenuState } from './menu.ts';
import { checkNewItem, EMPTY_MENU_STATE, effectiveMenu, menuStateFromEvents, type NewItem } from './menuEdits.ts';
import { checkSection, checkSectionOrder, moveSection, newSectionId, sectionsOf } from './sections.ts';

const owner = { id: 'o', name: 'Nisal', role: 'owner' as const };
let n = 0;
const ev = (type: string, itemId: string, rest: object) => ({ id: `e${++n}`, shopId: 's', at: n, orderNumber: 0, actor: owner, type, itemId, ...rest });
const section = (id: string, after: object | null, before: object | null = null) => ev('menu.section_set', id, { before, after });
const kottu = { name: { en: 'Kottu' }, sizes: [{ id: 'x1', label: 'Full' }, { id: 'x2', label: 'Normal' }], cookMinutes: 8 };
const drinks = { name: { en: 'Drinks' }, cookMinutes: 1 };

test('the printed sections first, then his own as he made them; his order wins; renames show', () => {
  assert.deepEqual(sectionsOf(EMPTY_MENU_STATE).map((s) => s.label), ['Pizza', 'Burgers', 'Pasta']);
  const state = menuStateFromEvents([
    section('sec-kottu', kottu), section('sec-drinks', drinks),
    section('burger', { name: { en: 'Burgers & Subs' }, cookMinutes: 5 }),
    ev('menu.sections_ordered', 'sections', { before: [], after: ['sec-kottu', 'pizza'] }),
  ]);
  const s = sectionsOf(state);
  assert.deepEqual(s.map((x) => x.id), ['sec-kottu', 'pizza', 'burger', 'pasta', 'sec-drinks']);
  assert.equal(s[2].label, 'Burgers & Subs');
  assert.equal(s[2].cookMinutes, 5);
  assert.deepEqual(s[0].sizes, kottu.sizes);
  assert.equal(s[4].sizes, null);
  // Back to as printed, and a new section taken back.
  const back = sectionsOf(menuStateFromEvents([section('burger', { name: { en: 'X' } }), section('burger', null), section('sec-drinks', drinks), section('sec-drinks', null)]));
  assert.deepEqual(back.map((x) => x.label), ['Pizza', 'Burgers', 'Pasta']);
});

test('a dish in his own section takes its sizes, no extras; hiding the section hides its dishes', () => {
  const item: NewItem = { category: 'sec-kottu', name: { en: 'Chicken Kottu' }, description: '', prices: { x1: 120000, x2: 90000 } };
  const water: NewItem = { category: 'sec-drinks', name: { en: 'Water' }, description: '', prices: { one: 10000 } };
  const events = [section('sec-kottu', kottu), section('sec-drinks', drinks),
    ev('menu.item_added', 'new-chicken-kottu', { item }), ev('menu.item_added', 'new-water', { item: water })];
  const menu = effectiveMenu(MENU, menuStateFromEvents(events), 0);
  const k = menu.find((m) => m.id === 'new-chicken-kottu')!;
  assert.deepEqual(k.variants?.map((v) => [v.id, v.label, v.price]), [['x1', 'Full', 120000], ['x2', 'Normal', 90000]]);
  assert.deepEqual(k.adds, []);
  assert.equal(k.hidden, undefined);
  assert.equal(menu.find((m) => m.id === 'new-water')!.price, 10000);

  const hidden = effectiveMenu(MENU, menuStateFromEvents([...events, section('sec-kottu', { ...kottu, hidden: true }, kottu)]), 0);
  assert.equal(hidden.find((m) => m.id === 'new-chicken-kottu')!.hidden, true);
  assert.equal(hidden.find((m) => m.id === 'new-water')!.hidden, undefined);
});

test('the kitchen times a dish of his section by its cook time', () => {
  const item: NewItem = { category: 'sec-kottu', name: { en: 'Chicken Kottu' }, description: '', prices: { x1: 120000, x2: 90000 } };
  setMenuState(menuStateFromEvents([section('sec-kottu', kottu), ev('menu.item_added', 'new-chicken-kottu', { item })]));
  try {
    assert.equal(cookMinutesOf('sec-kottu'), 8);
    assert.equal(cookMinutesOf('pizza'), 10);
    assert.equal(itemById('new-chicken-kottu').category, 'sec-kottu');
    assert.equal(cookTimeMs({ lines: [{ itemId: 'new-chicken-kottu', qty: 1, size: 'x1', adds: [], outs: [] } as never] }), 8 * 60_000);
    assert.equal(menuSections().length, 4);
  } finally { setMenuState(EMPTY_MENU_STATE); }
});

test('a new item in his section: its sizes and whole-rupee prices; the server, not knowing his sections, checks the shape', () => {
  const sections = { 'sec-kottu': kottu } as never;
  const ok: NewItem = { category: 'sec-kottu', name: { en: 'Egg Kottu' }, description: '', prices: { x1: 100000, x2: 80000 } };
  assert.equal(checkNewItem(ok, MENU, sections), null);
  assert.match(checkNewItem({ ...ok, prices: { x1: 100000 } }, MENU, sections)!, /whole rupees/);
  assert.match(checkNewItem({ ...ok, prices: { one: 100000 } }, MENU, sections)!, /size/);
  assert.match(checkNewItem({ ...ok, category: 'sec-rice' }, MENU, sections)!, /not a menu section/);
  // The server (no sections): one price, or x1.. in order.
  assert.equal(checkNewItem(ok, MENU), null);
  assert.equal(checkNewItem({ ...ok, prices: { one: 50000 } }, MENU), null);
  assert.ok(checkNewItem({ ...ok, prices: { x2: 50000 } }, MENU));
  assert.ok(checkNewItem({ ...ok, prices: { one: 50000, x1: 100 } }, MENU));
  assert.ok(checkNewItem({ ...ok, prices: { x1: 50050, x2: 100 } }, MENU));
});

test('a section setting: a name, 2 or 3 named sizes or one price, a cook time; printed ones keep their sizes', () => {
  assert.equal(checkSection('sec-kottu', kottu as never), null);
  assert.equal(checkSection('sec-drinks', drinks), null);
  assert.equal(checkSection('pizza', { name: { en: 'Pizzas' }, cookMinutes: 12 }), null);
  assert.match(checkSection('sec-x', { cookMinutes: 5 })!, /English name/);
  assert.match(checkSection('pizza', { hidden: true })!, /stay on the menu/);
  assert.match(checkSection('sec-x', { name: { en: 'X' }, sizes: [{ id: 'x1', label: 'Big' }] })!, /2 or 3/);
  assert.match(checkSection('sec-x', { name: { en: 'X' }, sizes: [{ id: 'x1', label: 'Big' }, { id: 'x2', label: 'big' }] })!, /same name/);
  assert.match(checkSection('sec-x', { name: { en: 'X' }, cookMinutes: 0 })!, /1 to 120/);
  assert.match(checkSection('drinks', { name: { en: 'X' } })!, /not a menu section/);
  // Sizes keep their count once made; their names change.
  assert.match(checkSection('sec-kottu', drinks, kottu as never)!, /keeps the sizes/);
  assert.equal(checkSection('sec-kottu', { ...kottu, sizes: [{ id: 'x1', label: 'Large' }, { id: 'x2', label: 'Small' }] } as never, kottu as never), null);
  assert.equal(checkSectionOrder(['pizza', 'sec-kottu']), null);
  assert.ok(checkSectionOrder(['pizza', 'pizza']));
  assert.ok(checkSectionOrder(['drinks']));
});

test('ids, moving, and only the owner changes sections', () => {
  assert.equal(newSectionId('Rice & Curry', []), 'sec-rice-curry');
  assert.equal(newSectionId('Kottu', ['sec-kottu']), 'sec-kottu-2');
  assert.deepEqual(moveSection(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(moveSection(['a', 'b', 'c'], 'c', 1), ['a', 'b', 'c']);
  assert.equal(mayRecord('owner', 'menu.section_set'), true);
  assert.equal(mayRecord('manager', 'menu.section_set'), false);
  assert.equal(mayRecord('manager', 'menu.sections_ordered'), false);
});
