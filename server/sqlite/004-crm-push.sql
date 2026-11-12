-- Push sign-ups (CRM, server/crm/push.ts): a customer can sign up for offers in the CheesyBeez app,
-- so 'app' becomes a source. SQLite cannot change a CHECK, so crm_customers is rebuilt (the runner
-- turns foreign keys off around it and checks them after).
CREATE TABLE crm_customers_new (
  id            TEXT    PRIMARY KEY,
  tenant_id     TEXT    NOT NULL REFERENCES shops(id),
  phone_hash    TEXT    NOT NULL,
  phone_enc     TEXT    NOT NULL,
  name_enc      TEXT,
  source        TEXT    NOT NULL CHECK (source IN ('pos', 'import', 'manual', 'app')),
  opted_out     INTEGER NOT NULL DEFAULT 0,
  opted_out_at  INTEGER,
  created_by    TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT    NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (tenant_id, phone_hash)
);
INSERT INTO crm_customers_new SELECT * FROM crm_customers;
DROP TABLE crm_customers;
ALTER TABLE crm_customers_new RENAME TO crm_customers;
CREATE INDEX ix_crm_customers ON crm_customers (tenant_id, created_at);

-- One row per phone that allowed notifications. The subscription (its endpoint and keys) is sealed
-- like the number; endpoint_hash finds it again when the phone says stop, or the push service says gone.
CREATE TABLE crm_push_subs (
  tenant_id      TEXT    NOT NULL REFERENCES shops(id),
  endpoint_hash  TEXT    NOT NULL,
  customer_id    TEXT    NOT NULL REFERENCES crm_customers(id) ON DELETE CASCADE,
  sub_enc        TEXT    NOT NULL,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, endpoint_hash)
);
CREATE INDEX ix_crm_push_customer ON crm_push_subs (tenant_id, customer_id);

-- What was sent to whom, so nothing goes twice: a campaign once per customer, "we miss you" once per
-- quiet spell. dedupe_key says which (campaign:<id>:<customer>, winback:<customer>:<last visit>).
CREATE TABLE crm_push_log (
  tenant_id    TEXT    NOT NULL REFERENCES shops(id),
  dedupe_key   TEXT    NOT NULL,
  customer_id  TEXT    NOT NULL,
  sent_at      INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, dedupe_key)
);
