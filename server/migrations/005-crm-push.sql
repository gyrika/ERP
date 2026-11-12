-- Push sign-ups (CRM). Same tables as server/sqlite/004-crm-push.sql.
ALTER TABLE crm_customers MODIFY source ENUM('pos','import','manual','app') NOT NULL;

CREATE TABLE IF NOT EXISTS crm_push_subs (
  tenant_id      VARCHAR(64)   NOT NULL,
  endpoint_hash  CHAR(64)      NOT NULL,
  customer_id    CHAR(20)      NOT NULL,
  sub_enc        VARCHAR(2048) NOT NULL,
  created_at     BIGINT        NOT NULL,
  PRIMARY KEY (tenant_id, endpoint_hash),
  KEY ix_crm_push_customer (tenant_id, customer_id),
  FOREIGN KEY (customer_id) REFERENCES crm_customers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS crm_push_log (
  tenant_id    VARCHAR(64)  NOT NULL,
  dedupe_key   VARCHAR(120) NOT NULL,
  customer_id  CHAR(20)     NOT NULL,
  sent_at      BIGINT       NOT NULL,
  PRIMARY KEY (tenant_id, dedupe_key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON cheesybeez.crm_push_subs TO 'pos_app'@'localhost';
GRANT SELECT, INSERT, DELETE ON cheesybeez.crm_push_log TO 'pos_app'@'localhost';
