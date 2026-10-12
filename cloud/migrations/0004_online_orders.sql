-- Online orders from cheesybeez.com: order ahead, collect and pay at the shop (src/domain/online.ts).
-- The customer's name and phone stay only here, and are blanked after 30 days.
CREATE TABLE online_orders (
  id            TEXT    PRIMARY KEY,
  tenant_id     TEXT    NOT NULL REFERENCES shops(id),
  token_hash    TEXT    NOT NULL,                 -- the customer's own link to its status
  status        TEXT    NOT NULL,                 -- new, accepted, declined, ready, collected
  name          TEXT    NOT NULL,
  phone         TEXT    NOT NULL,
  body          TEXT    NOT NULL,                 -- { lines, note } as checked and priced by the cloud
  total         INTEGER NOT NULL,                 -- cents
  order_number  INTEGER,                          -- the Register's number, once accepted
  ready_by      INTEGER,                          -- ms
  reason        TEXT,                             -- why it was declined
  ip_hash       TEXT,                             -- to slow down floods, never shown
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX online_orders_shop ON online_orders (tenant_id, created_at);
CREATE INDEX online_orders_phone ON online_orders (phone, created_at);
CREATE INDEX online_orders_ip ON online_orders (ip_hash, created_at);

-- The counter switches online orders on and off; the shop server says so each time it asks for orders.
ALTER TABLE shops ADD COLUMN online_open INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shops ADD COLUMN online_seen_at INTEGER;
