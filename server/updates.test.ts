import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNewer, updatesApi } from './updates.ts';

const github = (tag: string, status = 200) => (async () =>
  (status === 200 ? Response.json({ tag_name: tag }) : new Response('{}', { status }))) as unknown as typeof fetch;

function station(version: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'cb-station-'));
  if (version !== null) writeFileSync(join(dir, 'version.txt'), version);
  writeFileSync(join(dir, 'station-update.ps1'), '# updater');
  return { dir, versionFile: join(dir, 'version.txt'), updaterScript: join(dir, 'station-update.ps1'), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('versions compare part by part', () => {
  assert.equal(isNewer('1.0.1', '1.0.0'), true);
  assert.equal(isNewer('1.0.10', '1.0.9'), true, 'not as text: 10 > 9');
  assert.equal(isNewer('1.0.0', '1.0.0'), false);
  assert.equal(isNewer('1.0.0', '1.0.3'), false);
  assert.equal(isNewer('1.0.0', '0.0.3'), true, 'a test build gives way to the first release');
  assert.equal(isNewer('1.1', '1.0.9'), true);
  assert.equal(isNewer('nightly', '1.0.0'), false, 'never an odd tag');
  assert.equal(isNewer('2.0.0', 'development'), false);
});

test("check: the installed version and GitHub's latest", async () => {
  const s = station('1.0.0');
  assert.deepEqual(await updatesApi({ ...s, fetch: github('v1.0.1') }).check(), { current: '1.0.0', latest: '1.0.1', newer: true });
  assert.deepEqual(await updatesApi({ ...s, fetch: github('v1.0.0') }).check(), { current: '1.0.0', latest: '1.0.0', newer: false });
  await assert.rejects(updatesApi({ ...s, fetch: github('', 503) }).check(), /GitHub answered 503/);
  s.done();
});

test('install: runs the Station updater (forced), only on Windows inside a Station', async () => {
  const s = station('1.0.0');
  const ran: string[][] = [];
  const run = (command: string, args: string[]) => ran.push([command, ...args]);
  assert.throws(() => updatesApi({ ...s, platform: 'linux', run }).install(), /on Windows/);
  updatesApi({ ...s, platform: 'win32', run }).install();
  await new Promise((r) => setTimeout(r, 600)); // it starts a moment later, after the reply
  assert.deepEqual(ran, [['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', s.updaterScript, '-Force']]);
  s.done();

  const dev = station(null);
  assert.equal(updatesApi(dev).current(), 'development');
  assert.throws(() => updatesApi({ ...dev, platform: 'win32', run }).install(), /on Windows/, 'never in development');
  dev.done();
});

test("status: the updater's latest step for the progress bar; nothing (not an error) when there is none or it is half written", () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-status-'));
  const statusFile = join(dir, 'update-status.json');
  try {
    const u = updatesApi({ versionFile: join(dir, 'version.txt'), updaterScript: join(dir, 'x.ps1'), statusFile });
    assert.equal(u.status(), null);
    writeFileSync(statusFile, '﻿{"phase":"downloading","percent":37,"version":"1.0.4","at":5}');
    assert.deepEqual(u.status(), { phase: 'downloading', percent: 37, version: '1.0.4', at: 5 });
    writeFileSync(statusFile, '{"phase":"down');
    assert.equal(u.status(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
