-- What the owner's ChatGPT reads beyond sales (SCRUM-198): one row per shop, replaced by the shop
-- server every few minutes while ChatGPT is connected. It can be emptied at any time; the shop
-- server sends it again. computed_at is the shop's clock.
CREATE TABLE owner_digests (
  tenant_id    TEXT    PRIMARY KEY REFERENCES shops(id),
  computed_at  INTEGER NOT NULL,
  uploaded_at  INTEGER NOT NULL,
  body         TEXT    NOT NULL
);
