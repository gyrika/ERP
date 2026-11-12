-- Customers (CRM, src/domain/customers.ts): the one list that can be corrected and erased, so it
-- lives here, not in the event log. A sale names its customer by id only (order.paid.customerId).
-- The number and the name are sealed (AES-256-GCM, key in <data>\crm.key, server/crm/crypto.ts);
-- phone_hash (keyed HMAC of +947XXXXXXXX) finds a number without opening it and keeps it once per shop.
CREATE TABLE crm_customers (
  id            TEXT    PRIMARY KEY,                 -- cus- and 16 hex
  tenant_id     TEXT    NOT NULL REFERENCES shops(id),
  phone_hash    TEXT    NOT NULL,
  phone_enc     TEXT    NOT NULL,
  name_enc      TEXT,                                -- null: no name given
  source        TEXT    NOT NULL CHECK (source IN ('pos', 'import', 'manual')),
  opted_out     INTEGER NOT NULL DEFAULT 0,          -- asked for no messages
  opted_out_at  INTEGER,
  created_by    TEXT    NOT NULL,                    -- staff id
  created_at    INTEGER NOT NULL,
  updated_by    TEXT    NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (tenant_id, phone_hash)
);
CREATE INDEX ix_crm_customers ON crm_customers (tenant_id, created_at);
