-- Energy audit (SEC test and servo-hydraulic upgrade case).
-- Meters registered against a machine, raw high-rate samples (kept only for audit windows, then rolled up to one-minute
-- aggregates), audits with their nameplate/assumptions and a stored result, cycle phase templates per product, and the
-- company's editable materials / benchmark / saving-factor tables.
ALTER TABLE integration_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT 'tickets';
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_entity_type_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_entity_type_check CHECK (entity_type IN ('equipment','ticket','work_log','energy_audit'));

CREATE TABLE energy_meters (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY IMMEDIATE,
  equipment_id TEXT NOT NULL REFERENCES equipment(id) DEFERRABLE INITIALLY IMMEDIATE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('analyzer','lorawan_ct','generic')),
  transport TEXT NOT NULL DEFAULT 'http' CHECK (transport IN ('http','mqtt','lorawan','ble')),
  device_id TEXT,
  measures TEXT NOT NULL CHECK (measures IN ('power','current','energy')),
  nominal_interval_ms BIGINT NOT NULL CHECK (nominal_interval_ms >= 10 AND nominal_interval_ms <= 86400000),
  voltage_v DOUBLE PRECISION,
  assumed_pf DOUBLE PRECISION,
  voltage_basis TEXT NOT NULL DEFAULT 'll' CHECK (voltage_basis IN ('ll','ln')),
  mapping TEXT NOT NULL DEFAULT '{}',
  ble_config TEXT NOT NULL DEFAULT '{}',
  clock_mode TEXT NOT NULL DEFAULT 'device' CHECK (clock_mode IN ('device','receive')),
  active BIGINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  last_seen_at TEXT,
  last_sample_ts BIGINT,
  clock_offset_ms BIGINT,
  observed_interval_ms DOUBLE PRECISION,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_energy_meters_company ON energy_meters(company_id, equipment_id);

CREATE TABLE energy_samples (
  meter_id TEXT NOT NULL REFERENCES energy_meters(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  ts BIGINT NOT NULL,
  rx BIGINT NOT NULL,
  kw DOUBLE PRECISION,
  kva DOUBLE PRECISION,
  kvar DOUBLE PRECISION,
  pf DOUBLE PRECISION,
  volts DOUBLE PRECISION,
  amps DOUBLE PRECISION,
  thd DOUBLE PRECISION,
  kwh_total DOUBLE PRECISION,
  cyc BIGINT,
  PRIMARY KEY (meter_id, ts)
);
CREATE INDEX idx_energy_samples_rx ON energy_samples(rx);

CREATE TABLE energy_sample_agg (
  meter_id TEXT NOT NULL REFERENCES energy_meters(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  ts BIGINT NOT NULL,
  n BIGINT NOT NULL,
  kw_n BIGINT NOT NULL,
  kw_sum DOUBLE PRECISION NOT NULL,
  kw_max DOUBLE PRECISION,
  pf_n BIGINT NOT NULL,
  pf_sum DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (meter_id, ts)
);

CREATE TABLE energy_audit_settings (
  company_id TEXT PRIMARY KEY REFERENCES companies(id) DEFERRABLE INITIALLY IMMEDIATE,
  materials TEXT,
  benchmarks TEXT,
  factors TEXT,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE energy_cycle_templates (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY IMMEDIATE,
  product_id TEXT NOT NULL REFERENCES products(id) DEFERRABLE INITIALLY IMMEDIATE,
  name TEXT NOT NULL,
  phases TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (product_id)
);

CREATE TABLE energy_audits (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY IMMEDIATE,
  plant_id TEXT NOT NULL REFERENCES plants(id) DEFERRABLE INITIALLY IMMEDIATE,
  equipment_id TEXT NOT NULL REFERENCES equipment(id) DEFERRABLE INITIALLY IMMEDIATE,
  product_id TEXT REFERENCES products(id) DEFERRABLE INITIALLY IMMEDIATE,
  meter_id TEXT REFERENCES energy_meters(id) DEFERRABLE INITIALLY IMMEDIATE,
  meter_note TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  material TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','running','completed','cancelled')),
  period_start_ms BIGINT,
  period_end_ms BIGINT,
  mass_mode TEXT NOT NULL DEFAULT 'counts' CHECK (mass_mode IN ('counts','manual')),
  manual_kg DOUBLE PRECISION,
  manual_parts DOUBLE PRECISION,
  nameplate TEXT NOT NULL DEFAULT '{}',
  assumptions TEXT NOT NULL DEFAULT '{}',
  notes TEXT NOT NULL DEFAULT '',
  analysis TEXT,
  keep_raw_until_ms BIGINT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_energy_audits_company ON energy_audits(company_id, created_at DESC);
CREATE INDEX idx_energy_audits_meter ON energy_audits(meter_id);
