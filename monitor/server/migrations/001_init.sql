CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','engineer','viewer')),
  password_hash TEXT NOT NULL,
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL);

CREATE TABLE machines (
  id TEXT PRIMARY KEY,
  tag TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('injection','extrusion','blow','chiller','dryer','compressor')),
  make TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  line TEXT NOT NULL DEFAULT '',
  -- The ID a gateway sends with its readings (PLC name, OPC UA node, MQTT client).
  device_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL);

-- Limits are optional per side; a signal with no limit at all is still learned and watched by the models.
CREATE TABLE signals (
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  unit TEXT NOT NULL,
  warn_low REAL, warn_high REAL, crit_low REAL, crit_high REAL,
  PRIMARY KEY (machine_id, key));

-- One value per machine, signal and minute (ts in epoch milliseconds, rounded to the minute).
CREATE TABLE readings (
  machine_id TEXT NOT NULL,
  key TEXT NOT NULL,
  ts INTEGER NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (machine_id, key, ts)) WITHOUT ROWID;

-- State changes only: running, idle, down, off.
CREATE TABLE states (
  machine_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('running','idle','down','off')),
  PRIMARY KEY (machine_id, ts)) WITHOUT ROWID;

-- What the analysis found. One open finding per machine, signal and kind; people confirm or reject it, which the
-- analysis respects (a rejected finding stays quiet for 24 h).
CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  signal_key TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('limit','unusual','degrading','pattern')),
  severity TEXT NOT NULL CHECK(severity IN ('warning','critical')),
  status TEXT NOT NULL CHECK(status IN ('open','acknowledged','confirmed','false_alarm','resolved')),
  score REAL,
  detail_json TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  resolved_at INTEGER,
  decided_by TEXT REFERENCES users(id),
  note TEXT NOT NULL DEFAULT '',
  explanation_json TEXT,
  explained_at INTEGER);
CREATE UNIQUE INDEX findings_one_active ON findings(machine_id, IFNULL(signal_key,''), kind) WHERE status IN ('open','acknowledged','confirmed');
CREATE INDEX findings_by_machine ON findings(machine_id, last_seen);

-- One isolation forest per machine, trained on its own healthy history.
CREATE TABLE models (
  machine_id TEXT PRIMARY KEY REFERENCES machines(id) ON DELETE CASCADE,
  trained_at INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  model_json TEXT NOT NULL);

CREATE TABLE ticket_drafts (
  id TEXT PRIMARY KEY,
  finding_id TEXT REFERENCES findings(id) ON DELETE SET NULL,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK(source IN ('ai','standard')),
  draft_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','approved','discarded')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  decided_by TEXT REFERENCES users(id),
  decided_at INTEGER);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  period TEXT NOT NULL CHECK(period IN ('shift','week')),
  from_ts INTEGER NOT NULL,
  to_ts INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('ai','standard')),
  body TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL);

-- The AI chat, one running conversation per user. Assistant turns are stored whole (tool calls and thinking blocks
-- included) because the API needs them back unchanged.
CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content_json TEXT NOT NULL,
  created_at INTEGER NOT NULL);
CREATE INDEX chat_by_conversation ON chat_messages(conversation, id);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE audit (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  at INTEGER NOT NULL);
