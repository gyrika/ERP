-- The shop server's built-in database (SQLite, one file, no install). Same tables and rules
-- as the MySQL version (server/migrations/); applied by itself when the server starts.

CREATE TABLE shops (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE devices (
  id          TEXT    PRIMARY KEY,
  tenant_id   TEXT    NOT NULL REFERENCES shops(id),
  kind        TEXT    NOT NULL CHECK (kind IN ('counter', 'kitchen', 'owner')),
  token_hash  TEXT    NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

CREATE TABLE events (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT    NOT NULL,
  tenant_id     TEXT    NOT NULL REFERENCES shops(id),
  device_id     TEXT    NOT NULL REFERENCES devices(id),
  type          TEXT    NOT NULL,
  order_number  INTEGER NOT NULL,
  at            INTEGER NOT NULL,
  received_at   INTEGER NOT NULL,
  body          TEXT    NOT NULL,
  UNIQUE (tenant_id, id)
);
CREATE INDEX ix_events_pull  ON events (tenant_id, seq);
CREATE INDEX ix_events_order ON events (tenant_id, order_number);

CREATE TABLE staff (
  id          TEXT    PRIMARY KEY,
  tenant_id   TEXT    NOT NULL REFERENCES shops(id),
  name        TEXT    NOT NULL,
  role        TEXT    NOT NULL CHECK (role IN ('cashier', 'manager', 'owner', 'kitchen')),
  pin_salt    TEXT    NOT NULL,
  pin_hash    TEXT    NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX ix_staff ON staff (tenant_id, active);

CREATE TABLE sessions (
  id          TEXT    PRIMARY KEY,
  tenant_id   TEXT    NOT NULL REFERENCES shops(id),
  device_id   TEXT    NOT NULL REFERENCES devices(id),
  staff_id    TEXT    NOT NULL REFERENCES staff(id),
  role        TEXT    NOT NULL,
  started_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX ix_sessions ON sessions (device_id, staff_id, started_at);

-- The audit trail (SCRUM-43): the database itself refuses, as MySQL's rights do.
CREATE TRIGGER events_never_change BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are never changed'); END;
CREATE TRIGGER events_never_deleted BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are never deleted'); END;
CREATE TRIGGER sessions_never_change BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'sessions are never changed'); END;
CREATE TRIGGER sessions_never_deleted BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'sessions are never deleted'); END;
