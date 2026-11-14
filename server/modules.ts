import { pinMatches } from './pins.ts';

/**
 * The developers' password for modules (src/domain/modules.ts): typed on #unlock on the shop PC to
 * turn a module on or off. Only its salted scrypt hash is here, on the shop server; the password is
 * never in the app the browser downloads, and wrong tries are slowed down (server/setup.ts).
 * To change it: hashPin(<new password>) from server/pins.ts, and replace both values.
 */
export const MODULE_PASSWORD = { salt: '97610c8a080e57514039473609a37696', hash: '7b02b1bf98f9174ab8f7772bf6e509805177f311098c8799f3e96b690715cc2c' } as const;

export type PasswordHash = { salt: string; hash: string };

export const modulePasswordMatches = async (password: unknown, expected: PasswordHash = MODULE_PASSWORD): Promise<boolean> =>
  typeof password === 'string' && password.length > 0 && password.length <= 200 && pinMatches(password, expected.salt, expected.hash);
