-- Custom dashboards. A dashboard belongs to the person who built it and is personal until they share it with
-- everybody ('all') or with one role ('role' + share_role). The widgets are kept as one validated JSON list
-- (see dashboards.js); they reference machines and signals by id/key without a foreign key on purpose: when a machine
-- or signal is deleted the widget is kept and flagged as unavailable at read time, so nothing is lost silently.
CREATE TABLE dashboards (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  layout_json TEXT NOT NULL DEFAULT '{"columns":4}',
  widgets_json TEXT NOT NULL DEFAULT '[]',
  share TEXT NOT NULL DEFAULT 'private' CHECK(share IN ('private','all','role')),
  share_role TEXT CHECK(share_role IN ('viewer','engineer')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK((share='role') = (share_role IS NOT NULL)));
CREATE INDEX dashboards_by_owner ON dashboards(owner_id);

-- A person's own landing dashboard. A row with no dashboard means "the built-in Overview", even when the super user
-- has set a default for everyone. The default for everyone is the setting 'default_dashboard'.
CREATE TABLE dashboard_prefs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  dashboard_id TEXT REFERENCES dashboards(id) ON DELETE CASCADE);
