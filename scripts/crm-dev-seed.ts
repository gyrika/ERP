/**
 * Test data for the CRM in the DEVELOPMENT shop (server/data, what `npm run dev:server` uses):
 *   npm run crm:dev-seed
 * - adds the fake owner from src/fake/data.ts (FAKE_STAFF, its PIN as written there) to the dev shop,
 *   unless someone with that PIN is already there, so the screens can be signed into;
 * - imports FAKE_CUSTOMER_SHEET into the dev shop's customer list (the same plan as the Import
 *   page: running it again adds nobody);
 * - once, about 30 paid test orders over the last 90 days for some of them (order.paid.customerId),
 *   so the list, the segments and the profiles have something to show. Settings › Test data clears them.
 * Refuses any other data folder: never a shop's real data.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planImport, type KnownCustomer } from '../src/domain/customerImport.ts';
import { FAKE_CUSTOMER_SHEET, FAKE_STAFF } from '../src/fake/data.ts';
import { crmCrypto } from '../server/crm/crypto.ts';
import { sqliteCustomers } from '../server/crm/sqlite.ts';
import { sqliteStore } from '../server/sqliteStore.ts';
import { PinTaken } from '../server/store.ts';

const dataDir = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'server', 'data');
const fail = (m: string): never => { console.error(m); process.exit(1); };
if (process.env.DATA_DIR || process.env.DATABASE_URL) fail('refused: this seeds the development data in server/data only.');
const settingsFile = join(dataDir, 'settings.json');
if (!existsSync(settingsFile)) fail('no dev shop yet: start npm run dev:server and finish the setup wizard first.');
const shopId = (JSON.parse(readFileSync(settingsFile, 'utf8')) as { shopId?: string }).shopId ?? fail('the dev shop has no id yet.');

const store = sqliteStore(join(dataDir, 'pos.sqlite'));
try {
  const owner = FAKE_STAFF.find((s) => s.actor.role === 'owner') ?? fail('no fake owner in src/fake/data.ts');
  try {
    await store.addStaff(shopId, `${owner.actor.name} (test)`, 'owner', owner.pin);
    console.log(`Added "${owner.actor.name} (test)" as an owner, with the fake owner's PIN from src/fake/data.ts.`);
  } catch (e) {
    if (!(e instanceof PinTaken)) throw e;
    const who = await store.staffByPin(shopId, owner.pin);
    console.log(`Someone already has the fake owner's PIN (${who?.name}, ${who?.role}): left as it is.`);
  }

  const customers = sqliteCustomers(store.db, crmCrypto(dataDir));
  const known = new Map<string, KnownCustomer>((await customers.list(shopId)).map((c) => [c.phone, { id: c.id, name: c.name }]));
  const plan = planImport(FAKE_CUSTOMER_SHEET, known);
  const by = { id: 'dev-seed', name: 'Dev seed', role: 'owner' as const };
  const saved = await customers.importRows(shopId, plan.rows, by, Date.now());
  const list = await customers.list(shopId);
  console.log(`Customers: ${saved.added} added, ${saved.updated} updated; ${list.length} on the dev shop's list.`);

  // Test sales, once: a few regulars, a big spender, some who stopped coming, some new.
  const had = (await store.pull(shopId, 0, 100_000)).some((r) => r.event.type === 'order.paid' && 'customerId' in r.event && r.event.customerId);
  if (had) { console.log('Test sales for customers are already there.'); } else {
    const { device } = await store.addDevice(shopId, 'Dev seed', 'counter');
    const DAY = 86_400_000;
    const now = Date.now();
    const cashier = { id: 'dev-seed', name: 'Dev seed', role: 'cashier' as const };
    const items = [['devilled-chicken', 'L', 290000], ['chicken-burger', undefined, 95000], ['devilled-chicken', 'M', 210000]] as const;
    // [customer index, days ago, which item, how many]
    const plan: [number, number, number, number][] = [
      [0, 80, 0, 1], [0, 45, 1, 2], [0, 20, 0, 1], [0, 3, 2, 2], // a regular
      [1, 70, 0, 4], [1, 12, 0, 6], [1, 2, 0, 5], // a big spender (VIP)
      [6, 60, 1, 1], [6, 38, 2, 1], // stopped coming (inactive)
      [7, 33, 0, 1], // just stopped (we miss you)
      [8, 5, 1, 1], [9, 1, 2, 1], [10, 9, 0, 1], // new
      [11, 50, 1, 2], [11, 25, 1, 1], [11, 6, 1, 3],
      [12, 40, 0, 1], [12, 15, 2, 1], [13, 28, 0, 2], [13, 4, 1, 1],
      [14, 55, 2, 1], [15, 31, 1, 1], [16, 18, 0, 1], [16, 2, 2, 2],
      [17, 75, 0, 1], [18, 11, 1, 2], [19, 26, 2, 1], [20, 8, 0, 1], [21, 90, 1, 1], [22, 3, 0, 1],
    ];
    let n = 9000;
    const events = plan.flatMap(([ci, daysAgo, ii, qty]) => {
      const c = list[ci];
      if (!c) return [];
      n += 1;
      const [itemId, size, unit] = items[ii];
      const at = now - daysAgo * DAY - (n % 7) * 3_600_000;
      const line = { id: `seed-l${n}`, itemId, qty, ...(size ? { size } : {}), adds: [], outs: [], sent: true, unit };
      return [
        { id: `seed-s${n}`, shopId, at: at - 30 * 60_000, orderNumber: n, actor: cashier, type: 'order.sent', ticketId: `seed-t${n}`, lines: [line], addOn: false },
        { id: `seed-p${n}`, shopId, at, orderNumber: n, actor: cashier, type: 'order.paid', total: unit * qty, tender: 'cash', tendered: unit * qty, customerId: c.id },
      ];
    });
    await store.push(device, events as never, Date.now());
    console.log(`Test sales: ${events.length / 2} paid orders for ${new Set(plan.map(([ci]) => ci)).size} customers.`);
  }
} finally {
  await store.close();
}
