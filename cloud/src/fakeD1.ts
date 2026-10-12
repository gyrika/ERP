import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { D1Like, D1Statement } from './cloud.ts';

/** For tests: D1, as far as the cloud uses it, on Node's own SQLite with the real migrations. */
export function fakeD1() {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  type Stmt = D1Statement & { runNow(): { meta: { changes: number } } };
  const statement = (sql: string, values: unknown[] = []): Stmt => {
    const args = values as (string | number | null)[];
    const runNow = () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } });
    return {
      bind: (...v: unknown[]) => statement(sql, v),
      first: async <T>() => (db.prepare(sql).get(...args) as T | undefined) ?? null,
      all: async <T>() => ({ results: db.prepare(sql).all(...args) as T[] }),
      run: async () => runNow(),
      runNow,
    };
  };
  const d1: D1Like = {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const out = statements.map((s) => (s as Stmt).runNow());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return { d1, db };
}

