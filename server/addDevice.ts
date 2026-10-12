import { parseArgs } from 'node:util';
import { createPool } from 'mysql2/promise';
import { mysqlStore, type DeviceKind } from './store.ts';

/**
 * Registers a device and prints its pairing link, once. Open the link on that
 * device: the app keeps the token and starts syncing. The token is stored on
 * the server only as a SHA-256 hash, so a lost link means a new device entry.
 *
 *   npm run server:device -- --kind counter --shop shop-demo-cheesybeez --name "CheesyBeez Thalwila"
 */
const { values } = parseArgs({
  options: {
    kind: { type: 'string', default: 'counter' },
    shop: { type: 'string' },
    name: { type: 'string', default: 'CheesyBeez' },
    host: { type: 'string', default: `localhost:${process.env.PORT ?? 8080}` },
  },
});

const kinds: DeviceKind[] = ['counter', 'kitchen', 'owner'];
if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL first (see docs/server-setup.md).'); process.exit(1); }
if (!values.shop) { console.error('--shop is required: the shop id the app stamps on its events.'); process.exit(1); }
if (!kinds.includes(values.kind as DeviceKind)) { console.error(`--kind must be one of ${kinds.join(', ')}`); process.exit(1); }

const store = mysqlStore(createPool({ uri: process.env.DATABASE_URL }));
const { device, token } = await store.addDevice(values.shop, values.name, values.kind as DeviceKind);
await store.close();

const extra = device.kind === 'kitchen' ? '&as=kitchen#kitchen' : '';
console.log(`Device ${device.id} (${device.kind}) added to ${device.tenantId}.`);
console.log(`Open this once on the device:\n  http://${values.host}/?pair=${token}&shop=${encodeURIComponent(device.tenantId)}${extra}`);
