-- Push sign-ups for offers (CRM, cloud/src/push.ts). The cloud only passes them on: a row waits here
-- until the shop PC has taken it (minutes, when the shop is online), then is deleted; anything older
-- than 30 days is deleted too. Campaigns are sent from the shop PC, never from here.
CREATE TABLE push_keys (
  tenant_id   TEXT    PRIMARY KEY REFERENCES shops(id),
  public_key  TEXT    NOT NULL,                 -- the shop's VAPID public key: the app needs it to sign up
  updated_at  INTEGER NOT NULL
);

CREATE TABLE push_inbox (
  id          TEXT    PRIMARY KEY,
  tenant_id   TEXT    NOT NULL REFERENCES shops(id),
  kind        TEXT    NOT NULL CHECK (kind IN ('subscribe', 'unsubscribe')),
  body        TEXT    NOT NULL,                 -- {phone, subscription} or {endpoint}
  ip_hash     TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX push_inbox_tenant ON push_inbox (tenant_id, created_at);
CREATE INDEX push_inbox_ip ON push_inbox (ip_hash, created_at);
