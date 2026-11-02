-- The owner's ChatGPT plugin (SCRUM-197): ChatGPT reads the shop through an MCP server, with its own tokens.
-- These are not rows in devices, so an MCP token opens /mcp and nothing else.
-- device_id is the owner's phone that approved it; removing that device cuts ChatGPT off too.
-- Tokens and codes are kept only as hashes. No foreign key to devices: migrations rebuild that table.
CREATE TABLE mcp_codes (
  code_hash       TEXT    PRIMARY KEY,
  tenant_id       TEXT    NOT NULL REFERENCES shops(id),
  device_id       TEXT    NOT NULL,
  redirect_uri    TEXT    NOT NULL,
  code_challenge  TEXT    NOT NULL,                 -- PKCE S256
  expires_at      INTEGER NOT NULL
);

CREATE TABLE mcp_links (
  access_hash         TEXT    PRIMARY KEY,
  refresh_hash        TEXT    NOT NULL UNIQUE,
  tenant_id           TEXT    NOT NULL REFERENCES shops(id),
  device_id           TEXT    NOT NULL,
  access_expires_at   INTEGER NOT NULL,
  refresh_expires_at  INTEGER NOT NULL,
  created_at          INTEGER NOT NULL
);
