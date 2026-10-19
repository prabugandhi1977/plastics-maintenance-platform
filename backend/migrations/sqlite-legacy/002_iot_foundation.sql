-- IoT foundation: managed device mappings, idempotent readings with quality flags, alarm lifecycle,
-- pull-adapter cursors, sync run history, and a quarantine for rejected payloads.
ALTER TABLE device_mappings ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE device_mappings ADD COLUMN stale_after_minutes INTEGER NOT NULL DEFAULT 30;
ALTER TABLE readings ADD COLUMN source TEXT NOT NULL DEFAULT 'push';
ALTER TABLE readings ADD COLUMN quality_flags TEXT NOT NULL DEFAULT '[]';
DELETE FROM readings WHERE rowid NOT IN (SELECT MIN(rowid) FROM readings GROUP BY external_device_id, observed_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_readings_device_time ON readings(external_device_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_device_mappings_equipment ON device_mappings(equipment_id);
CREATE TABLE IF NOT EXISTS iot_alarms (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), equipment_id TEXT NOT NULL REFERENCES equipment(id), external_device_id TEXT NOT NULL, code TEXT NOT NULL, severity TEXT NOT NULL CHECK(severity IN ('info','warning','critical')), message TEXT NOT NULL DEFAULT '', raised_at TEXT NOT NULL, cleared_at TEXT, received_at TEXT NOT NULL, source TEXT NOT NULL, UNIQUE(external_device_id, code, raised_at));
CREATE INDEX IF NOT EXISTS idx_alarms_asset_open ON iot_alarms(equipment_id, cleared_at);
CREATE TABLE IF NOT EXISTS iot_rejections (id TEXT PRIMARY KEY, source TEXT NOT NULL, external_device_id TEXT, reasons TEXT NOT NULL, raw_json TEXT NOT NULL, received_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_rejections_time ON iot_rejections(received_at DESC);
CREATE TABLE IF NOT EXISTS integration_cursors (adapter TEXT PRIMARY KEY, cursor TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS integration_runs (id TEXT PRIMARY KEY, adapter TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')), accepted INTEGER NOT NULL DEFAULT 0, duplicates INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0, cursor_before TEXT, cursor_after TEXT, error TEXT);
CREATE INDEX IF NOT EXISTS idx_runs_time ON integration_runs(started_at DESC);
