import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mismatches, replay } from './replay.ts';
import { REPLAY_CLIPS, TOLERANCE_S } from './replayClips.ts';

// The real detector on stock clips (server/cv/replayClips.ts). Needs the CV pack (CV_PACK_DIR) and the
// clips (npm run cv:clips); without them each clip is skipped, so the usual npm test stays fast.
const pack = process.env.CV_PACK_DIR;
const clips = fileURLToPath(new URL('../../test-assets/cv-clips/', import.meta.url));

for (const clip of REPLAY_CLIPS) {
  const file = join(clips, clip.name, 'clip.mp4');
  const why = !pack ? 'set CV_PACK_DIR to run it' : !existsSync(file) ? 'run npm run cv:clips first' : false;
  test(`replay ${clip.name}: ${clip.expect.map((e) => `${e.tableId} ${e.to} at ${e.atS} s`).join(', ') || 'no change'}`, { skip: why }, async () => {
    const r = await replay(clip, file, { packDir: pack! });
    const mean = r.detectMs.reduce((s, x) => s + x, 0) / Math.max(1, r.detectMs.length);
    console.log(`${clip.name}: ${r.frames} frames, ${r.detectMs.length} detections, ${mean.toFixed(0)} ms each; changes ${JSON.stringify(r.changes)}`);
    assert.deepEqual(mismatches(clip, r.changes, TOLERANCE_S), []);
  });
}
