# Sync contract (Sprint 2)

How the counter PC, the kitchen screen and (later) the owner's phone share orders.
Everyone in Sprint 2 builds to this: **nilupulbandara40** (server, SCRUM-59/60),
**Danith** (saving on the PC and sending later, SCRUM-29/30/32).
Types: [`src/domain/sync.ts`](../src/domain/sync.ts). Change the contract in a PR that all of us review.

## The idea in one paragraph

The app already writes every action as an **event** (`src/domain/events.ts`): order sent, paid,
item cancelled, discount set, and so on. Events are never edited or deleted; an Undo is a new event.
So the server's job is simple: **store events and hand them out in order**. Each device pushes the
events it wrote, receives everyone else's, and builds its own screen from them. The kitchen's
ticket list is built from `order.sent` / `order.item_changed` / `kitchen.bumped` and the rest.
Nothing is ever "merged" or overwritten, so there are no sync conflicts to resolve.

```
 Counter PC                         Server (Node + MySQL)              Kitchen tablet
 ─────────                          ─────────────────────              ──────────────
 action → event → local log ──push──►  INSERT into events  ──stream──►  apply → screen
          (outbox, survives          (gives it a seq number)
           power cuts)       ◄─pull──  SELECT … WHERE seq > ?  ◄─pull──  (on start / reconnect)
```

## MySQL tables

```sql
CREATE TABLE shops (
  id          VARCHAR(64)  PRIMARY KEY,           -- same string as shopId in the app
  name        VARCHAR(120) NOT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE devices (
  id          VARCHAR(64)  PRIMARY KEY,           -- generated once on each device
  tenant_id   VARCHAR(64)  NOT NULL,
  kind        ENUM('counter','kitchen','owner') NOT NULL,
  token_hash  CHAR(64)     NOT NULL,              -- SHA-256 of the device's secret token
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES shops(id)
);

CREATE TABLE events (
  seq           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,  -- the order everyone applies events in
  id            VARCHAR(64)  NOT NULL,                       -- event id from the device (UUID)
  tenant_id     VARCHAR(64)  NOT NULL,
  device_id     VARCHAR(64)  NOT NULL,
  type          VARCHAR(40)  NOT NULL,                       -- 'order.sent', 'kitchen.bumped', ...
  order_number  INT UNSIGNED NOT NULL,
  at            BIGINT       NOT NULL,                       -- device clock, ms (for display only)
  received_at   BIGINT       NOT NULL,                       -- server clock, ms
  body          JSON         NOT NULL,                       -- the whole event exactly as sent
  UNIQUE KEY uq_event (tenant_id, id),                       -- pushing the same event twice is a no-op
  KEY ix_pull  (tenant_id, seq),
  KEY ix_order (tenant_id, order_number),
  FOREIGN KEY (tenant_id) REFERENCES shops(id),
  FOREIGN KEY (device_id) REFERENCES devices(id)
);
```

- The app's database user gets **only `INSERT` and `SELECT` on `events`**. No `UPDATE`, no `DELETE`:
  the audit trail (SCRUM-43) is enforced by MySQL, not by good intentions.
- Every query has `WHERE tenant_id = ?`, taken from the device token, **never from the request body**
  (SCRUM-42).
- Reports (SCRUM-72) come later as extra tables or views built from `events`. Don't add them now.

## API

All requests carry `Authorization: Bearer <device token>`. The server looks up the device and its
shop from the token. JSON bodies use the types in `sync.ts`.

| Call | Body / query | Returns | Notes |
|---|---|---|---|
| `POST /api/v1/events` | `PushRequest` (max 100 events) | `PushResponse` | Idempotent: an event already stored returns its existing `seq`. Reject the whole batch with `400 invalid_event` if any event has a wrong `shopId` or no `id`/`type`. |
| `GET /api/v1/events?after=<seq>&limit=<n>` | – | `PullResponse` | `limit` ≤ 500. `more: true` means pull again. |
| `WSS /api/v1/stream?after=<seq>` | – | `StreamMessage`s | First `hello`, then every event after `seq`, then each new one as it is stored. Server → device only. |
| `GET /api/v1/health` | – | `{ ok: true, serverTime }` | No token needed. |

Errors: `401 unauthorized` (bad token), `403 wrong_shop`, `400 invalid_event`, `500 server`, body `ApiError`.

## Status (2026-10-12): built

Server in `server/` (setup: [server-setup.md](server-setup.md)), device side in
`src/services/syncClient.ts` + `src/ui/eventLog.ts`. Kitchen tickets are now folded from events
(`ticketsFromEvents` in `src/domain/kitchen.ts`); nothing stores tickets any more. Checked with two
isolated browsers: a ticket reaches the other device in ~0.3 s, Done comes back in ~0.5 s, and an
order taken offline arrives as soon as the counter reconnects. Where the build differs from the
plan below, the rule is marked **Changed**.

## Rules for the device (Danith)

1. **Write locally first, always.** The sale never waits for the network. The local event log is the
   outbox. It must survive a power cut (move it from localStorage to IndexedDB, SCRUM-29).
   **Changed:** it stays in localStorage (synchronous, so screens stay simple). MySQL on the same PC
   is the durable copy, and events the server has confirmed are trimmed after 2 days, far below the
   5 MB limit. Revisit if power cuts lose the last seconds of sales in practice.
2. **Push** pending events (`pendingEvents()`) right after each new event, and again on reconnect.
   On failure retry with `retryDelayMs(attempt)`. Mark an event done only when its id comes back in
   `accepted`.
3. **Receive** with the stream. On start or after a disconnect: `pull` from the last `seq` you applied
   until `more` is false, then open the stream from there. Remember the last applied `seq` on the device.
4. **Apply** remote events in `seq` order, skipping ids you already have (`newRemoteEvents()`).
5. **Clocks:** device clocks are wrong. Kitchen timers count from `receivedAt`, and each screen corrects
   its own "now" with `clockOffsetMs()` from `serverTime`.
   **Not built yet:** with the kitchen on the counter PC there is one clock. Do it with the kitchen device.
6. **Show the state** with `syncStatus()`: nothing when synced, a small sign when offline (SCRUM-32).
7. Only `src/ui/eventLog.ts` and `src/ui/kitchenStore.ts` change. Screens stay the same.
8. **Pairing:** a device syncs only after its pairing link (`?pair=<token>`) was opened once; the demo
   never syncs. The stream takes the token as `?token=` because browsers cannot set WebSocket headers.

## Rules for the server (nilupulbandara40)

1. Node + MySQL, the `ws` package for the stream.
2. `POST /events`: in one transaction, first lock the shop with
   `SELECT id FROM shops WHERE id = ? FOR UPDATE`, then insert each event with
   `INSERT ... ON DUPLICATE KEY UPDATE id = id`, then read back the `seq` of every id. After commit,
   **Changed:** `INSERT IGNORE`, because `ON DUPLICATE KEY UPDATE` needs the UPDATE privilege on
   `events`, which the app user must not have. Validation runs first, so nothing else gets ignored.
   send each newly stored event to every open stream of the **same** tenant.
   The lock matters: without it, two pushes at once can commit `seq` 8 before 7, and a device that
   already pulled "after 8" would never see 7.
3. Never change an event's body. Validate the shape only (id, type, shopId, orderNumber, at).
4. Done when: two browser tabs on **different laptops** pointed at the server see each other's kitchen
   tickets within a second, and pushing the same batch twice stores it once.

## New event types

The kitchen's taps become events so the counter and owner see them:
`kitchen.seen`, `kitchen.bumped`, `kitchen.unbumped` (see `KitchenEvent` in `sync.ts`).

## Decision needed: where the server runs

The internet at the shop is unreliable, and **the kitchen works from the screen only**. If the server
is only in the cloud, an internet outage blinds the kitchen even though both devices are in the shop.

**Recommendation:** run the server **on the counter PC** (it is on all day, and the printer helper,
SCRUM-71, already runs there). The kitchen tablet connects over the shop Wi-Fi to `http://<PC IP>`.
Later (SCRUM-61) the PC copies its events to a cloud copy for backups and the owner's phone, using
this same API. Then an internet outage only delays the owner's phone; the kitchen keeps working.
The cost: MySQL on Windows 10 at the counter, and the Wi-Fi router needs to be on the UPS too (SCRUM-73).

## Known limits (fine for one shop with one counter)

- Order numbers come from the counter (1001, 1002 …). A second counter would need its own range.
  `device_id` is stored so this can be fixed later without rewriting history.
- Refunds, real staff logins (SCRUM-40/41) and reports are outside this contract.
