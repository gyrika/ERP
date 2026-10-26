// Fetches the stock clips the camera worker is replayed against (server/cv/replayClips.ts) and
// builds each replay clip with the CV pack's ffmpeg. Nothing here goes into git: the files land in
// test-assets/cv-clips/<name>/ (git-ignored), each in its own folder with a README of where it came from.
//
//   set CV_PACK_DIR=C:\cv-pack        (ffmpeg.exe, node_modules\onnxruntime-node, models\yolox_nano.onnx)
//   npm run cv:clips                  (then: npm run cv:replay, or npm run test:domain with CV_PACK_DIR set)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPLAY_CLIPS } from '../server/cv/replayClips.ts';

export const CLIPS_DIR = fileURLToPath(new URL('../test-assets/cv-clips/', import.meta.url));

const pack = process.env.CV_PACK_DIR;
if (!pack) { console.error('Set CV_PACK_DIR to the unpacked CV pack (its ffmpeg.exe builds the clips).'); process.exit(2); }
const ffmpeg = join(pack, 'ffmpeg.exe');

const run = (args: string[]) => {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status ?? r.error?.message})`);
};

mkdirSync(CLIPS_DIR, { recursive: true });
writeFileSync(join(CLIPS_DIR, 'README.md'), `# Replay clips for the camera worker (not in git)

Built by \`npm run cv:clips\` from free stock videos on Pexels, under the Pexels licence
(https://www.pexels.com/license/: free to use and change; no attribution needed). They are kept out
of git because the licence does not allow handing on unaltered copies. Each folder holds the
download (source.mp4), the replay clip (clip.mp4, 640x360) and a README with its page.
Zones and the expected table changes: server/cv/replayClips.ts.

Add your own: 3-4 phone videos of the shop, 2-5 minutes each, filmed from a high corner like a
camera would be, with their zones and what happens at each table.
`);

for (const clip of REPLAY_CLIPS.filter((c) => !c.file)) {
  const dir = join(CLIPS_DIR, clip.name);
  mkdirSync(dir, { recursive: true });
  const source = join(dir, 'source.mp4');
  if (!existsSync(source)) {
    console.log(`${clip.name}: downloading ${clip.pexels.page}`);
    const r = await fetch(`https://www.pexels.com/download/video/${clip.pexels.id}/`, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`${clip.name}: Pexels answered ${r.status}`);
    writeFileSync(source, Buffer.from(await r.arrayBuffer()));
  }
  // Each segment: the download looped, 640x360 at 10 fps, changed by its patch; then one after another.
  const parts = clip.segments.map((seg, i) => {
    const part = join(dir, `part-${i}.mp4`);
    const scale = `[0:v]scale=640:360,setsar=1,fps=10[s]`;
    run(['-stream_loop', '-1', '-i', source, '-t', String(seg.seconds), '-filter_complex', seg.patch ? `${scale};${seg.patch}` : scale.replace('[s]', '[v]'),
      '-map', '[v]', '-an', '-c:v', 'mpeg4', '-q:v', '3', part]);
    return part;
  });
  const list = join(dir, 'parts.txt');
  writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
  run(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', join(dir, 'clip.mp4')]);
  for (const p of [...parts, list]) rmSync(p, { force: true });
  writeFileSync(join(dir, 'README.md'), `# ${clip.name}\n\n${clip.what}\n\nSource: ${clip.pexels.page} (Pexels licence, https://www.pexels.com/license/).\n`);
  console.log(`${clip.name}: ${join(dir, 'clip.mp4')}`);
}
