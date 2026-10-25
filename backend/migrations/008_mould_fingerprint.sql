-- Mould process fingerprint and AI process-setting advice.
-- A fingerprint describes what a good run looks like for one mould on one machine making one product: the typical level
-- and spread of every process setting, the correlations between settings and the variation between shifts and days,
-- learned from good-quality production only. Versions are kept: building, "accept the new normal" (rebaseline) and
-- reset each add or close a version, so the history shows what "normal" was at any date. At most one version per scope
-- is active.
CREATE TABLE mould_fingerprints (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY IMMEDIATE,
  mould_id TEXT NOT NULL REFERENCES equipment(id) DEFERRABLE INITIALLY IMMEDIATE,
  equipment_id TEXT NOT NULL REFERENCES equipment(id) DEFERRABLE INITIALLY IMMEDIATE,
  product_id TEXT NOT NULL REFERENCES products(id) DEFERRABLE INITIALLY IMMEDIATE,
  version BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','superseded','reset')),
  origin TEXT NOT NULL CHECK (origin IN ('auto','manual','rebaseline')),
  fingerprint TEXT NOT NULL,
  sample_size BIGINT NOT NULL,
  batches BIGINT NOT NULL,
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id) DEFERRABLE INITIALLY IMMEDIATE,
  created_at TEXT NOT NULL,
  closed_by TEXT REFERENCES users(id) DEFERRABLE INITIALLY IMMEDIATE,
  closed_at TEXT,
  UNIQUE (mould_id, equipment_id, product_id, version)
);
CREATE UNIQUE INDEX idx_mould_fingerprints_active ON mould_fingerprints(mould_id, equipment_id, product_id) WHERE status = 'active';
CREATE INDEX idx_mould_fingerprints_company ON mould_fingerprints(company_id, mould_id);

-- Every time an engineer asked "What should I change?": the data the answer rested on, the answer, who asked, and
-- later whether it was tried and whether it helped (the outcome is recorded for a future feedback loop; nothing learns
-- from it yet). The advice is a suggestion only: no machine setting is ever written.
CREATE TABLE process_advice (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY IMMEDIATE,
  mould_id TEXT NOT NULL REFERENCES equipment(id) DEFERRABLE INITIALLY IMMEDIATE,
  equipment_id TEXT NOT NULL REFERENCES equipment(id) DEFERRABLE INITIALLY IMMEDIATE,
  product_id TEXT NOT NULL REFERENCES products(id) DEFERRABLE INITIALLY IMMEDIATE,
  fingerprint_id TEXT NOT NULL REFERENCES mould_fingerprints(id) DEFERRABLE INITIALLY IMMEDIATE,
  fingerprint_version BIGINT NOT NULL,
  asked_by TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY IMMEDIATE,
  asked_at TEXT NOT NULL,
  question TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK (source IN ('ai','standard')),
  model TEXT,
  drift_score DOUBLE PRECISION,
  drift_level TEXT,
  max_step_pct DOUBLE PRECISION NOT NULL,
  sources TEXT NOT NULL DEFAULT '[]',
  advice TEXT NOT NULL,
  outcome TEXT CHECK (outcome IN ('helped','did_not_help','not_tried')),
  outcome_note TEXT NOT NULL DEFAULT '',
  outcome_by TEXT REFERENCES users(id) DEFERRABLE INITIALLY IMMEDIATE,
  outcome_at TEXT
);
CREATE INDEX idx_process_advice_mould ON process_advice(company_id, mould_id, asked_at DESC);
