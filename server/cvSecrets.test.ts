import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cvSecrets } from './cvSecrets.ts';

const folder = () => mkdtempSync(join(tmpdir(), 'cb-secrets-'));

test('camera logins are kept encrypted (AES-256-GCM) beside a random 32-byte key, and read back after a restart', () => {
  const dir = folder();
  const s = cvSecrets(dir);
  assert.equal(s.get('c1'), null);
  s.set('c1', { user: 'admin', password: 'hunter2' });
  s.set('c2', { user: 'tapo-cam', password: 'Pässwörd/@:1' });
  assert.equal(readFileSync(join(dir, 'cv-secrets.key')).length, 32);
  const file = readFileSync(join(dir, 'cv-secrets.json'), 'utf8');
  assert.doesNotMatch(file, /hunter2|admin|tapo-cam|Pässwörd/, 'nothing readable in the file');

  const again = cvSecrets(dir);
  assert.deepEqual(again.get('c1'), { user: 'admin', password: 'hunter2' });
  assert.deepEqual(again.get('c2'), { user: 'tapo-cam', password: 'Pässwörd/@:1' });
  assert.deepEqual(again.summary(), { c1: { user: 'admin', passwordSet: true }, c2: { user: 'tapo-cam', passwordSet: true } }, 'the screen learns "password set", never the password');
  rmSync(dir, { recursive: true, force: true });
});

test('a new username keeps the password; removed cameras lose their login', () => {
  const dir = folder();
  const s = cvSecrets(dir);
  s.set('c1', { user: 'admin', password: 'hunter2' });
  s.set('c1', { user: 'viewer' });
  assert.deepEqual(s.get('c1'), { user: 'viewer', password: 'hunter2' });
  s.set('c2', { user: 'x', password: 'y' });
  s.keepOnly(['c2']);
  assert.equal(s.get('c1'), null);
  assert.deepEqual(cvSecrets(dir).summary(), { c2: { user: 'x', passwordSet: true } });
  rmSync(dir, { recursive: true, force: true });
});

test('a tampered file or another key reads as no login, never as garbage', () => {
  const dir = folder();
  cvSecrets(dir).set('c1', { user: 'admin', password: 'hunter2' });
  const raw = JSON.parse(readFileSync(join(dir, 'cv-secrets.json'), 'utf8'));
  raw.c1.data = Buffer.from('nope').toString('base64');
  writeFileSync(join(dir, 'cv-secrets.json'), JSON.stringify(raw));
  assert.equal(cvSecrets(dir).get('c1'), null);
  rmSync(dir, { recursive: true, force: true });
});
