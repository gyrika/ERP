import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'mysql2/promise';

/**
 * Applies the database changes in server/migrations/ that this database has
 * not had yet, in file-name order, and records each one. Safe to run any time:
 * nothing is applied twice.
 *   npm run server:migrate
 * Runs as pos_migrate (MIGRATE_DATABASE_URL in server/.env.migrate), never as
 * the app's own user, which is not allowed to change tables.
 *
 * A migration is never edited once applied anywhere: a change is a new file.
 * MySQL cannot undo table changes in a transaction, so each file should be
 * safe to run again (CREATE TABLE IF NOT EXISTS …) in case one stops halfway.
 */
const url = process.env.MIGRATE_DATABASE_URL;
if (!url) {
  console.error('Set MIGRATE_DATABASE_URL in server/.env.migrate first (see docs/server-setup.md).');
  process.exit(1);
}

const dir = fileURLToPath(new URL('./migrations/', import.meta.url));
const db = await createConnection({ uri: url, multipleStatements: true });
try {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id          VARCHAR(100) PRIMARY KEY,
    applied_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const [rows] = await db.query('SELECT id FROM schema_migrations');
  const done = new Set((rows as { id: string }[]).map((r) => r.id));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const todo = files.filter((f) => !done.has(f));
  if (!todo.length) console.log(`Up to date (${files.length} migrations).`);
  for (const f of todo) {
    process.stdout.write(`Applying ${f} … `);
    await db.query(await readFile(dir + f, 'utf8'));
    await db.query('INSERT INTO schema_migrations (id) VALUES (?)', [f]);
    console.log('done');
  }
} catch (e) {
  console.error('\nMigration failed:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await db.end();
}
