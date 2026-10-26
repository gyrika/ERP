import test from 'node:test';
import assert from 'node:assert/strict';
import { matchPage, VOICE_HINT, voicePages } from './voicePages.ts';

const everyone = { seesOwner: true, managesStock: true, owner: true, setup: true };
const cashier = { seesOwner: false, managesStock: false, owner: false, setup: false };

test('a cashier is offered only what a cashier can open; the owner everything', () => {
  assert.deepEqual(voicePages(cashier).map((p) => p.id), ['register', 'kitchen']);
  assert.ok(voicePages(everyone).some((p) => p.id === 'recipes'));
  assert.ok(!voicePages({ ...everyone, owner: false }).some((p) => p.id === 'recipes'));
  assert.ok(!voicePages({ ...everyone, managesStock: false }).some((p) => p.id === 'items'));
  assert.ok(!voicePages({ ...everyone, managesStock: false }).some((p) => p.id === 'low'));
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
  assert.equal(matchPage('do we have enough chicken', pages), null);
  assert.equal(matchPage('stock and suppliers', pages), null); // two pages
});

test('the longer phrase wins: low stock is not stock, a stock count is not stock', () => {
  const pages = voicePages(everyone);
  assert.equal(matchPage('Show low-stock ingredients.', pages)?.hash, '#items/low');
  assert.equal(matchPage('is the mozzarella running low', pages)?.hash, '#items/low');
  assert.equal(matchPage('stock count', pages)?.id, 'count');
  assert.equal(matchPage('Open inventory', pages)?.hash, '#items');
});

test("the brief's requests open the shop's real pages", () => {
  const pages = voicePages(everyone);
  assert.equal(matchPage("Show today's sales", pages)?.hash, '#owner');
  assert.equal(matchPage('Go to production.', pages)?.hash, '#flow');
  assert.equal(matchPage('Return to dashboard', pages)?.hash, '#owner');
  assert.equal(matchPage('go home', pages)?.hash, '');
});

test('Sinhala-English as staff say it: the English words find the page', () => {
  const pages = voicePages(everyone);
  assert.equal(matchPage('stock eka pennanna', pages)?.hash, '#items');
  assert.equal(matchPage('ada sales keeyada', pages)?.hash, '#owner');
  assert.equal(matchPage('supplier la gawa', pages)?.id, 'suppliers');
  // Sinhala script between the words drops out; the English stays.
  assert.equal(matchPage('kitchen එක බලන්න', pages)?.hash, '#kitchen');
});

test('the words Whisper is told to expect include every page that has a name staff say', () => {
  for (const id of ['low', 'owner', 'flow', 'receive', 'semi', 'suppliers', 'count']) {
    assert.ok(voicePages(everyone).some((p) => p.id === id));
  }
  assert.match(VOICE_HINT, /low stock/);
  assert.match(VOICE_HINT, /Margherita/);
  assert.ok(VOICE_HINT.length < 400, 'Whisper reads only the last part of a long prompt');
});

test('a page the person may not open is never matched', () => {
  assert.equal(matchPage('open stock', voicePages(cashier)), null);
  assert.equal(matchPage('recipes', voicePages(cashier)), null);
  assert.equal(matchPage('show low stock', voicePages(cashier)), null);
  assert.equal(matchPage("today's sales", voicePages(cashier)), null);
});
