-- Smart factory, stage 1: production monitoring (OEE) and the shared alert system.
-- Machine data arrives through one ingest path (simulator now, PLC/sensor adapters later) into these tables.

-- Working time per plant; time outside shifts is not planned production time.
CREATE TABLE IF NOT EXISTS shifts (id TEXT PRIMARY KEY, plant_id TEXT NOT NULL REFERENCES plants(id), name TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, days TEXT NOT NULL DEFAULT '[1,2,3,4,5,6,7]', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_shifts_plant ON shifts(plant_id);

-- Parts made, with the ideal rate that OEE performance is measured against.
CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), part_number TEXT NOT NULL, name TEXT NOT NULL, material TEXT NOT NULL, part_weight_g REAL, unit TEXT NOT NULL DEFAULT 'parts' CHECK(unit IN ('parts','kg','m')), ideal_cycle_s REAL, cavities INTEGER NOT NULL DEFAULT 1, ideal_rate_per_hour REAL NOT NULL, mould_id TEXT REFERENCES equipment(id), default_machine_id TEXT REFERENCES equipment(id), active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, UNIQUE(company_id,part_number));

-- What each machine was doing, as time intervals (open interval: ended_at NULL).
CREATE TABLE IF NOT EXISTS machine_states (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), equipment_id TEXT NOT NULL REFERENCES equipment(id), state TEXT NOT NULL CHECK(state IN ('running','idle','down','setup','planned_stop','offline')), reason_code TEXT, started_at TEXT NOT NULL, ended_at TEXT, source TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_states_asset_time ON machine_states(equipment_id,started_at);

-- Output per interval: total quantity and scrap, with the ideal rate in force at the time.
CREATE TABLE IF NOT EXISTS production_counts (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), equipment_id TEXT NOT NULL REFERENCES equipment(id), product_id TEXT REFERENCES products(id), period_start TEXT NOT NULL, period_minutes INTEGER NOT NULL, total_qty REAL NOT NULL, scrap_qty REAL NOT NULL, unit TEXT NOT NULL, ideal_rate_per_hour REAL NOT NULL, source TEXT NOT NULL, UNIQUE(equipment_id,period_start));
CREATE INDEX IF NOT EXISTS idx_counts_asset_time ON production_counts(equipment_id,period_start);

-- Where the simulator (or a pull adapter) has generated data up to, per machine.
CREATE TABLE IF NOT EXISTS factory_cursors (equipment_id TEXT NOT NULL REFERENCES equipment(id), stream TEXT NOT NULL, until TEXT NOT NULL, PRIMARY KEY(equipment_id,stream));

-- Alerts from every module; at most one open alert per dedupe key.
CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), plant_id TEXT REFERENCES plants(id), module TEXT NOT NULL, severity TEXT NOT NULL CHECK(severity IN ('info','warning','critical')), equipment_id TEXT REFERENCES equipment(id), title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','acknowledged','resolved')), dedupe_key TEXT NOT NULL, ticket_id TEXT REFERENCES tickets(id), created_at TEXT NOT NULL, acknowledged_by TEXT REFERENCES users(id), acknowledged_at TEXT, resolved_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_open_key ON alerts(dedupe_key) WHERE status<>'resolved';
CREATE INDEX IF NOT EXISTS idx_alerts_company_time ON alerts(company_id,created_at DESC);

-- Email notifications queued for alerts; sent when an email provider is configured.
CREATE TABLE IF NOT EXISTS notification_outbox (id TEXT PRIMARY KEY, alert_id TEXT REFERENCES alerts(id), channel TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','sent','failed','not_configured')), error TEXT, created_at TEXT NOT NULL, sent_at TEXT);
ALTER TABLE users ADD COLUMN alert_emails INTEGER NOT NULL DEFAULT 1;

-- A non-login account that automatic actions (alerts, auto-raised tickets) are recorded against.
INSERT OR IGNORE INTO users (id,company_id,provider_id,name,email,password_hash,role,active,service_areas,skills,created_at) VALUES ('u-system',NULL,NULL,'Automatic monitoring','system@platform.local','disabled:00','platform_admin',0,'[]','[]',datetime('now'));
