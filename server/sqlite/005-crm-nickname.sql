-- A customer's nickname (2026-11-25): what the counter knows them by ("Kasu", "Malli"), sealed like
-- the name. Shown beside the full name when the cashier searches, and searched as well.
ALTER TABLE crm_customers ADD COLUMN nickname_enc TEXT;
