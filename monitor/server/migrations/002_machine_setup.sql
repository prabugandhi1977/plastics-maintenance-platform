-- Machine and signal set-up from the dashboard: basic data and type parameters per machine, sensor details per
-- signal, and a photo and documents (manuals, data sheets, calibration certificates) for both.
ALTER TABLE machines ADD COLUMN serial_number TEXT NOT NULL DEFAULT '';
ALTER TABLE machines ADD COLUMN year_built INTEGER;
-- Type parameters (clamp force, screw diameter, cooling capacity ...) as JSON; the fields per type are in catalog.js.
ALTER TABLE machines ADD COLUMN specs TEXT NOT NULL DEFAULT '{}';
ALTER TABLE machines ADD COLUMN notes TEXT NOT NULL DEFAULT '';

ALTER TABLE signals ADD COLUMN sensor_type TEXT NOT NULL DEFAULT '';
ALTER TABLE signals ADD COLUMN range_min REAL;
ALTER TABLE signals ADD COLUMN range_max REAL;
-- Where the value comes from: PLC tag, OPC UA node ID or MQTT topic.
ALTER TABLE signals ADD COLUMN source_address TEXT NOT NULL DEFAULT '';
ALTER TABLE signals ADD COLUMN sensor_make TEXT NOT NULL DEFAULT '';
ALTER TABLE signals ADD COLUMN notes TEXT NOT NULL DEFAULT '';

-- Files belong to a machine, or to one of its signals when signal_key is set. Kind 'photo' is the one picture shown
-- for it (a new photo replaces the old); 'document' is any number of attachments. The bytes live in the database so
-- a backup of monitor.sqlite holds everything.
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  signal_key TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('photo','document')),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  uploaded_by TEXT REFERENCES users(id),
  uploaded_at INTEGER NOT NULL);
CREATE INDEX files_by_owner ON files(machine_id, signal_key, kind);
