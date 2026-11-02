-- The owner's Disconnect button (SCRUM-197): a link stops working the moment this is set. It is kept
-- for a minute so his Undo can bring it back, then removed by the next Disconnect.
ALTER TABLE mcp_links ADD COLUMN revoked_at INTEGER;
