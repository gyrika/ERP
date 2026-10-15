-- The manager's phone (SCRUM-94): a fourth kind of device. SQLite cannot change a CHECK,
-- so the table is rebuilt (the runner turns foreign keys off around it and checks them after).
CREATE TABLE devices_new (
  id          TEXT    PRIMARY KEY,
  tenant_id   TEXT    NOT NULL REFERENCES shops(id),
  kind        TEXT    NOT NULL CHECK (kind IN ('counter', 'kitchen', 'owner', 'manager')),
  token_hash  TEXT    NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);
INSERT INTO devices_new (id, tenant_id, kind, token_hash, created_at) SELECT id, tenant_id, kind, token_hash, created_at FROM devices;
DROP TABLE devices;
ALTER TABLE devices_new RENAME TO devices;
