-- Staff PIN logins and roles (SCRUM-40/41). Applied by `npm run server:migrate`.

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

-- UPDATE on staff only to switch someone off; sessions are insert-only, like events.
GRANT INSERT, UPDATE ON cheesybeez.staff TO 'pos_app'@'localhost';
GRANT INSERT ON cheesybeez.sessions TO 'pos_app'@'localhost';
