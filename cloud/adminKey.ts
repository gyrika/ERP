/**
 * Makes the developer's admin password, stores it as the Worker secret ADMIN_KEY, and
 * saves it on this laptop (server/.env, CLOUD_ADMIN_KEY) for the Shops screen. Nothing
 * to copy or remember: for the website (/admin), the password is in that file.
 *
 *   npm run admin-key                 the live cloud
 *   npm run admin-key -- --staging    the test cloud (also sets CLOUD_ADMIN_URL to it)
 *
 * Running it again makes a new password: the old one stops working everywhere.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const staging = process.argv.includes('--staging');
const key = randomBytes(32).toString('base64url'); // 43 characters: cannot be guessed
const url = `https://cheesybeez-cloud${staging ? '-staging' : ''}.cheesybeez-cloud.workers.dev`;

const put = spawnSync('npx', ['wrangler', 'secret', 'put', 'ADMIN_KEY', ...(staging ? ['--env', 'staging'] : [])], {
  input: key, stdio: ['pipe', 'inherit', 'inherit'], shell: process.platform === 'win32',
});
if (put.status !== 0) {
  console.error('\nThe password was not stored (wrangler failed). Nothing changed.');
  process.exit(1);
}

// This laptop's server settings: set (or replace) the two lines, keep everything else.
const envFile = fileURLToPath(new URL('../server/.env', import.meta.url));
const lines = (existsSync(envFile) ? readFileSync(envFile, 'utf8') : '').split('\n')
  .filter((l) => !/^\s*CLOUD_ADMIN_(KEY|URL)\s*=/.test(l));
while (lines.length && lines.at(-1) === '') lines.pop();
lines.push(`CLOUD_ADMIN_KEY=${key}`, `CLOUD_ADMIN_URL=${url}`, '');
writeFileSync(envFile, lines.join('\n'), { mode: 0o600 });

console.log(`
New admin password stored in the ${staging ? 'test' : 'live'} cloud, and saved on this laptop
in server/.env (CLOUD_ADMIN_KEY). Restart the local server (npm run server) for the Shops screen.
For the website ${url}/admin, copy it from that file.
`);
