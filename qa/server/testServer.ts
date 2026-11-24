/**
 * EC4206 QA harness: the real CheesyBeez sync server (server/app.ts) on a throwaway SQLite file,
 * with one counter device and three staff, so API, load and security tests hit production code.
 *   node --experimental-strip-types qa/server/testServer.ts   (PORT=8095 by default)
 * Writes qa/.env.json { base, token, shop } for Postman/JMeter/Selenium.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.ts';
import { sqliteStore } from '../../server/sqliteStore.ts';

const PORT = Number(process.env.PORT ?? 8095);
const SHOP = 'shop-qa';
const store = sqliteStore(join(mkdtempSync(join(tmpdir(), 'cb-qa-')), 'qa.sqlite'));
const { token } = await store.addDevice(SHOP, 'QA counter', 'counter');
await store.addStaff(SHOP, 'Nimal', 'cashier', '1111');
await store.addStaff(SHOP, 'Ravi', 'manager', '2580');
await store.addStaff(SHOP, 'Danit', 'owner', '9999');
const server = createApp({ store, staticDir: process.env.STATIC_DIR });
server.listen(PORT, '127.0.0.1', () => {
  const base = `http://127.0.0.1:${PORT}`;
  writeFileSync(new URL('../.env.json', import.meta.url), JSON.stringify({ base, token, shop: SHOP }, null, 2));
  writeFileSync(new URL('../postman/env.json', import.meta.url), JSON.stringify({
    name: 'CheesyBeez QA', values: [['base', base], ['token', token], ['shop', SHOP]].map(([key, value]) => ({ key, value, enabled: true })),
  }, null, 2));
  console.log(`QA server on ${base} (shop ${SHOP})`);
});
