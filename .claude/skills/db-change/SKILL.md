---
name: db-change
description: Change stored data in CheesyBeez — prefer a new event type; schema changes span MySQL, SQLite and Cloudflare D1.
---
# Database / event change

Data is an event log. Most "new data" is a **new event type**, not a new table.

New event type:
1. Add the type + checker in its domain file (`src/domain/*`, exported `*_EVENT_TYPES`), with a test.
2. Register it in `server/validate.ts` (the cloud uses the same rules). Every event carries `shopId`; money in integer cents; managers' changes go through `applyManagerChange()`.
3. Kitchen-visible changes must be events (tickets are folded from events).
4. Tests: `node --test --experimental-strip-types --no-warnings server/validate.test.ts` + the domain test, then `npm test`.
5. Release note: cloud must be deployed before the shop tag (see release skill).

Schema change (rare) — keep all three stores in step, append-only, never edit an applied file:
- MySQL: `server/migrations/NNN-name.sql` → `npm run server:migrate` (local root needs a password).
- SQLite (default on shop PCs): `server/sqlite/NNN-name.sql`.
- Cloud D1: `cloud/migrations/NNNN_name.sql` → `npm run migrate:local`, staging, then live.
- Every new table has `tenant_id`/`shop_id`. Run `server/mysql.test.ts`, `server/sqliteStore.test.ts`, `cloud/src/cloud.test.ts`.

Rules: no destructive SQL (DROP/DELETE/UPDATE) on live data — write it, hand it to the user to run, backup first.
Stop: a change would rewrite past events → ask.
Report: event types/migrations added · stores touched · tests.
