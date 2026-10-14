-- The sales ledger: every payment from each shop as one tidy row, with its items, filled by
-- the Worker from the events as they are copied in (cloud/src/sales.ts). The events stay the
-- truth; these tables can be emptied and rebuilt from them at any time. Money in cents.

-- One row per payment. An Undo at the counter keeps the row but marks it 'undone'.
CREATE TABLE sales (
  id            TEXT    PRIMARY KEY,                -- the order.paid event's id
  tenant_id     TEXT    NOT NULL REFERENCES shops(id),
  order_number  INTEGER NOT NULL,
  sale_date     TEXT    NOT NULL,                   -- YYYY-MM-DD, Sri Lanka time
  sale_time     TEXT    NOT NULL,                   -- HH:MM, Sri Lanka time
  paid_at       INTEGER NOT NULL,                   -- ms, counter clock
  items_count   INTEGER NOT NULL,
  subtotal      INTEGER NOT NULL,                   -- the items at their prices
  discount      INTEGER NOT NULL,                   -- subtotal - total (adjustments, % off, Free)
  total         INTEGER NOT NULL,                   -- what was charged
  tender        TEXT    NOT NULL,                   -- cash, transfer, card, qr, comp
  tendered      INTEGER NOT NULL,
  change_given  INTEGER NOT NULL,
  cashier       TEXT    NOT NULL,
  online        INTEGER NOT NULL DEFAULT 0,         -- 1 = ordered on cheesybeez.com
  status        TEXT    NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'undone')),
  undone_at     INTEGER,
  event_seq     INTEGER NOT NULL                    -- events.seq of the payment
);
CREATE INDEX ix_sales_day ON sales (tenant_id, sale_date);
CREATE INDEX ix_sales_order ON sales (tenant_id, order_number, event_seq);

-- What each payment paid for, one row per order line.
CREATE TABLE sale_items (
  sale_id       TEXT    NOT NULL REFERENCES sales(id),
  tenant_id     TEXT    NOT NULL REFERENCES shops(id),
  line_no       INTEGER NOT NULL,
  item_id       TEXT    NOT NULL,
  item_name     TEXT    NOT NULL,
  size          TEXT,
  qty           INTEGER NOT NULL,
  unit_price    INTEGER NOT NULL,                   -- the price it was sent at
  line_total    INTEGER NOT NULL,
  extras        TEXT,                               -- "Chicken, Bacon"
  left_out      TEXT,                               -- "No onion"
  PRIMARY KEY (sale_id, line_no)
);
CREATE INDEX ix_sale_items_item ON sale_items (tenant_id, item_id);

-- A payment's order: its events by number (folding the items it paid for).
CREATE INDEX ix_events_order ON events (tenant_id, order_number, seq);

-- How far each shop's events have been read into the ledger.
CREATE TABLE sales_cursor (
  tenant_id     TEXT    PRIMARY KEY REFERENCES shops(id),
  last_seq      INTEGER NOT NULL
);

-- Each shop's day at a glance (payments that still stand).
CREATE VIEW daily_sales AS
SELECT s.tenant_id, sh.name AS shop, s.sale_date,
  COUNT(*)                                                   AS sales,
  SUM(s.total)                                               AS total_cents,
  SUM(CASE WHEN s.tender = 'cash' THEN s.total ELSE 0 END)     AS cash_cents,
  SUM(CASE WHEN s.tender = 'transfer' THEN s.total ELSE 0 END) AS transfer_cents,
  SUM(CASE WHEN s.tender NOT IN ('cash', 'transfer') THEN s.total ELSE 0 END) AS other_cents,
  SUM(s.discount)                                            AS discount_cents,
  SUM(s.online)                                              AS online_sales
FROM sales s JOIN shops sh ON sh.id = s.tenant_id
WHERE s.status = 'paid'
GROUP BY s.tenant_id, s.sale_date;
