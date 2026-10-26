import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createPool } from 'mysql2/promise';
import { createApp } from './app.ts';
import { photoFolder } from './photos.ts';
import { startManagerInbox } from './managerInbox.ts';
import type { Device } from './store.ts';
import { dryRunPrinter, switchablePrinter, systemPrinter } from './printer.ts';
import { startOnline, type Online } from './online.ts';
import { createFleet } from './fleet.ts';
import { cvPack } from './cvPack.ts';
import { cvSecrets } from './cvSecrets.ts';
import { startVision } from './cvWorker.ts';
import { devSources } from './cv/visionCore.ts';
import { startReplicator } from './replicator.ts';
import { settingsFile } from './settings.ts';
import { setupApi } from './setup.ts';
import { sqliteStore } from './sqliteStore.ts';
import { memoryStore, mysqlStore, type EventStore } from './store.ts';
import { activeUpdate } from '../src/domain/updating.ts';
import { updatesApi } from './updates.ts';

/**
 * Starts the shop server on the counter PC. With nothing configured it keeps
 * everything in a built-in database file and the POS opens on the setup
 * wizard (shop, printer, staff, devices). Optional settings (server/.env):
 *   DATABASE_URL  mysql://pos_app:<password>@localhost:3306/cheesybeez  (use MySQL instead)
 *   DATA_DIR      where the built-in database and settings live (default server/data)
 *   MEMORY=1      keep nothing (tests, a quick look)
 *   PORT          default 8080
 *   PRINTER       a printer name, if the wizard has not chosen one
 *   CLOUD_URL, CLOUD_TOKEN, CLOUD_SHOP  the cloud copy by hand (docs/cloud.md); normally the
 *                 wizard connects it with the shop code, and these are not needed
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

/** The CheesyBeez cloud copy (docs/cloud.md); a new shop joins it from the setup wizard. */
const DEFAULT_CLOUD_URL = 'https://cheesybeez-cloud.cheesybeez-cloud.workers.dev';
const cloudUrl = (process.env.CLOUD_URL || DEFAULT_CLOUD_URL).replace(/\/$/, '');
/** The cloud link: set by hand in the environment, or by the wizard (kept in the settings). */
const cloudLink = () => {
  if (process.env.CLOUD_TOKEN) return { url: cloudUrl, token: process.env.CLOUD_TOKEN };
  const s = settings.get();
  return s.cloudUrl && s.cloudToken ? { url: s.cloudUrl, token: s.cloudToken } : null;
};
const cloudShop = () => process.env.CLOUD_SHOP || settings.get().shopId; // empty = unset
// CheesyBeez Station puts these beside the program ({app}\version.txt, {app}\station-update.ps1).
const updates = updatesApi({
  versionFile: fileURLToPath(new URL('../../version.txt', import.meta.url)),
  updaterScript: fileURLToPath(new URL('../../station-update.ps1', import.meta.url)),
  statusFile: `${dataDir}/update-status.json`,
  nowFile: `${dataDir}/update-now.txt`,
});
// Table detection's downloads (SCRUM-169): off until the owner activates CV on #cameras.
const cv = cvPack({
  dir: `${dataDir}/cv-pack`,
  appVersion: updates.current,
  active: () => settings.get().cvActive === true,
  setActive: (on) => { settings.set({ cvActive: on }); },
});
cv.start();
let replicator: ReturnType<typeof startReplicator> | null = null;
let online: Online | null = null;
let inbox: ReturnType<typeof startManagerInbox> | null = null;
/** The local device the manager phones' events are filed under: made the first time one arrives. */
const inboxDevice = async (shop: string): Promise<Device> => {
  const id = settings.get().managerInboxDevice;
  if (id) return { id, tenantId: shop, kind: 'manager' };
  const { device } = await store.addDevice(shop, settings.get().shopName ?? shop, 'manager');
  settings.set({ managerInboxDevice: device.id });
  return device;
};
/** Copy to the cloud, and take online orders, when there is a link and a shop; again when the wizard connects it. */
const startCloud = () => {
  replicator?.stop();
  online?.stop();
  inbox?.stop();
  const link = cloudLink();
  const shop = cloudShop();
  replicator = link && shop ? startReplicator({
    store, tenantId: shop, url: link.url, token: link.token,
    about: () => ({ version: updates.current(), update: updates.status() }),
  }) : null;
  online = link && shop ? startOnline({
    url: link.url, token: link.token,
    isOpen: () => settings.get().onlineOpen === true,
    setOpen: (open) => { settings.set({ onlineOpen: open }); },
  }) : null;
  // The manager phones count on mobile data, into the cloud: take what they recorded (SCRUM-94).
  inbox = link && shop ? startManagerInbox({
    url: link.url, token: link.token, tenantId: shop,
    device: () => inboxDevice(shop),
    ingest: (device, events) => server.ingest(device, events),
    cursor: () => settings.get().managerInboxSeq ?? 0,
    setCursor: (seq) => { if (seq !== settings.get().managerInboxSeq) settings.set({ managerInboxSeq: seq }); },
  }) : null;
};

// The developer's Shops screen: only where server/.env has the admin password (the developer's laptop).
const fleet = process.env.CLOUD_ADMIN_KEY
  ? createFleet({ url: process.env.CLOUD_ADMIN_URL || 'https://cheesybeez-cloud.cheesybeez-cloud.workers.dev', key: process.env.CLOUD_ADMIN_KEY })
  : null;

// Development only: CV_DEV_CAMERAS puts looping video or image files where cameras' streams would be.
const devCameras = devSources(process.env.CV_DEV_CAMERAS);
// The cameras' logins, encrypted in the data folder (C:\ProgramData\CheesyBeez on the shop PC).
const secrets = cvSecrets(dataDir);
// The setup endpoints, #cameras and #vision's camera views (SCRUM-180).
const setup = setupApi({
  store, settings, usePrinter: printer.use, printsDir, port, cloud: cloudLink, cloudUrl, onCloudConnected: startCloud, updates, cv,
  // The owner's setup is stored like a push.
  secrets, ingest: (device, events) => server.ingest(device, events), dev: devCameras,
});
const server = createApp({
  photos: photoFolder(`${dataDir}/photos`),
  cloudPhoto: async (tenantId, id) => {
    const link = cloudLink();
    if (!link || tenantId !== cloudShop()) return null;
    const r = await fetch(`${link.url}/api/v1/photos/${id}`, { headers: { authorization: `Bearer ${link.token}` }, signal: AbortSignal.timeout(15_000) });
    return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
  },
  // Voice at the counter (SCRUM-145): passed to the cloud's language model with this server's key.
  cloudAi: async (tenantId, task, body, contentType) => {
    const link = cloudLink();
    if (!link || tenantId !== cloudShop()) return null;
    try {
      const r = await fetch(`${link.url}/api/v1/ai/${task}`, {
        method: 'POST', headers: { authorization: `Bearer ${link.token}`, 'content-type': contentType }, body: new Uint8Array(body),
        signal: AbortSignal.timeout(task === 'transcribe' ? 20_000 : 8_000),
      });
      return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
    } catch { return null; }
  },
  store,
  staticDir: fileURLToPath(new URL('../dist', import.meta.url)),
  printer,
  onStored: (tenantId, events) => {
    vision.onStored(tenantId, events);
    if (tenantId === cloudShop()) { replicator?.nudge(); online?.onEvents(events); }
  },
  online: () => online,
  cloudStatus: () => replicator?.status() ?? null,
  setup,
  version: updates.current,
  updating: () => activeUpdate(updates.status(), Date.now()),
  fleet,
});
// The camera worker (SCRUM-170): runs in Shadow or Live while the CV pack is there; what it sees is stored through the server.
const vision = startVision({
  store, settings, packDir: () => cv.packDir(), login: (id) => secrets.get(id), dev: devCameras,
  ingest: (device, events) => server.ingest(device, events), logDir: `${dataDir}/logs`,
});
// After the server exists: the manager phones' inbox files events through it.
startCloud();

server.listen(port, '0.0.0.0', () => {
  const s = settings.get();
  const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
  console.log(`CheesyBeez server on http://localhost:${port}${lan ? `  (shop Wi-Fi: http://${lan}:${port})` : ''}`);
  console.log(`  shop: ${s.setupDone ? `${s.shopName} (${s.shopId})` : 'not set up yet: open the address above on this PC'}`);
  console.log(`  version: ${updates.current()}`);
  console.log(`  database: ${storeName}`);
  console.log(`  receipt printer: ${printer.name}`);
  if (fleet) console.log('  shops screen: on (CLOUD_ADMIN_KEY), on this computer only');
  const pack = cv.status();
  console.log(`  table detection (CV): ${pack.active ? pack.phase : 'off'}`);
  if (devCameras.size) console.log(`  development cameras (CV_DEV_CAMERAS): ${[...devCameras.keys()].join(', ')}`);
  console.log(`  cloud copy: ${replicator ? `${cloudShop()} -> ${cloudLink()!.url}` : 'not connected (the setup wizard connects it)'}`);
});

const stop = () => { setup.stopViews(); void vision.stop(); replicator?.stop(); online?.stop(); inbox?.stop(); server.close(() => { void store.close().then(() => process.exit(0)); }); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
