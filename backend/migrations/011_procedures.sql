-- Work procedures: step-by-step instructions (what to do, safety callouts, specifications such as torque, parts, a
-- required measurement or photo) that a technician follows on a work order, and the record of how each run went.
-- A procedure is versioned: editing means a new draft version; publishing makes it active and retires the previous
-- active version of the same code. When a procedure is attached to a ticket its steps are copied (the definition as
-- it was), so the record stays true after the procedure is changed. Execution data is what flows back: measurements and
-- whether they were in range, photos, deviations, who did each step and how long it took.
CREATE TABLE procedures (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  version BIGINT NOT NULL,
  title TEXT NOT NULL,
  machine_types TEXT NOT NULL DEFAULT '[]',
  auto_attach BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('draft','active','retired')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE (code, version)
);

CREATE TABLE procedure_steps (
  id TEXT PRIMARY KEY,
  procedure_id TEXT NOT NULL REFERENCES procedures(id) DEFERRABLE INITIALLY IMMEDIATE,
  position BIGINT NOT NULL,
  title TEXT NOT NULL,
  instruction TEXT NOT NULL DEFAULT '',
  safety TEXT NOT NULL DEFAULT '',
  spec TEXT NOT NULL DEFAULT '',
  parts TEXT NOT NULL DEFAULT '[]',
  measurement TEXT,
  requires_photo BIGINT NOT NULL DEFAULT 0,
  mandatory BIGINT NOT NULL DEFAULT 1,
  expected_minutes BIGINT
);
CREATE INDEX procedure_steps_procedure ON procedure_steps (procedure_id, position);

CREATE TABLE ticket_procedures (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) DEFERRABLE INITIALLY IMMEDIATE,
  procedure_id TEXT NOT NULL REFERENCES procedures(id) DEFERRABLE INITIALLY IMMEDIATE,
  code TEXT NOT NULL,
  version BIGINT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress','completed')),
  attached_by TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (ticket_id, procedure_id)
);

CREATE TABLE ticket_procedure_steps (
  id TEXT PRIMARY KEY,
  ticket_procedure_id TEXT NOT NULL REFERENCES ticket_procedures(id) DEFERRABLE INITIALLY IMMEDIATE,
  step_id TEXT NOT NULL,
  position BIGINT NOT NULL,
  def TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','skipped')),
  measurement_value DOUBLE PRECISION,
  in_range BIGINT,
  photo_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  deviation TEXT NOT NULL DEFAULT '',
  completed_at TEXT,
  completed_by TEXT,
  seconds BIGINT
);
CREATE INDEX ticket_procedure_steps_run ON ticket_procedure_steps (ticket_procedure_id, position);
