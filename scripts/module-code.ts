/**
 * The developers' module codes (server/modules.ts, src/domain/modules.ts).
 *
 *   npm run module:key
 *     Makes the developers' key pair, once. The PRIVATE key goes to a file outside the repo
 *     (CB_MODULE_KEY, else ~/.cheesybeez/module-signing-key.pem) and is never printed; the PUBLIC key
 *     is written into server/moduleKey.ts. Keep a copy of the private key in the team's password
 *     manager: without it no shop can be given a code again (a new pair means a new release).
 *
 *   npm run module:code -- --shop <shop id> --module crm --on     (or --off; --days N, default 7)
 *     Prints a one-time code for that shop. The shop's id is on its #unlock page.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isModuleId, MODULES } from '../src/domain/modules.ts';
import { grantFor, newModuleKeys, signModuleCode } from '../server/modules.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keyFile = resolve(process.env.CB_MODULE_KEY ?? join(homedir(), '.cheesybeez', 'module-signing-key.pem'));
const publicFile = join(repo, 'server', 'moduleKey.ts');

const fail = (message: string): never => { console.error(message); process.exit(1); };
const inRepo = (p: string) => { const r = relative(repo, p); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };

const publicSource = (pem: string) => `/**
 * The developers' PUBLIC key for module codes (server/modules.ts). It can check a code, never make
 * one. Written by \`npm run module:key\`, which keeps the private half outside the repo.
 * null: no key made yet, so no module can be turned on.
 */
export const MODULE_PUBLIC_KEY: string | null = ${JSON.stringify(pem)};
`;

const [command, ...args] = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

if (command === 'key') {
  if (inRepo(keyFile)) fail(`refused: ${keyFile} is inside the repo, where it could be committed. Pick a path outside it (CB_MODULE_KEY).`);
  if (existsSync(keyFile)) fail(`there is already a key at ${keyFile}; nothing changed. (A new pair would make every shop's key wrong.)`);
  const { privateKeyPem, publicKeyPem } = newModuleKeys();
  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, privateKeyPem, { mode: 0o600, flag: 'wx' });
  writeFileSync(publicFile, publicSource(publicKeyPem));
  console.log(`Private key saved to ${keyFile} (not shown). Copy that file into the team's password manager.`);
  console.log(`Public key written to ${relative(repo, publicFile)}: commit it.`);
} else if (command === 'code') {
  const shop = value('shop');
  const module = value('module');
  if (!shop || !/^[a-z0-9-]{1,64}$/.test(shop)) fail('--shop <shop id> (shown on the shop\'s #unlock page)');
  if (!isModuleId(module)) fail(`--module ${MODULES.join(' | ')}`);
  if (flag('on') === flag('off')) fail('--on or --off');
  const days = Number(value('days') ?? 7);
  if (!Number.isInteger(days) || days < 1 || days > 90) fail('--days 1 to 90');
  if (!existsSync(keyFile)) fail(`no private key at ${keyFile}: run npm run module:key once, or set CB_MODULE_KEY to the team's copy.`);
  const grant = grantFor(shop!, module as never, flag('on'), Date.now(), days);
  console.log(signModuleCode(grant, readFileSync(keyFile, 'utf8')));
  console.error(`(${module} ${flag('on') ? 'on' : 'off'} for ${shop}, works once, until ${new Date(grant.until).toLocaleString('en-GB')})`);
} else {
  fail('npm run module:key   |   npm run module:code -- --shop <id> --module crm --on|--off [--days N]');
}
