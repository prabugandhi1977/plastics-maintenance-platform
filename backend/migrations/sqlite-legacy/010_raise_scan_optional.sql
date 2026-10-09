-- Rollout: raising a ticket does not need a scan yet (closing still does). A platform admin can require it again
-- under Settings → Scan at the machine.
UPDATE settings SET value=json_set(value,'$.raise','optional'),updated_at=datetime('now') WHERE key='scan_policy' AND json_valid(value);
INSERT OR IGNORE INTO settings (key,value,updated_at) VALUES ('scan_policy','{"raise":"optional","close":"required"}',datetime('now'));
