import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from 'mysql2/promise';
import { FAKE_CUSTOMER_SHEET } from '../../src/fake/data.ts';
import { planImport, type KnownCustomer } from '../../src/domain/customerImport.ts';
import { isCustomerId } from '../../src/domain/customers.ts';
import { sqliteStore } from '../sqliteStore.ts';
import { mysqlStore } from '../store.ts';
import { crmCrypto, crmCryptoFromKey } from './crypto.ts';
import { mysqlCustomers } from './mysql.ts';
import { sqliteCustomers } from './sqlite.ts';
import { memoryCustomers, type CustomerStore } from './store.ts';

const AT = Date.UTC(2026, 10, 11, 6, 0);
const owner = { id: 'staff-owner', name: 'Owner', role: 'owner' as const };
const known = async (store: CustomerStore, shop: string) =>
  new Map<string, KnownCustomer>((await store.list(shop)).map((c) => [c.phone, { id: c.id, name: c.name }]));

/** The same story on every store: the messy list in, again (nothing new), names filled, shops apart. */
const story = async (store: CustomerStore, shop: string, otherShop: string) => {
  const first = planImport(FAKE_CUSTOMER_SHEET, await known(store, shop));
  assert.deepEqual(await store.importRows(shop, first.rows, owner, AT), { added: 36, updated: 0 });
  const list = await store.list(shop);
  assert.equal(list.length, 36);
  assert.ok(list.every((c) => isCustomerId(c.id) && /^\+947\d{8}$/.test(c.phone) && c.source === 'import' && !c.optedOut && c.createdAt === AT));
  const name = (phone: string) => list.find((c) => c.phone === phone)?.name;
  assert.equal(name('+94720000010'), 'කසුන් ප්‍රනාන්දු', 'Sinhala comes back exactly, joiner and all');
  assert.equal(name('+94750000011'), 'சுரேஷ் குமார்');
  assert.equal(name('+94770000015'), null);

  // The same file again: nothing added, nothing changed.
  const again = planImport(FAKE_CUSTOMER_SHEET, await known(store, shop));
  assert.equal(again.report.added, 0);
  assert.deepEqual(await store.importRows(shop, again.rows, owner, AT + 1), { added: 0, updated: 0 });
  // An old plan saved twice still adds nobody twice.
  assert.deepEqual(await store.importRows(shop, first.rows, owner, AT + 2), { added: 0, updated: 0 });
  assert.equal((await store.list(shop)).length, 36);

  // A later file names someone who had no name, and the owner chose to replace one name.
  const later = planImport([['Name', 'Mobile'], ['Ama', '0770000015'], ['Kasun P. Perera', '0770000001']], await known(store, shop), { renameExisting: true });
  assert.deepEqual(later.rows.map((r) => r.kind), ['fill_name', 'rename']);
  assert.deepEqual(await store.importRows(shop, later.rows, owner, AT + 3), { added: 0, updated: 2 });
  const after = await store.list(shop);
  assert.equal(after.find((c) => c.phone === '+94770000015')?.name, 'Ama');
  assert.equal(after.find((c) => c.phone === '+94770000001')?.name, 'Kasun P. Perera');
  // Filling a name that is already there does nothing (the plan was made before someone else filled it).
  assert.deepEqual(await store.importRows(shop, later.rows.slice(0, 1).map((r) => ({ ...r, name: 'Other' })) as typeof later.rows, owner, AT + 4), { added: 0, updated: 0 });

  // Another shop: its own list, the same numbers allowed, never seen from here.
  assert.deepEqual(await store.list(otherShop), []);
  const theirs = planImport([['Name', 'Mobile'], ['Kasun', '0770000001']], new Map());
  assert.deepEqual(await store.importRows(otherShop, theirs.rows, owner, AT), { added: 1, updated: 0 });
  assert.equal((await store.list(shop)).length, 36);
  assert.equal((await store.list(otherShop)).length, 1);
  // A plan's ids from one shop never touch another's customers.
  const foreignRename = later.rows.map((r) => ({ ...r }));
  assert.deepEqual(await store.importRows(otherShop, foreignRename, owner, AT + 5), { added: 0, updated: 0 });
};

test('memory: the import story', async () => {
  await story(memoryCustomers(), 'shop-a', 'shop-b');
});

test('SQLite: the import story, and nobody\'s number or name is readable in the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-crm-'));
  const events = sqliteStore(join(dir, 'pos.sqlite'));
  await events.addDevice('shop-a', 'A', 'counter');
  await events.addDevice('shop-b', 'B', 'counter');
  const crypto = crmCrypto(dir);
  await story(sqliteCustomers(events.db, crypto), 'shop-a', 'shop-b');

  const raw = events.db.prepare('SELECT phone_hash, phone_enc, name_enc FROM crm_customers').all() as Record<string, string | null>[];
  const dump = JSON.stringify(raw);
  for (const secret of ['+9477', '0770000001', 'Kasun', 'Perera', 'කසුන්', 'சுரேஷ்']) assert.ok(!dump.includes(secret), `${secret} is not in the database`);
  // The same number in two shops is two rows: the unique key is per shop.
  assert.equal(raw.filter((r) => r.phone_hash === crypto.phoneHash('+94770000001')).length, 2);

  // A restore without its crm.key: the rows cannot be opened, and nothing pretends they can.
  const stranger = sqliteCustomers(events.db, crmCryptoFromKey(randomBytes(32)));
  assert.deepEqual(await stranger.list('shop-a'), []);
  await events.close();
  rmSync(dir, { recursive: true, force: true });
});

test('the CRM key: made once, kept, never replaced; sealed text opens only with it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-crm-key-'));
  const a = crmCrypto(dir);
  const sealed = a.seal('නිමල් පෙරේරා');
  assert.notEqual(sealed, a.seal('නිමල් පෙරේරා'), 'a fresh seal each time');
  assert.equal(crmCrypto(dir).open(sealed), 'නිමල් පෙරේරා', 'the same key after a restart');
  assert.equal(a.phoneHash('+94770000001'), crmCrypto(dir).phoneHash('+94770000001'));
  assert.notEqual(a.phoneHash('+94770000001'), a.phoneHash('+94770000002'));
  const tampered = `${sealed.slice(0, -3)}${sealed.endsWith('A') ? 'B' : 'A'}xx`;
  assert.equal(a.open(tampered), null);
  assert.equal(a.open('plain text'), null);
  assert.equal(crmCryptoFromKey(randomBytes(32)).open(sealed), null, 'another shop\'s key');
  // A damaged key file is never quietly replaced: that would lose every customer.
  writeFileSync(join(dir, 'crm.key'), 'short');
  assert.throws(() => crmCrypto(dir), /restore it from the backup/);
  assert.equal(readFileSync(join(dir, 'crm.key'), 'utf8'), 'short');
  rmSync(dir, { recursive: true, force: true });
});

const MYSQL = process.env.TEST_DATABASE_URL;
test('MySQL: the import story', { skip: MYSQL ? false : 'TEST_DATABASE_URL not set' }, async () => {
  const pool = createPool({ uri: MYSQL, connectionLimit: 2 });
  const tag = randomBytes(3).toString('hex');
  const events = mysqlStore(pool);
  await events.addDevice(`crm-a-${tag}`, 'A', 'counter');
  await events.addDevice(`crm-b-${tag}`, 'B', 'counter');
  await story(mysqlCustomers(pool, crmCryptoFromKey(randomBytes(32))), `crm-a-${tag}`, `crm-b-${tag}`);
  await pool.end();
});

test('SQLite: remove takes the customer, their phones and send log; restore brings the row back under the same id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-crm-rm-'));
  const events = sqliteStore(join(dir, 'pos.sqlite'));
  await events.addDevice('shop-a', 'A', 'counter');
  const store = sqliteCustomers(events.db, crmCrypto(dir));
  const { customer } = await store.ensure('shop-a', '+94770000056', 'manual', 'o', AT);
  await store.addSub('shop-a', customer.id, { endpoint: 'https://push.example/1', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } }, AT);
  await store.logOnce('shop-a', `campaign:x:${customer.id}`, customer.id, AT);
  const removed = await store.remove('shop-a', customer.id);
  assert.deepEqual(removed, customer);
  assert.equal(await store.remove('shop-a', customer.id), null);
  for (const t of ['crm_customers', 'crm_push_subs', 'crm_push_log']) {
    assert.equal((events.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, 0, `${t} is empty`);
  }
  assert.equal(await store.restore('shop-a', removed!, 'o', AT + 1), true);
  assert.deepEqual(await store.byPhone('shop-a', '+94770000056'), customer);
  assert.equal(await store.restore('shop-a', removed!, 'o', AT + 2), false, 'already back');
  await events.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Campaign results read the send log back by key: this campaign's rows only, this shop's only. */
const loggedStory = async (store: CustomerStore) => {
  await store.logOnce('shop-a', 'campaign:abc:cus-1', 'cus-1', AT);
  await store.logOnce('shop-a', 'campaign:abc:cus-2', 'cus-2', AT);
  await store.logOnce('shop-a', 'campaign:abcd:cus-3', 'cus-3', AT); // another campaign whose id starts the same
  await store.logOnce('shop-a', 'compare:abc:cus-4', 'cus-4', AT);
  await store.logOnce('shop-b', 'campaign:abc:cus-9', 'cus-9', AT);
  assert.deepEqual((await store.logged('shop-a', 'campaign:abc:')).sort(), ['cus-1', 'cus-2']);
  assert.deepEqual(await store.logged('shop-a', 'compare:abc:'), ['cus-4']);
  assert.deepEqual(await store.logged('shop-a', 'campaign:zzz:'), []);
  await store.unlog('shop-a', 'campaign:abc:cus-2');
  assert.deepEqual(await store.logged('shop-a', 'campaign:abc:'), ['cus-1']);
};

test('the send log read back for campaign results: memory and SQLite alike', async () => {
  await loggedStory(memoryCustomers());
  const dir = mkdtempSync(join(tmpdir(), 'cb-crm-log-'));
  const events = sqliteStore(join(dir, 'pos.sqlite'));
  await events.addDevice('shop-a', 'A', 'counter');
  await events.addDevice('shop-b', 'B', 'counter');
  await loggedStory(sqliteCustomers(events.db, crmCrypto(dir)));
  await events.close();
  rmSync(dir, { recursive: true, force: true });
});
