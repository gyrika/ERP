-- The manager's phone app (SCRUM-94), installed from a QR code like the owner's.
-- A manager phone belongs to one person (chosen at the shop PC when its QR code is made):
-- its counts are signed with that person. Nothing references devices, so it is rebuilt
-- for the new kind (SQLite cannot change a CHECK).
CREATE TABLE devices_new (
  id             TEXT    PRIMARY KEY,
  tenant_id      TEXT    NOT NULL REFERENCES shops(id),
  kind           TEXT    NOT NULL CHECK (kind IN ('shop_server', 'owner', 'manager')),
  token_hash     TEXT    NOT NULL UNIQUE,
  created_at     INTEGER NOT NULL,
  version        TEXT,
  update_status  TEXT,
  last_seen_at   INTEGER,
  actor          TEXT                                -- manager phones: {"id","name","role"} of its person
);
INSERT INTO devices_new (id, tenant_id, kind, token_hash, created_at, version, update_status, last_seen_at)
  SELECT id, tenant_id, kind, token_hash, created_at, version, update_status, last_seen_at FROM devices;
DROP TABLE devices;
ALTER TABLE devices_new RENAME TO devices;

-- What manager phones recorded (stock counts, deliveries), waiting for the shop server to take
-- into its own log. The shop reads it in order by seq; the copy back up arrives in events as usual.
CREATE TABLE inbox (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT    NOT NULL REFERENCES shops(id),
  id           TEXT    NOT NULL,                   -- the event's own id
  device_id    TEXT    NOT NULL,                   -- the manager phone that sent it
  received_at  INTEGER NOT NULL,
  body         TEXT    NOT NULL,
  UNIQUE (tenant_id, id)
);
CREATE INDEX ix_inbox_pull ON inbox (tenant_id, seq);

-- Shelf photos, proof for a big gap in a count: about 150 KB each, kept with the shop.
CREATE TABLE photos (
  tenant_id    TEXT    NOT NULL REFERENCES shops(id),
  id           TEXT    NOT NULL,
  data         BLOB    NOT NULL,
  device_id    TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
