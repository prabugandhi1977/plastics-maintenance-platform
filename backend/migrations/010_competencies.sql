-- Competencies: training a technician must have completed before taking work on certain machine types, and the
-- completions that show it. Completions arrive from a learning management system (LMS) or are recorded by hand.
-- A requirement can carry an expiry (validity_months, or an explicit expires_at on the completion) and is either
-- flagged (the dispatcher sees a warning and may still assign) or blocking (assignment is refused).
CREATE TABLE competencies (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  machine_types TEXT NOT NULL DEFAULT '[]',
  validity_months BIGINT,
  enforcement TEXT NOT NULL DEFAULT 'flag' CHECK (enforcement IN ('flag','block')),
  active BIGINT NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE user_competencies (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY IMMEDIATE,
  competency_id TEXT NOT NULL REFERENCES competencies(id) DEFERRABLE INITIALLY IMMEDIATE,
  completed_at TEXT NOT NULL,
  expires_at TEXT,
  score DOUBLE PRECISION,
  source TEXT NOT NULL CHECK (source IN ('lms','manual')),
  external_id TEXT NOT NULL DEFAULT '',
  recorded_by TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (user_id, competency_id, completed_at)
);
CREATE INDEX user_competencies_user ON user_competencies (user_id, competency_id);
