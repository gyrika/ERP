import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLKR } from './money.ts';

test('a typed rupee price becomes integer cents, read as text (no float rounding)', () => {
  assert.equal(parseLKR('6400'), 640000);
  assert.equal(parseLKR('6,400'), 640000);
  assert.equal(parseLKR(' Rs 1,250.25 '), 125025);
  assert.equal(parseLKR('0.1'), 10);
  assert.equal(parseLKR('0'), 0);
  for (const bad of ['', '-5', '6.400,00', '64,00', '1.234', 'abc']) assert.equal(parseLKR(bad), null, bad);
});
