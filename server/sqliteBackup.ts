import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * A safe copy of the shop's built-in database, taken while the POS keeps running
 * (VACUUM INTO reads one consistent moment; selling is never blocked). The copy is
 * checked before it counts, and only the newest `keep` copies stay.
 * CheesyBeez Station runs it every night and right before installing an update:
 *   node server/sqliteBackup.ts <data folder> <label>
 * To restore one: stop the "CheesyBeez Station" task, copy the backup over pos.sqlite
 * (and delete pos.sqlite-wal and pos.sqlite-shm), start the task (docs/install-windows.md).
 */
export function backupDatabase(dataDir: string, label: string, keep = 14, now = new Date()) {
  const source = join(dataDir, 'pos.sqlite');
  if (!existsSync(source)) return null; // MySQL, or a shop not set up yet: nothing to copy
  const dir = join(dataDir, 'backups');
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const file = join(dir, `pos-${stamp}-${label.replace(/[^a-z0-9.-]/gi, '')}.sqlite`);

  const db = new DatabaseSync(source);
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    db.prepare('VACUUM INTO ?').run(file);
  } finally {
    db.close();
  }
  const copy = new DatabaseSync(file, { readOnly: true });
  let events: number;
  try {
    const ok = (copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
    if (ok !== 'ok') throw new Error(`the backup is damaged: ${ok}`);
    events = (copy.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
  } catch (e) {
    copy.close();
    rmSync(file, { force: true });
    throw e;
  }
  copy.close();

  // Names start with the time, so sorting by name is oldest first.
  const all = readdirSync(dir).filter((f) => /^pos-.*\.sqlite$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) rmSync(join(dir, old), { force: true });
  return { file, events };
}

if (import.meta.main) {
  const [dataDir, label = 'manual'] = process.argv.slice(2);
  if (!dataDir) { console.error('usage: node server/sqliteBackup.ts <data folder> [label]'); process.exit(2); }
  try {
    const r = backupDatabase(dataDir, label);
    console.log(r ? `Backup: ${r.file} (${r.events} events)` : 'Backup: no built-in database here.');
  } catch (e) {
    console.error(`Backup failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
