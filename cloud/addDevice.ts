import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

/**
 * Registers a device with the cloud copy and prints its settings, once. The
 * token is stored in D1 only as a SHA-256 hash, so a lost token means a new device.
 *   npm run device -- --shop cheesybeez-thalwila --name "CheesyBeez Thalwila"            (the shop server)
 *   npm run device -- --shop cheesybeez-thalwila --kind owner --url <cloud address>     (the owner's phone)
 *   add --local to register in the local test database (wrangler dev) instead of the real one.
 */
const { values } = parseArgs({
  options: {
    shop: { type: 'string' },
    name: { type: 'string' },
    kind: { type: 'string', default: 'shop_server' },
    local: { type: 'boolean', default: false },
    url: { type: 'string' },
  },
});
const fail = (msg: string): never => { console.error(msg); process.exit(1); };
const shop = values.shop ?? fail('--shop is required: the same shop id the shop server uses.');
if (!/^[a-z0-9-]{1,64}$/.test(shop)) fail('--shop: lowercase letters, digits and dashes only.');
if (!['shop_server', 'owner'].includes(values.kind!)) fail('--kind must be shop_server or owner.');
const name = (values.name ?? shop).replace(/'/g, "''");

const token = randomBytes(32).toString('base64url');
const hash = createHash('sha256').update(token).digest('hex');
const id = `cloud-${randomBytes(8).toString('hex')}`;
const t = Date.now();
const sql = `INSERT OR IGNORE INTO shops (id, name, created_at) VALUES ('${shop}', '${name}', ${t});
INSERT INTO devices (id, tenant_id, kind, token_hash, created_at) VALUES ('${id}', '${shop}', '${values.kind}', '${hash}', ${t});`;

execFileSync('npx', ['wrangler', 'd1', 'execute', 'cheesybeez-cloud', values.local ? '--local' : '--remote', '--command', sql],
  { stdio: ['ignore', 'ignore', 'inherit'], cwd: import.meta.dirname });

console.log(`Device ${id} (${values.kind}) added to ${shop} in the ${values.local ? 'local' : 'real'} cloud database.`);
if (values.kind === 'shop_server') {
  console.log('\nAdd these lines to server/.env on the shop server, then restart it:\n');
  console.log(`CLOUD_URL=${values.url ?? (values.local ? 'http://localhost:8787' : 'https://cheesybeez-cloud.<your-subdomain>.workers.dev')}`);
  console.log(`CLOUD_TOKEN=${token}`);
  console.log(`CLOUD_SHOP=${shop}`);
} else {
  const base = values.url ?? (values.local ? 'http://localhost:8787' : 'https://cheesybeez-cloud.<your-subdomain>.workers.dev');
  console.log(`\nOpen this once on the owner's phone (it is the key: keep it private):\n  ${base}/?owner=${token}#owner`);
}
