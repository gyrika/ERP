-- The admin view: what each shop server runs and how its last update went, told on every
-- copy pass (about every 30 s), so the developer sees every shop without AnyDesk.
ALTER TABLE devices ADD COLUMN version TEXT;
ALTER TABLE devices ADD COLUMN update_status TEXT;
ALTER TABLE devices ADD COLUMN last_seen_at INTEGER;
-- Each shop's last sale and today's activity, for the admin list.
CREATE INDEX ix_events_type ON events (tenant_id, type, at);
