import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createPool } from 'mysql2/promise';
import { createApp } from './app.ts';
import { dryRunPrinter, systemPrinter } from './printer.ts';
import { startReplicator } from './replicator.ts';
import { memoryStore, mysqlStore, type EventStore } from './store.ts';

/**
 * Starts the sync server on the counter PC (docs/server-setup.md).
 *   DATABASE_URL  mysql://pos_app:<password>@localhost:3306/cheesybeez
 *                 (omit it to try the server out: memory only, with a counter and a kitchen device
 *                 made up for SHOP_ID, whose pairing links are printed, and try-out staff)
 *   PORT          default 8080
 *   PRINTER       the Windows printer name of the XP-80T, e.g. "XP-80T"
 *                 (omit: dry run, receipts are saved to server/prints/ instead)
 *   CLOUD_URL, CLOUD_TOKEN, CLOUD_SHOP
 *                 the cloud copy (SCRUM-61): where to copy this shop's events, as which device,
 *                 and which shop (npm run device in cloud/ prints all three). Omit: no cloud copy.
 */
const port = Number(process.env.PORT ?? 8080);
const url = process.env.DATABASE_URL;

let store: EventStore;
if (url) {
  store = mysqlStore(createPool({ uri: url, connectionLimit: 10, supportBigNumbers: true }));
} else {
  console.warn('DATABASE_URL is not set: events are kept in memory and LOST when the server stops.');
  store = memoryStore();
  const shop = process.env.SHOP_ID ?? 'shop-demo-cheesybeez';
  for (const kind of ['counter', 'kitchen'] as const) {
    const { token } = await store.addDevice(shop, 'Try-out', kind);
    console.log(`  ${kind} pairing link: http://localhost:${port}/?pair=${token}&shop=${encodeURIComponent(shop)}${kind === 'kitchen' ? '&as=kitchen#kitchen' : ''}`);
  }
  // Try-out staff, the same PINs as the app's fake staff (src/fake/data.ts).
  await store.addStaff(shop, 'Nimal', 'cashier', '1111');
  await store.addStaff(shop, 'Ravi', 'manager', '2580');
  console.log('  try-out PINs: 1111 (cashier Nimal), 2580 (manager Ravi)');
}

const staticDir = fileURLToPath(new URL('../dist', import.meta.url));
const printer = process.env.PRINTER
  ? systemPrinter(process.env.PRINTER)
  : dryRunPrinter(fileURLToPath(new URL('./prints', import.meta.url)));
const cloudEnv = { url: process.env.CLOUD_URL, token: process.env.CLOUD_TOKEN, shop: process.env.CLOUD_SHOP };
const replicator = cloudEnv.url && cloudEnv.token && cloudEnv.shop
  ? startReplicator({ store, tenantId: cloudEnv.shop, url: cloudEnv.url.replace(/\/$/, ''), token: cloudEnv.token })
  : null;
const server = createApp({
  store, staticDir, printer,
  onStored: (tenantId) => { if (tenantId === cloudEnv.shop) replicator?.nudge(); },
  cloudStatus: () => replicator?.status() ?? null,
});

server.listen(port, '0.0.0.0', () => {
  const addresses = Object.values(networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a!.address);
  console.log(`CheesyBeez server on http://localhost:${port}`);
  console.log(`  receipt printer: ${printer.name}`);
  console.log(`  cloud copy: ${replicator ? `${cloudEnv.shop} -> ${cloudEnv.url}` : 'off (CLOUD_URL not set)'}`);
  for (const a of addresses) console.log(`  kitchen device: http://${a}:${port}/#kitchen`);
});

const stop = () => { replicator?.stop(); server.close(() => { void store.close().then(() => process.exit(0)); }); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
