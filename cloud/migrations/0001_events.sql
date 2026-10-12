-- The cloud copy (SCRUM-61): every shop's events, copied from the shop server, off-site.
-- Cloudflare D1 (SQLite). Applied with: npm run migrate (in cloud/).

CREATE TABLE shops (
  id          TEXT    PRIMARY KEY,                 -- same id as the shop server's tenant_id
  name        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Who may talk to the cloud: a shop's server (copies its events in) or, later, the owner's phone (reads).
CREATE TABLE devices (
  id          TEXT    PRIMARY KEY,
  tenant_id   TEXT    NOT NULL REFERENCES shops(id),
  kind        TEXT    NOT NULL CHECK (kind IN ('shop_server', 'owner')),
  token_hash  TEXT    NOT NULL UNIQUE,             -- SHA-256 of the secret token
  created_at  INTEGER NOT NULL
);

CREATE TABLE events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,  -- cloud order
  tenant_id      TEXT    NOT NULL REFERENCES shops(id),
  id             TEXT    NOT NULL,                   -- the event's own id
  source_seq     INTEGER NOT NULL,                   -- its seq on the shop server
  source_device  TEXT    NOT NULL,                   -- the shop device that wrote it
  type           TEXT    NOT NULL,
  order_number   INTEGER NOT NULL,
  at             INTEGER NOT NULL,                   -- device clock, ms
  received_at    INTEGER NOT NULL,                   -- shop server clock, ms
  copied_at      INTEGER NOT NULL,                   -- cloud clock, ms
  body           TEXT    NOT NULL,                   -- the whole event, exactly as written
  UNIQUE (tenant_id, id)
);
CREATE INDEX ix_events_source ON events (tenant_id, source_seq);
CREATE INDEX ix_events_pull   ON events (tenant_id, seq);

-- The audit trail (SCRUM-43): D1 has no user rights, so the database itself refuses.
CREATE TRIGGER events_never_change BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are never changed'); END;
CREATE TRIGGER events_never_deleted BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are never deleted'); END;
