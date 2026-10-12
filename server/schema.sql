-- CheesyBeez POS sync server (docs/sync-contract.md). MySQL 8.
-- Run once as an admin:  mysql -u root -p < server/schema.sql
-- Then create the app user (see docs/server-setup.md): INSERT + SELECT on events only.

CREATE DATABASE IF NOT EXISTS cheesybeez CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE cheesybeez;

CREATE TABLE IF NOT EXISTS shops (
  id          VARCHAR(64)  PRIMARY KEY,           -- same string as shopId in the app
  name        VARCHAR(120) NOT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS devices (
  id          VARCHAR(64)  PRIMARY KEY,           -- generated once on each device
  tenant_id   VARCHAR(64)  NOT NULL,
  kind        ENUM('counter','kitchen','owner') NOT NULL,
  token_hash  CHAR(64)     NOT NULL,              -- SHA-256 of the device's secret token
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_token (token_hash),
  FOREIGN KEY (tenant_id) REFERENCES shops(id)
);

CREATE TABLE IF NOT EXISTS events (
  seq           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,  -- the order everyone applies events in
  id            VARCHAR(64)  NOT NULL,                       -- event id from the device
  tenant_id     VARCHAR(64)  NOT NULL,
  device_id     VARCHAR(64)  NOT NULL,
  type          VARCHAR(40)  NOT NULL,                       -- 'order.sent', 'kitchen.bumped', ...
  order_number  INT UNSIGNED NOT NULL,
  at            BIGINT       NOT NULL,                       -- device clock, ms (for display only)
  received_at   BIGINT       NOT NULL,                       -- server clock, ms
  body          JSON         NOT NULL,                       -- the whole event exactly as sent
  UNIQUE KEY uq_event (tenant_id, id),                       -- pushing the same event twice is a no-op
  KEY ix_pull  (tenant_id, seq),
  KEY ix_order (tenant_id, order_number),
  FOREIGN KEY (tenant_id) REFERENCES shops(id),
  FOREIGN KEY (device_id) REFERENCES devices(id)
);
