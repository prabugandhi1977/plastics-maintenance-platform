-- Preventive maintenance plans and the jobs they generate. Kept apart from breakdown tickets, so MTBF, MTTR and
-- breakdown downtime count only failures.
CREATE TABLE pm_plans (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  plant_id TEXT NOT NULL,
  equipment_id TEXT NOT NULL,
  title TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK(trigger IN ('calendar','runtime','shots')),
  -- Days for calendar plans, running hours for runtime plans, shots for mould plans.
  interval_value BIGINT NOT NULL CHECK(interval_value > 0),
  checklist TEXT NOT NULL DEFAULT '[]',
  -- Usage already accumulated when the plan was set up (e.g. shots since the mould's last service), until the first job.
  start_usage DOUBLE PRECISION NOT NULL DEFAULT 0,
  last_done_at TEXT NOT NULL,
  active BIGINT NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_pm_plans_company ON pm_plans(company_id);
CREATE INDEX idx_pm_plans_equipment ON pm_plans(equipment_id);

CREATE TABLE pm_jobs (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES pm_plans(id),
  company_id TEXT NOT NULL,
  equipment_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed')),
  due_at TEXT NOT NULL,
  completed_at TEXT,
  completed_by TEXT,
  -- Usage ÷ interval when the job was closed; on time means 110 % or less.
  progress_at_completion DOUBLE PRECISION,
  on_time BIGINT,
  notes TEXT NOT NULL DEFAULT '',
  results TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_pm_jobs_plan ON pm_jobs(plan_id, status);
CREATE INDEX idx_pm_jobs_company ON pm_jobs(company_id, due_at);
CREATE UNIQUE INDEX idx_pm_jobs_one_open ON pm_jobs(plan_id) WHERE status='open';
