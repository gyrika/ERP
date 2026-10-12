import { parseArgs } from 'node:util';
import { createPool } from 'mysql2/promise';
import type { Role } from '../src/domain/auth.ts';
import { isPin } from './pins.ts';
import { PinTaken, mysqlStore } from './store.ts';

/**
 * Staff and PINs, until the owner gets a screen for it (Owner view).
 *   npm run server:staff -- list   --shop shop-demo-cheesybeez
 *   npm run server:staff -- add    --shop shop-demo-cheesybeez --name Nimal --role cashier --pin 1234
 *   npm run server:staff -- remove --shop shop-demo-cheesybeez --id staff-…
 * Roles: cashier, manager, owner, kitchen. The PIN is stored only as a hash.
 */
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    shop: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string' },
    pin: { type: 'string' },
    id: { type: 'string' },
  },
});
const [command] = positionals;
const roles: Role[] = ['cashier', 'manager', 'owner', 'kitchen'];
const fail = (msg: string): never => { console.error(msg); process.exit(1); };

if (!process.env.DATABASE_URL) fail('Set DATABASE_URL first (see docs/server-setup.md).');
const shop = values.shop ?? fail('--shop is required.');
const store = mysqlStore(createPool({ uri: process.env.DATABASE_URL }));

try {
  if (command === 'list') {
    const staff = await store.listStaff(shop);
    if (!staff.length) console.log('No staff yet.');
    for (const s of staff) console.log(`${s.active ? ' ' : 'x'} ${s.id}  ${s.role.padEnd(8)} ${s.name}`);
  } else if (command === 'add') {
    const name = values.name?.trim() || fail('--name is required.');
    const role = values.role as Role;
    if (!roles.includes(role)) fail(`--role must be one of ${roles.join(', ')}.`);
    if (!isPin(values.pin)) fail('--pin must be exactly 4 digits.');
    const s = await store.addStaff(shop, name, role, values.pin!);
    console.log(`Added ${s.name} (${s.role}), id ${s.id}.`);
  } else if (command === 'remove') {
    const id = values.id ?? fail('--id is required (see list).');
    console.log(await store.deactivateStaff(shop, id) ? 'Done: that PIN no longer works.' : 'No active staff member with that id.');
  } else {
    fail('Usage: npm run server:staff -- list|add|remove --shop <id> [--name --role --pin | --id]');
  }
} catch (e) {
  fail(e instanceof PinTaken ? 'Someone else already has that PIN. Choose another.' : String(e));
} finally {
  await store.close();
}
