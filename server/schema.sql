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

-- Staff and their PINs (SCRUM-40/41). The PIN is never stored: only a salted scrypt hash.
-- Login is by PIN alone, so two active staff of one shop never share a PIN (checked when adding).
CREATE TABLE IF NOT EXISTS staff (
  id          VARCHAR(64)  PRIMARY KEY,
  tenant_id   VARCHAR(64)  NOT NULL,
  name        VARCHAR(80)  NOT NULL,
  role        ENUM('cashier','manager','owner','kitchen') NOT NULL,
  pin_salt    CHAR(32)     NOT NULL,
  pin_hash    CHAR(64)     NOT NULL,
  active      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_staff (tenant_id, active),
  FOREIGN KEY (tenant_id) REFERENCES shops(id)
);

-- One row per PIN login on a device. The server accepts an event from a person only if
-- they were logged in on that device at that moment, with a role that allows it.
-- Insert-only, like events: a session simply runs out at expires_at.
CREATE TABLE IF NOT EXISTS sessions (
  id          CHAR(32)     PRIMARY KEY,
  tenant_id   VARCHAR(64)  NOT NULL,
  device_id   VARCHAR(64)  NOT NULL,
  staff_id    VARCHAR(64)  NOT NULL,
  role        ENUM('cashier','manager','owner','kitchen') NOT NULL,  -- the role at login
  started_at  BIGINT       NOT NULL,                                  -- server clock, ms
  expires_at  BIGINT       NOT NULL,
  KEY ix_session (device_id, staff_id, started_at),
  FOREIGN KEY (tenant_id) REFERENCES shops(id),
  FOREIGN KEY (device_id) REFERENCES devices(id),
  FOREIGN KEY (staff_id) REFERENCES staff(id)
);
