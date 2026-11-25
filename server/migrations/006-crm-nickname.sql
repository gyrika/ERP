-- A customer's nickname (2026-11-25). Same column as server/sqlite/005-crm-nickname.sql.
ALTER TABLE crm_customers ADD COLUMN nickname_enc VARCHAR(512) NULL AFTER name_enc;
