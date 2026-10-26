import test from 'node:test';
import assert from 'node:assert/strict';
import { END_SILENCE_MS, listen, loudness, MAX_LISTEN_MS, NO_SPEECH_MS, startListening, type Heard } from './speechEnd.ts';

const STEP = 50;

/** Plays stretches of [ms, loudness] (with a little flutter) and says when listening ended, and how. */
function play(parts: [number, number][], seed = 1): { heard: Heard; at: number } {
  let s = startListening(0);
  let at = 0;
  let r = seed;
  const flutter = () => { r = (r * 16807) % 2147483647; return 0.85 + 0.3 * (r / 2147483647); };
  for (const [ms, level] of parts) {
    for (let t = 0; t < ms; t += STEP) {
      at += STEP;
      const step = listen(s, at, level * flutter());
      s = step.s;
      if (step.heard !== 'listening') return { heard: step.heard, at };
    }
  }
  return { heard: 'listening', at };
}

const QUIET_ROOM = 0.005;
const BUSY_SHOP = 0.05; // fans, the oven, people talking at the tables
const VOICE = 0.25;

test('speech in a quiet room ends about a second after the last word', () => {
  const end = play([[300, QUIET_ROOM], [1500, VOICE], [3000, QUIET_ROOM]]);
  assert.equal(end.heard, 'done');
  assert.ok(end.at >= 1800 + END_SILENCE_MS && end.at <= 1800 + END_SILENCE_MS + 2 * STEP, `ended at ${end.at}`);
});

test('a busy shop: the background never counts as speech, the voice over it does', () => {
  assert.equal(play([[NO_SPEECH_MS + 100, BUSY_SHOP]]).heard, 'nothing');
  const end = play([[300, BUSY_SHOP], [1200, VOICE], [3000, BUSY_SHOP]]);
  assert.equal(end.heard, 'done');
  assert.ok(end.at < 1500 + END_SILENCE_MS + 2 * STEP);
});

test('short pauses between words do not end it', () => {
  const end = play([[300, QUIET_ROOM], [600, VOICE], [500, QUIET_ROOM], [600, VOICE], [3000, QUIET_ROOM]]);
  assert.equal(end.heard, 'done');
  assert.ok(end.at >= 2000 + END_SILENCE_MS);
});

test('a clang from the kitchen is not speech: nothing is sent', () => {
  assert.equal(play([[300, BUSY_SHOP], [100, 0.6], [NO_SPEECH_MS, BUSY_SHOP]]).heard, 'nothing');
});

test('nobody speaks: nothing after five seconds', () => {
  const end = play([[NO_SPEECH_MS * 2, QUIET_ROOM]]);
  assert.deepEqual(end, { heard: 'nothing', at: NO_SPEECH_MS });
});

test('someone who keeps talking is cut off at the longest request, and it is sent', () => {
  const end = play([[200, QUIET_ROOM], [MAX_LISTEN_MS * 2, VOICE]]);
  assert.deepEqual(end, { heard: 'done', at: MAX_LISTEN_MS });
});

test('speech that starts at once, with no quiet first, still counts once a pause shows the room', () => {
  assert.equal(play([[800, VOICE], [200, QUIET_ROOM], [800, VOICE], [3000, QUIET_ROOM]]).heard, 'done');
});

test('loudness is the root mean square of the samples', () => {
  assert.equal(loudness([]), 0);
  assert.equal(loudness([0.5, -0.5, 0.5, -0.5]), 0.5);
});
