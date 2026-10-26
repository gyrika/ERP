import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The cameras' logins (SCRUM-171), on the shop PC only: AES-256-GCM in <data>\cv-secrets.json, with a
 * random 32-byte key in cv-secrets.key beside it. On CheesyBeez Station <data> is
 * C:\ProgramData\CheesyBeez, which station-install.ps1 locks to SYSTEM and Administrators.
 * Never logged, never in an event or an API answer: the screen learns the username and "password set".
 */
export interface CameraLogin { user: string; password: string }
interface Sealed { iv: string; tag: string; data: string }

export function cvSecrets(dir: string) {
  const file = join(dir, 'cv-secrets.json');
  const keyFile = join(dir, 'cv-secrets.key');
  let key: Buffer | null = null;
  const theKey = (): Buffer => {
    if (key) return key;
    if (existsSync(keyFile)) key = readFileSync(keyFile);
    if (!key || key.length !== 32) {
      mkdirSync(dir, { recursive: true });
      key = randomBytes(32);
      writeFileSync(keyFile, key, { mode: 0o600 });
    }
    return key;
  };
  const readAll = (): Record<string, Sealed> => {
    try { return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, Sealed>) : {}; } catch { return {}; }
  };
  /** Written whole via a temporary file, so a power cut never leaves half a file. */
  const writeAll = (all: Record<string, Sealed>) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(all), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  };
  const seal = (login: CameraLogin): Sealed => {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', theKey(), iv);
    const data = Buffer.concat([c.update(JSON.stringify(login), 'utf8'), c.final()]);
    return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
  };
  const open = (s: Sealed | undefined): CameraLogin | null => {
    if (!s || !existsSync(keyFile)) return null;
    try {
      const d = createDecipheriv('aes-256-gcm', theKey(), Buffer.from(s.iv, 'base64'));
      d.setAuthTag(Buffer.from(s.tag, 'base64'));
      const login = JSON.parse(Buffer.concat([d.update(Buffer.from(s.data, 'base64')), d.final()]).toString('utf8')) as CameraLogin;
      return typeof login.user === 'string' && typeof login.password === 'string' ? login : null;
    } catch {
      return null; // tampered, or sealed with another key
    }
  };

  return {
    get: (cameraId: string): CameraLogin | null => open(readAll()[cameraId]),

    /** A new username alone keeps the password already kept. */
    set(cameraId: string, login: { user: string; password?: string }): void {
      const all = readAll();
      const password = login.password ?? open(all[cameraId])?.password ?? '';
      all[cameraId] = seal({ user: login.user, password });
      writeAll(all);
    },

    /** Cameras the owner removed take their login with them. */
    keepOnly(cameraIds: readonly string[]): void {
      const all = readAll();
      const kept = Object.fromEntries(Object.entries(all).filter(([id]) => cameraIds.includes(id)));
      if (Object.keys(kept).length !== Object.keys(all).length) writeAll(kept);
    },

    /** What the screen may know. */
    summary(): Record<string, { user: string; passwordSet: boolean }> {
      const out: Record<string, { user: string; passwordSet: boolean }> = {};
      for (const [id, s] of Object.entries(readAll())) {
        const login = open(s);
        if (login) out[id] = { user: login.user, passwordSet: login.password.length > 0 };
      }
      return out;
    },
  };
}
export type CvSecrets = ReturnType<typeof cvSecrets>;
