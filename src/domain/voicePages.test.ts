import test from 'node:test';
import assert from 'node:assert/strict';
import { matchPage, voicePages } from './voicePages.ts';

const everyone = { seesOwner: true, managesStock: true, owner: true, setup: true };
const cashier = { seesOwner: false, managesStock: false, owner: false, setup: false };

test('a cashier is offered only what a cashier can open; the owner everything', () => {
  assert.deepEqual(voicePages(cashier).map((p) => p.id), ['register', 'kitchen']);
  assert.ok(voicePages(everyone).some((p) => p.id === 'recipes'));
  assert.ok(!voicePages({ ...everyone, owner: false }).some((p) => p.id === 'recipes'));
  assert.ok(!voicePages({ ...everyone, managesStock: false }).some((p) => p.id === 'items'));
});

test('plain words open their page without the model', () => {
  const pages = voicePages(everyone);
  assert.equal(matchPage('Open stock.', pages)?.hash, '#items');
  assert.equal(matchPage('show me the suppliers please', pages)?.id, 'suppliers');
  assert.equal(matchPage('Kitchen', pages)?.hash, '#kitchen');
  assert.equal(matchPage('back to the register', pages)?.hash, '');
});

test('anything less plain goes to the model: no word, or words of two pages', () => {
  const pages = voicePages(everyone);
  assert.equal(matchPage('how much did we sell today', pages), null);
  assert.equal(matchPage('is the mozzarella running low', pages), null);
  assert.equal(matchPage('stock count', pages), null); // stock and count: two pages
});

test('a page the person may not open is never matched', () => {
  assert.equal(matchPage('open stock', voicePages(cashier)), null);
  assert.equal(matchPage('recipes', voicePages(cashier)), null);
});
