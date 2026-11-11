import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The customer list's own key (CRM): numbers and names are sealed in the database, so a copy of
 * pos.sqlite (or a MySQL dump) alone shows nobody's phone. One random 32-byte key in <data>\crm.key
 * (on CheesyBeez Station: C:\ProgramData\CheesyBeez, locked to SYSTEM and Administrators), made the
 * first time; two keys are derived from it, one to seal and one to fingerprint numbers.
 *
 * Back it up WITH the database but kept apart: without it the customer list cannot be read.
 */
export interface CrmCrypto {
  seal(text: string): string;
  /** null: tampered, or sealed with another key. */
  open(sealed: string): string | null;
  /** Finds a number without opening anything, and keeps it once per shop (keyed, so not guessable from a list of numbers). */
  phoneHash(phone: string): string;
}

const VERSION = 'v1.';

export function crmCryptoFromKey(key: Buffer): CrmCrypto {
  if (key.length !== 32) throw new Error('the CRM key must be 32 bytes');
  const sealKey = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'cheesybeez crm seal', 32));
  const hashKey = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'cheesybeez crm phone', 32));
  return {
    seal(text) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', sealKey, iv);
      const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
      return VERSION + Buffer.concat([iv, c.getAuthTag(), data]).toString('base64url');
    },
    open(sealed) {
      if (!sealed.startsWith(VERSION)) return null;
      const all = Buffer.from(sealed.slice(VERSION.length), 'base64url');
      if (all.length < 28) return null;
      try {
        const d = createDecipheriv('aes-256-gcm', sealKey, all.subarray(0, 12));
        d.setAuthTag(all.subarray(12, 28));
        return Buffer.concat([d.update(all.subarray(28)), d.final()]).toString('utf8');
      } catch {
        return null;
      }
    },
    phoneHash: (phone) => createHmac('sha256', hashKey).update(phone, 'utf8').digest('hex'),
  };
}

/** The shop's key from <dir>\crm.key, made the first time. */
export function crmCrypto(dir: string): CrmCrypto {
  const file = join(dir, 'crm.key');
  let key: Buffer | null = existsSync(file) ? readFileSync(file) : null;
  if (!key || key.length !== 32) {
    if (key) throw new Error(`${file} is not a CRM key: restore it from the backup (customers cannot be read without it)`);
    mkdirSync(dir, { recursive: true });
    key = randomBytes(32);
    writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
  }
  return crmCryptoFromKey(key);
}
