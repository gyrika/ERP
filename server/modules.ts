import { pinMatches } from './pins.ts';

/**
 * The developers' password for modules (src/domain/modules.ts): typed on #unlock on the shop PC to
 * turn a module on or off. Only its salted scrypt hash is here, on the shop server; the password is
 * never in the app the browser downloads, and wrong tries are slowed down (server/setup.ts).
 * To change it: hashPin(<new password>) from server/pins.ts, and replace both values.
 */
export const MODULE_PASSWORD = { salt: '59b36f05d9fe42a388cacdc701a6d78b', hash: '6e6410d3c3b886f9dac0dc563b798bf59ef875d0ee67b62a04a91ccba4dd480e' } as const;

export type PasswordHash = { salt: string; hash: string };

export const modulePasswordMatches = async (password: unknown, expected: PasswordHash = MODULE_PASSWORD): Promise<boolean> =>
  typeof password === 'string' && password.length > 0 && password.length <= 200 && pinMatches(password, expected.salt, expected.hash);
