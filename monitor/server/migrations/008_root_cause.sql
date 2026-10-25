-- AI root-cause analysis for a finding. The latest analysis per finding is kept (result_json) with the data version it
-- was made from, so it is served from here until the data changes or someone refreshes it. Viewers read what is stored.
CREATE TABLE root_causes (
  finding_id TEXT PRIMARY KEY REFERENCES findings(id) ON DELETE CASCADE,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  data_version TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('ai','standard')),
  result_json TEXT NOT NULL,
  -- The first-ranked cause and its confidence, kept apart so lists and prompts need not read the whole result.
  top_cause TEXT,
  top_confidence TEXT,
  generated_at INTEGER NOT NULL,
  generated_by TEXT REFERENCES users(id) ON DELETE SET NULL);

-- What an engineer found the cause to be when the finding was resolved. top_cause is the analysis' first-ranked cause
-- at that moment (and its source), top_match 1 when the engineer picked it, 0 when they picked another or typed their
-- own, null when there was no analysis to compare with. These rows feed the accuracy figures in Settings and appear as
-- past-finding evidence in later analyses; nothing else is changed by them.
CREATE TABLE actual_causes (
  finding_id TEXT PRIMARY KEY REFERENCES findings(id) ON DELETE CASCADE,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  machine_type TEXT NOT NULL,
  signal_key TEXT NOT NULL DEFAULT '',
  cause TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  picked_index INTEGER,
  top_cause TEXT,
  top_source TEXT CHECK(top_source IN ('ai','standard')),
  top_match INTEGER CHECK(top_match IN (0,1)),
  recorded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  recorded_at INTEGER NOT NULL);
CREATE INDEX actual_causes_by_type ON actual_causes(machine_type, signal_key);
