import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeUpdate, nextCounterUpdate, UPDATE_STALE_MS, type CounterUpdate, type UpdateStep } from './updating.ts';

const step = (phase: UpdateStep['phase'], percent: number, at = 1_000): UpdateStep => ({ phase, percent, version: '1.0.10', at });
const NONE: CounterUpdate = { kind: 'none' };

test('the health check passes on only an update under way, and never a stale one', () => {
  assert.deepEqual(activeUpdate(step('downloading', 30), 2_000), step('downloading', 30));
  assert.equal(activeUpdate(step('done', 100), 2_000), null);
  assert.equal(activeUpdate(step('failed', 100), 2_000), null);
  assert.equal(activeUpdate(step('up-to-date', 100), 2_000), null);
  assert.equal(activeUpdate(step('installing', 65), 1_000 + UPDATE_STALE_MS), null, 'a crashed updater left it behind');
  assert.equal(activeUpdate(null, 0), null);
});

test('an update from start to finish: notice, whole screen through the restart, then the new screens', () => {
  let s = nextCounterUpdate(NONE, { version: '1.0.9', update: step('downloading', 42) }, '1.0.9');
  assert.deepEqual(s, { kind: 'preparing', version: '1.0.10', percent: 42 }, 'the counter still works');
  s = nextCounterUpdate(s, { version: '1.0.9', update: step('backup', 61) }, '1.0.9');
  assert.equal(s.kind, 'preparing');
  s = nextCounterUpdate(s, 'unreachable', '1.0.9');
  assert.deepEqual(s, { kind: 'installing', version: '1.0.10', percent: 65, step: 'installing' }, 'the installer stopped the server');
  s = nextCounterUpdate(s, 'unreachable', '1.0.9');
  assert.equal(s.kind, 'installing', 'still saying so while it is down');
  s = nextCounterUpdate(s, { version: '1.0.10', update: step('starting', 85) }, '1.0.9');
  assert.deepEqual(s, { kind: 'reload', version: '1.0.10' }, 'the new version answers: load its screens');
});

test('the new version does not start: the screen says it is going back, through the second restart', () => {
  let s: CounterUpdate = { kind: 'installing', version: '1.0.10', percent: 85, step: 'starting' };
  s = nextCounterUpdate(s, { version: '1.0.9', update: step('going-back', 90) }, '1.0.9');
  assert.deepEqual(s, { kind: 'going-back', version: '1.0.10' });
  s = nextCounterUpdate(s, 'unreachable', '1.0.9');
  assert.equal(s.kind, 'going-back');
  s = nextCounterUpdate(s, { version: '1.0.9', update: null }, '1.0.9');
  assert.deepEqual(s, NONE, 'back on the version these screens came from: nothing to reload');
});

test('a server that is simply down is not an update; development never reloads', () => {
  assert.deepEqual(nextCounterUpdate(NONE, 'unreachable', '1.0.9'), NONE);
  assert.deepEqual(nextCounterUpdate(NONE, { version: 'development' }, 'development'), NONE);
  assert.deepEqual(nextCounterUpdate(NONE, { version: '1.0.9' }, null), NONE, 'first answer: nothing to compare yet');
});
