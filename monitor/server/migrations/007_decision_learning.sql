-- Learning from people's decisions. Each decision on a finding (confirmed or resolved = a real problem, false alarm
-- = not) is kept as a labelled example with the features at the time. From these the analysis learns, per machine,
-- signal and detector, how often its alerts were real, and adjusts that detector within fixed bounds. Every change
-- is logged with what changed, from what to what, and on how many decisions. signal_key is '' for a pattern finding.

-- One labelled example per finding (a later decision on the same finding replaces it; the audit log keeps them all).
-- reset_at is set when a super user resets learning for the signal: the example is kept but no longer counts.
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  finding_id TEXT REFERENCES findings(id) ON DELETE SET NULL,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  signal_key TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK(kind IN ('limit','unusual','degrading','pattern')),
  -- The pattern model that fired (relationship or new_state), or the limit side; null otherwise.
  method TEXT,
  severity TEXT NOT NULL CHECK(severity IN ('warning','critical')),
  score REAL,
  -- The finding's detail, the latest value of every signal on the machine, its state and how long the finding was open.
  features_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('confirmed','false_alarm','resolved')),
  real INTEGER NOT NULL CHECK(real IN (0,1)),
  reason TEXT,
  note TEXT NOT NULL DEFAULT '',
  decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at INTEGER NOT NULL,
  reset_at INTEGER);
CREATE INDEX decisions_by_scope ON decisions(machine_id, signal_key, kind, reset_at);
CREATE UNIQUE INDEX decisions_one_per_finding ON decisions(finding_id) WHERE reset_at IS NULL AND finding_id IS NOT NULL;

-- What has been learned per machine, signal and detector: the counts, the precision (with a prior) and the
-- sensitivity factor the analysis applies (1 = as built; above 1 = quieter, below 1 = more sensitive).
CREATE TABLE learned (
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  signal_key TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK(kind IN ('limit','unusual','degrading','pattern')),
  decisions INTEGER NOT NULL,
  real INTEGER NOT NULL,
  precision REAL NOT NULL,
  factor REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (machine_id, signal_key, kind));

-- "Normal for this product" or "planned change": the signal's own normal (and the machine's pattern model) is
-- relearned from baseline_from on. Only the latest active row per machine and signal counts.
CREATE TABLE rebaselines (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  signal_key TEXT NOT NULL DEFAULT '',
  baseline_from INTEGER NOT NULL,
  reason TEXT NOT NULL,
  finding_id TEXT REFERENCES findings(id) ON DELETE SET NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1);
CREATE INDEX rebaselines_by_signal ON rebaselines(machine_id, signal_key, active);

-- Every adjustment, explained: which setting, from what to what, on how many decisions (and how many were real).
CREATE TABLE learning_log (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  signal_key TEXT NOT NULL DEFAULT '',
  kind TEXT,
  change TEXT NOT NULL CHECK(change IN ('threshold','rebaseline','reset')),
  setting TEXT,
  from_value REAL,
  to_value REAL,
  unit TEXT,
  decisions INTEGER NOT NULL DEFAULT 0,
  real INTEGER NOT NULL DEFAULT 0,
  precision REAL,
  summary TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL);
CREATE INDEX learning_log_by_machine ON learning_log(machine_id, created_at);
