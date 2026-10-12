import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { D1Like, D1Statement } from './cloud.ts';

/** For tests: D1, as far as the cloud uses it, on Node's own SQLite with the real migration. */
export function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_events.sql', import.meta.url), 'utf8'));
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

