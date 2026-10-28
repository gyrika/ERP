-- Delivery from cheesybeez.com (SCRUM-193): the shop's rider takes it, the customer pays the rider in cash.
-- The address and shared location are the customer's, like name and phone: blanked after 30 days.
ALTER TABLE online_orders ADD COLUMN kind TEXT NOT NULL DEFAULT 'pickup';   -- pickup, delivery
ALTER TABLE online_orders ADD COLUMN address TEXT;                          -- delivery only
ALTER TABLE online_orders ADD COLUMN pin TEXT;                              -- {"lat":…,"lng":…} when shared
ALTER TABLE online_orders ADD COLUMN delivery_fee INTEGER NOT NULL DEFAULT 0; -- cents, already in total
