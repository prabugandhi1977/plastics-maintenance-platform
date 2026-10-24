-- People who fix things, and who gets each ticket: service providers, more about each user (contact, skills,
-- whether they can still sign in), and the assignment on each ticket draft with how it was chosen.
CREATE TABLE service_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  contact_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  -- {"machineTypes": [...], "disciplines": [...]}, the same vocabulary as users' skills.
  skills TEXT NOT NULL DEFAULT '{}',
  -- Contracted response time, used to prefer a fast provider for urgent work.
  response_hours INTEGER,
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL);

ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN job_title TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN skills TEXT NOT NULL DEFAULT '{}';
-- A deactivated user cannot sign in and is not offered for assignment; their history stays.
ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
-- Set for a provider's own technicians.
ALTER TABLE users ADD COLUMN provider_id TEXT REFERENCES service_providers(id) ON DELETE SET NULL;

-- One assignee per draft: a user or a provider. source: manual, rules or ai. The suggestion made when the draft was
-- written is kept so the planner can accept it in one click.
ALTER TABLE ticket_drafts ADD COLUMN assigned_user_id TEXT REFERENCES users(id);
ALTER TABLE ticket_drafts ADD COLUMN assigned_provider_id TEXT REFERENCES service_providers(id);
ALTER TABLE ticket_drafts ADD COLUMN assignment_source TEXT;
ALTER TABLE ticket_drafts ADD COLUMN assignment_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE ticket_drafts ADD COLUMN assigned_by TEXT REFERENCES users(id);
ALTER TABLE ticket_drafts ADD COLUMN assigned_at INTEGER;
ALTER TABLE ticket_drafts ADD COLUMN suggestion_json TEXT;
CREATE INDEX ticket_drafts_by_assignee ON ticket_drafts(assigned_user_id, status);
