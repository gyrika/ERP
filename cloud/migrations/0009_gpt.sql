-- The owner's ChatGPT (SCRUM-197): a private Custom GPT reads the shop through its own tokens.
-- These are not rows in devices, so a GPT token opens the /api/v1/gpt/ endpoints and nothing else.
-- device_id is the owner's phone that approved it; removing that device cuts the GPT off too.
-- Tokens and codes are kept only as hashes. No foreign key to devices: migrations rebuild that table.
CREATE TABLE gpt_codes (
  code_hash     TEXT    PRIMARY KEY,
  tenant_id     TEXT    NOT NULL REFERENCES shops(id),
  device_id     TEXT    NOT NULL,
  redirect_uri  TEXT    NOT NULL,
  expires_at    INTEGER NOT NULL
);

CREATE TABLE gpt_links (
  access_hash        TEXT    PRIMARY KEY,
  refresh_hash       TEXT    NOT NULL UNIQUE,
  tenant_id          TEXT    NOT NULL REFERENCES shops(id),
  device_id          TEXT    NOT NULL,
  access_expires_at  INTEGER NOT NULL,
  created_at         INTEGER NOT NULL
);
