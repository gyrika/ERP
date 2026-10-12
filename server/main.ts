import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createPool } from 'mysql2/promise';
import { createApp } from './app.ts';
import { dryRunPrinter, switchablePrinter, systemPrinter } from './printer.ts';
import { startReplicator } from './replicator.ts';
import { settingsFile } from './settings.ts';
import { setupApi } from './setup.ts';
import { sqliteStore } from './sqliteStore.ts';
import { memoryStore, mysqlStore, type EventStore } from './store.ts';

/**
 * Starts the shop server on the counter PC. With nothing configured it keeps
 * everything in a built-in database file and the POS opens on the setup
 * wizard (shop, printer, staff, devices). Optional settings (server/.env):
 *   DATABASE_URL  mysql://pos_app:<password>@localhost:3306/cheesybeez  (use MySQL instead)
 *   DATA_DIR      where the built-in database and settings live (default server/data)
 *   MEMORY=1      keep nothing (tests, a quick look)
 *   PORT          default 8080
 *   PRINTER       a printer name, if the wizard has not chosen one
 *   CLOUD_URL, CLOUD_TOKEN, CLOUD_SHOP  the cloud copy (docs/cloud.md)
 */
const port = Number(process.env.PORT ?? 8080);
const dataDir = (process.env.DATA_DIR ?? fileURLToPath(new URL('./data/', import.meta.url))).replace(/[\\/]$/, '');
// Dry-run receipts live with the data when there is a data folder (CheesyBeez Station: C:\ProgramData\CheesyBeez).
const printsDir = process.env.DATA_DIR ? `${dataDir}/prints` : fileURLToPath(new URL('./prints', import.meta.url));

let store: EventStore;
let storeName: string;
if (process.env.DATABASE_URL) {
  store = mysqlStore(createPool({ uri: process.env.DATABASE_URL, connectionLimit: 10, supportBigNumbers: true }));
  storeName = 'MySQL';
} else if (process.env.MEMORY === '1') {
  store = memoryStore();
  storeName = 'memory only (nothing is kept)';
} else {
  store = sqliteStore(`${dataDir}/pos.sqlite`);
  storeName = `built-in (${dataDir}/pos.sqlite)`;
}

const settings = settingsFile(`${dataDir}/settings.json`);
const chosen = settings.get().printer ?? process.env.PRINTER;
const printer = switchablePrinter(chosen ? systemPrinter(chosen) : dryRunPrinter(printsDir));

const cloudUrl = process.env.CLOUD_URL?.replace(/\/$/, '');
const cloud = cloudUrl && process.env.CLOUD_TOKEN ? { url: cloudUrl, token: process.env.CLOUD_TOKEN } : null;
const cloudShop = process.env.CLOUD_SHOP ?? settings.get().shopId;
const replicator = cloud && cloudShop
  ? startReplicator({ store, tenantId: cloudShop, url: cloud.url, token: cloud.token })
  : null;

const server = createApp({
  store,
  staticDir: fileURLToPath(new URL('../dist', import.meta.url)),
  printer,
  onStored: (tenantId) => { if (tenantId === cloudShop) replicator?.nudge(); },
  cloudStatus: () => replicator?.status() ?? null,
  setup: setupApi({ store, settings, usePrinter: printer.use, printsDir, port, cloud }),
});

server.listen(port, '0.0.0.0', () => {
  const s = settings.get();
  const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
  console.log(`CheesyBeez server on http://localhost:${port}${lan ? `  (shop Wi-Fi: http://${lan}:${port})` : ''}`);
  console.log(`  shop: ${s.setupDone ? `${s.shopName} (${s.shopId})` : 'not set up yet: open the address above on this PC'}`);
  console.log(`  database: ${storeName}`);
  console.log(`  receipt printer: ${printer.name}`);
  console.log(`  cloud copy: ${replicator ? `${cloudShop} -> ${cloud!.url}` : 'off'}`);
});

const stop = () => { replicator?.stop(); server.close(() => { void store.close().then(() => process.exit(0)); }); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
