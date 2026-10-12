import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dryRunPrinter } from './printer.ts';

test('dry run saves each receipt as its exact bytes, in order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cb-prints-'));
  try {
    const p = dryRunPrinter(dir);
    await Promise.all([p.print(Uint8Array.from([1, 2])), p.print(Uint8Array.from([3]))]);
    const files = (await readdir(dir)).sort((a, b) => Number(a.split('-').at(-1)!.split('.')[0]) - Number(b.split('-').at(-1)!.split('.')[0]));
    assert.equal(files.length, 2);
    assert.deepEqual([...await readFile(join(dir, files[0]))], [1, 2]);
    assert.deepEqual([...await readFile(join(dir, files[1]))], [3]);
  } finally {
    await rm(dir, { recursive: true });
  }
});
