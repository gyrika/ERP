import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { PIN_LENGTH } from '../src/domain/auth.ts';

/**
 * PINs are only ever stored as a salted scrypt hash. A 4-digit PIN has just
 * 10,000 values, so the real protection is that the hashes never leave the
 * server and that wrong guesses are slowed down (see app.ts); scrypt makes a
 * stolen copy of the table expensive to try, not impossible.
 */
export const isPin = (pin: unknown): pin is string => typeof pin === 'string' && new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);

const derive = (pin: string, salt: string): Promise<Buffer> =>
  new Promise((resolve, reject) => scrypt(pin, salt, 32, (err, key) => (err ? reject(err) : resolve(key))));

export const hashPin = async (pin: string): Promise<{ salt: string; hash: string }> => {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: (await derive(pin, salt)).toString('hex') };
};

export const pinMatches = async (pin: string, salt: string, hash: string): Promise<boolean> =>
  timingSafeEqual(await derive(pin, salt), Buffer.from(hash, 'hex'));
