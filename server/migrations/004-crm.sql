-- Customers (CRM, src/domain/customers.ts). Same table as server/sqlite/003-crm.sql.
-- Unlike events, a customer can be corrected and erased, so the app's user may change and delete
-- rows here (and only here). The number and the name are sealed by the shop server (server/crm/crypto.ts).
CREATE TABLE IF NOT EXISTS crm_customers (
  id            CHAR(20)     PRIMARY KEY,                       -- cus- and 16 hex
  tenant_id     VARCHAR(64)  NOT NULL,
  phone_hash    CHAR(64)     NOT NULL,                          -- keyed HMAC of +947XXXXXXXX
  phone_enc     VARCHAR(255) NOT NULL,
  name_enc      VARCHAR(512) NULL,                              -- null: no name given
  source        ENUM('pos','import','manual') NOT NULL,
  opted_out     TINYINT(1)   NOT NULL DEFAULT 0,
  opted_out_at  BIGINT       NULL,
  created_by    VARCHAR(64)  NOT NULL,
  created_at    BIGINT       NOT NULL,
  updated_by    VARCHAR(64)  NOT NULL,
  updated_at    BIGINT       NOT NULL,
  UNIQUE KEY uq_crm_phone (tenant_id, phone_hash),
  KEY ix_crm_customers (tenant_id, created_at),
  FOREIGN KEY (tenant_id) REFERENCES shops(id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON cheesybeez.crm_customers TO 'pos_app'@'localhost';
