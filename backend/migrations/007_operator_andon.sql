-- Operator tablet and andon. Stations are tablets (or andon boards) bound to machines of one plant; a station signs in
-- with its code and a short PIN and then acts only on its own machines. Only the PIN's hash is stored; repeated wrong
-- PINs lock the station for a while (failed_attempts, locked_until). Bumping session_version signs every tablet out.
CREATE TABLE operator_stations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY IMMEDIATE,
  plant_id TEXT NOT NULL REFERENCES plants(id) DEFERRABLE INITIALLY IMMEDIATE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'tablet' CHECK (kind IN ('tablet','board')),
  code TEXT NOT NULL UNIQUE,
  pin_hash TEXT NOT NULL,
  active BIGINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  session_version BIGINT NOT NULL DEFAULT 0,
  failed_attempts BIGINT NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY IMMEDIATE,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_operator_stations_company ON operator_stations(company_id, plant_id);
-- Machines a tablet may act on (a board shows its whole plant and needs none).
CREATE TABLE operator_station_machines (
  station_id TEXT NOT NULL REFERENCES operator_stations(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  equipment_id TEXT NOT NULL REFERENCES equipment(id) DEFERRABLE INITIALLY IMMEDIATE,
  PRIMARY KEY (station_id, equipment_id)
);

-- What operators record at the machine: downtime reasons (classifying a stop interval), scrap with reason and quantity,
-- and job / mould change start and finish. shift_* is the plant shift the entry fell in, for reports by shift.
CREATE TABLE operator_events (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY IMMEDIATE,
  plant_id TEXT NOT NULL REFERENCES plants(id) DEFERRABLE INITIALLY IMMEDIATE,
  equipment_id TEXT NOT NULL REFERENCES equipment(id) DEFERRABLE INITIALLY IMMEDIATE,
  station_id TEXT REFERENCES operator_stations(id) DEFERRABLE INITIALLY IMMEDIATE,
  kind TEXT NOT NULL CHECK (kind IN ('downtime','scrap','job_start','job_finish','mould_change_start','mould_change_finish')),
  state TEXT,
  reason TEXT,
  quantity DOUBLE PRECISION,
  state_id TEXT,
  product_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  operator_name TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY IMMEDIATE,
  shift_name TEXT,
  shift_date TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_operator_events_machine ON operator_events(equipment_id, created_at);
CREATE INDEX idx_operator_events_company ON operator_events(company_id, kind, created_at);

-- A job (a product running on the machine) or a mould change; open while ended_at is NULL (one of each per machine).
CREATE TABLE operator_jobs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY IMMEDIATE,
  equipment_id TEXT NOT NULL REFERENCES equipment(id) DEFERRABLE INITIALLY IMMEDIATE,
  kind TEXT NOT NULL CHECK (kind IN ('job','mould_change')),
  product_id TEXT REFERENCES products(id) DEFERRABLE INITIALLY IMMEDIATE,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  started_by TEXT NOT NULL,
  ended_by TEXT
);
CREATE UNIQUE INDEX idx_operator_jobs_open ON operator_jobs(equipment_id, kind) WHERE ended_at IS NULL;

-- Andon calls: a timed request for help at a machine. Escalation level 0 is the first notification; each later level
-- is reached when the call is still unacknowledged after that level's minutes (andon_settings, per company).
CREATE TABLE andon_calls (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY IMMEDIATE,
  plant_id TEXT NOT NULL REFERENCES plants(id) DEFERRABLE INITIALLY IMMEDIATE,
  equipment_id TEXT NOT NULL REFERENCES equipment(id) DEFERRABLE INITIALLY IMMEDIATE,
  station_id TEXT REFERENCES operator_stations(id) DEFERRABLE INITIALLY IMMEDIATE,
  call_type TEXT NOT NULL CHECK (call_type IN ('maintenance','quality','material','supervisor','safety')),
  severity TEXT NOT NULL CHECK (severity IN ('warning','critical')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  level BIGINT NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  machine_state TEXT,
  machine_reason TEXT,
  operator_name TEXT NOT NULL DEFAULT '',
  raised_by TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY IMMEDIATE,
  raised_at TEXT NOT NULL,
  shift_name TEXT,
  shift_date TEXT,
  escalated_at TEXT,
  acknowledged_at TEXT,
  acknowledged_by TEXT REFERENCES users(id) DEFERRABLE INITIALLY IMMEDIATE,
  acknowledged_name TEXT,
  resolved_at TEXT,
  resolved_by TEXT REFERENCES users(id) DEFERRABLE INITIALLY IMMEDIATE,
  resolution TEXT,
  alert_id TEXT REFERENCES alerts(id) DEFERRABLE INITIALLY IMMEDIATE,
  ticket_id TEXT REFERENCES tickets(id) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX idx_andon_calls_company ON andon_calls(company_id, plant_id, raised_at);
CREATE INDEX idx_andon_calls_open ON andon_calls(status, raised_at) WHERE status<>'resolved';
CREATE INDEX idx_andon_calls_machine ON andon_calls(equipment_id, status);

-- Who is called for each andon type and when it escalates, per company (JSON; defaults in services/factory/andon.js).
CREATE TABLE andon_settings (
  company_id TEXT PRIMARY KEY REFERENCES companies(id) DEFERRABLE INITIALLY IMMEDIATE,
  config TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
