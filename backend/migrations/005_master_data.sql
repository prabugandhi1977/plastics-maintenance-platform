-- Industry-standard master data: mandatory parameter sets for companies, plants, users, providers, equipment,
-- tickets (ISO 14224 failure reporting and close-out), contracts, spare parts and quotes; managed service areas;
-- platform settings. Existing rows get neutral defaults and are flagged as incomplete by the API, not rejected.
ALTER TABLE companies ADD COLUMN country TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN contact_name TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN contact_email TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN contact_phone TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN tax_id TEXT NOT NULL DEFAULT '';

ALTER TABLE plants ADD COLUMN operating_pattern TEXT NOT NULL DEFAULT '24x7';

ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN job_title TEXT NOT NULL DEFAULT '';

ALTER TABLE providers ADD COLUMN contact_name TEXT NOT NULL DEFAULT '';
ALTER TABLE providers ADD COLUMN contact_email TEXT NOT NULL DEFAULT '';
ALTER TABLE providers ADD COLUMN contact_phone TEXT NOT NULL DEFAULT '';
ALTER TABLE providers ADD COLUMN country TEXT NOT NULL DEFAULT '';
ALTER TABLE providers ADD COLUMN insurance_expiry TEXT;
ALTER TABLE providers ADD COLUMN certifications TEXT NOT NULL DEFAULT '';

ALTER TABLE equipment ADD COLUMN asset_tag TEXT;
ALTER TABLE equipment ADD COLUMN criticality TEXT NOT NULL DEFAULT 'B' CHECK(criticality IN ('A','B','C'));
ALTER TABLE equipment ADD COLUMN status TEXT NOT NULL DEFAULT 'in_service' CHECK(status IN ('in_service','standby','out_of_service','decommissioned'));
ALTER TABLE equipment ADD COLUMN year_built INTEGER;
ALTER TABLE equipment ADD COLUMN commissioned_at TEXT;
ALTER TABLE equipment ADD COLUMN warranty_until TEXT;
ALTER TABLE equipment ADD COLUMN specs TEXT NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX IF NOT EXISTS idx_equipment_asset_tag ON equipment(company_id,asset_tag) WHERE asset_tag IS NOT NULL;

ALTER TABLE tickets ADD COLUMN failure_category TEXT;
ALTER TABLE tickets ADD COLUMN machine_state TEXT;
ALTER TABLE tickets ADD COLUMN safety_issue INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tickets ADD COLUMN occurred_at TEXT;
ALTER TABLE tickets ADD COLUMN failure_mode TEXT;
ALTER TABLE tickets ADD COLUMN root_cause TEXT;
ALTER TABLE tickets ADD COLUMN action_taken TEXT;
UPDATE tickets SET occurred_at=created_at WHERE occurred_at IS NULL;

ALTER TABLE contracts ADD COLUMN contract_number TEXT;
ALTER TABLE contracts ADD COLUMN coverage_hours TEXT NOT NULL DEFAULT '8x5';
ALTER TABLE contracts ADD COLUMN restore_hours INTEGER;
ALTER TABLE contracts ADD COLUMN visits_per_year INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contracts ADD COLUMN notice_days INTEGER NOT NULL DEFAULT 60;
CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_number ON contracts(company_id,contract_number) WHERE contract_number IS NOT NULL;

ALTER TABLE parts_requests ADD COLUMN part_number TEXT NOT NULL DEFAULT '';
ALTER TABLE parts_requests ADD COLUMN unit TEXT NOT NULL DEFAULT 'pcs';
ALTER TABLE parts_requests ADD COLUMN urgency TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE parts_requests ADD COLUMN manufacturer TEXT NOT NULL DEFAULT '';
ALTER TABLE quotations ADD COLUMN valid_until TEXT;

-- Service areas become a managed list, so plants, engineers and providers pick the same codes.
CREATE TABLE IF NOT EXISTS service_areas (code TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
INSERT OR IGNORE INTO service_areas (code,name,created_at) SELECT DISTINCT service_area,service_area,datetime('now') FROM plants WHERE service_area<>'';
INSERT OR IGNORE INTO service_areas (code,name,created_at) SELECT DISTINCT j.value,j.value,datetime('now') FROM providers p, json_each(p.service_areas) j WHERE json_valid(p.service_areas);
INSERT OR IGNORE INTO service_areas (code,name,created_at) SELECT DISTINCT j.value,j.value,datetime('now') FROM users u, json_each(u.service_areas) j WHERE json_valid(u.service_areas);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
INSERT OR IGNORE INTO settings (key,value,updated_at) VALUES ('default_response_hours','{"critical":4,"high":8,"medium":24,"low":72}',datetime('now'));
