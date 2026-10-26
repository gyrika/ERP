import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cvLog, dayOf, KEEP_DAYS } from './cvLog.ts';

const DAY = 86_400_000;

test('cv.log: one line each, logins masked, rotated daily, 14 days kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cvlog-'));
  try {
    // Noon, so the shop's day is the same in any time zone the test runs in.
    let now = new Date(2026, 9, 1, 12).getTime();
    const log = cvLog({ dir, now: () => now });
    // An old file from long ago, and one inside the 14 days.
    writeFileSync(join(dir, `cv-${dayOf(now - 20 * DAY)}.log`), 'old\n');
    writeFileSync(join(dir, `cv-${dayOf(now - 3 * DAY)}.log`), 'recent\n');
    log.write('cam1: ffmpeg stopped: rtsp://admin:s3cret@10.0.0.5:554/stream2 401\nsecond line');
    const text = readFileSync(join(dir, 'cv.log'), 'utf8');
    assert.match(text, /rtsp:\/\/\*\*\*@10\.0\.0\.5/);
    assert.doesNotMatch(text, /s3cret/);
    assert.equal(text.trim().split('\n').length, 1, 'one line per entry');
    now += DAY;
    log.write('next day');
    assert.equal(readFileSync(join(dir, 'cv.log'), 'utf8').includes('next day'), true);
    assert.ok(readFileSync(join(dir, `cv-${dayOf(now - DAY)}.log`), 'utf8').includes('ffmpeg stopped'));
    const files = readdirSync(dir).sort();
    assert.ok(!files.includes(`cv-${dayOf(now - 21 * DAY)}.log`), 'older than 14 days: gone');
    assert.ok(files.includes(`cv-${dayOf(now - 4 * DAY)}.log`));
    assert.equal(KEEP_DAYS, 14);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a cv.log left from an earlier day is rotated when the server starts again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cvlog-'));
  try {
    const now = new Date(2026, 9, 5, 12).getTime();
    cvLog({ dir, now: () => now - 2 * DAY }).write('before the restart');
    cvLog({ dir, now: () => now }).write('after');
    assert.ok(existsSync(join(dir, `cv-${dayOf(now - 2 * DAY)}.log`)));
    assert.doesNotMatch(readFileSync(join(dir, 'cv.log'), 'utf8'), /before/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
