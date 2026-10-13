/**
 * Makes the developer's /admin password and stores it as the Worker secret ADMIN_KEY.
 *
 *   npm run admin-key                 the live cloud
 *   npm run admin-key -- --staging    the test cloud
 *
 * Run it in your own terminal (not through an assistant): the password is shown here
 * once. Keep it in a password manager; running this again makes a new one and the old
 * one stops working (every signed-in browser is signed out).
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const staging = process.argv.includes('--staging');
const key = randomBytes(32).toString('base64url'); // 43 characters: cannot be guessed

const put = spawnSync('npx', ['wrangler', 'secret', 'put', 'ADMIN_KEY', ...(staging ? ['--env', 'staging'] : [])], {
  input: key, stdio: ['pipe', 'inherit', 'inherit'], shell: process.platform === 'win32',
});
if (put.status !== 0) {
  console.error('\nThe password was not stored (wrangler failed). Nothing changed.');
  process.exit(1);
}
console.log(`
Admin password for the ${staging ? 'test' : 'live'} cloud (shown once, save it now):

  ${key}

Sign in at https://cheesybeez-cloud${staging ? '-staging' : ''}.cheesybeez-cloud.workers.dev/admin
`);
