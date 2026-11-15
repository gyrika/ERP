-- Customer accounts on cheesybeez.com (cloud/src/accounts.ts). The cloud is the master copy: the
-- customer writes their profile from anywhere, even while the shop PC is off. The shop PC gets only
-- what the counter needs (name and phone, with each order, as before).
-- Everything personal is sealed (AES-256-GCM, key = the Worker secret PROFILE_KEY); lookups use keyed
-- hashes, so a copy of these tables names nobody without the key.
CREATE TABLE customer_accounts (
  id            TEXT    PRIMARY KEY,               -- acc-…
  tenant_id     TEXT    NOT NULL REFERENCES shops(id),
  google_hash   TEXT    NOT NULL,                  -- keyed hash of Google's account id (sub)
  phone_hash    TEXT,                              -- keyed hash of the mobile (0XXXXXXXXX), once given
  profile       TEXT    NOT NULL,                  -- sealed {name, phone, email}
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX customer_accounts_google ON customer_accounts (tenant_id, google_hash);
CREATE INDEX customer_accounts_phone ON customer_accounts (tenant_id, phone_hash);

-- Saved delivery addresses (at most 5 per account), each with the map pin the fee is measured from.
CREATE TABLE customer_addresses (
  id            TEXT    PRIMARY KEY,               -- adr-…
  account_id    TEXT    NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  tenant_id     TEXT    NOT NULL REFERENCES shops(id),
  body          TEXT    NOT NULL,                  -- sealed {label, address, pin}
  last_used_at  INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX customer_addresses_account ON customer_addresses (account_id, last_used_at);

-- Signed-in phones and browsers: only a hash of the cookie's token is kept. 90 days, then gone.
CREATE TABLE customer_sessions (
  token_hash    TEXT    PRIMARY KEY,
  account_id    TEXT    NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  tenant_id     TEXT    NOT NULL REFERENCES shops(id),
  ip_hash       TEXT    NOT NULL,                  -- to slow down floods of sign-ins, never shown
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX customer_sessions_account ON customer_sessions (account_id);
CREATE INDEX customer_sessions_ip ON customer_sessions (ip_hash, created_at);

-- An order placed while signed in belongs to that account ("Your orders", "Order again").
-- Deleting the account blanks it here; the order itself stays for the shop's books.
ALTER TABLE online_orders ADD COLUMN account_id TEXT;
CREATE INDEX online_orders_account ON online_orders (account_id, created_at);
