-- AI second opinion on vision incidents. Claude looks at the incident's snapshot and says whether it supports what the
-- detector reported. It is advice only: it never changes an incident's status. A company opts in (snapshots can show
-- employees): 'off' (default), 'manual' (a button on the incident) or 'auto' (also reviews new non-critical incidents).
ALTER TABLE companies ADD COLUMN vision_ai_review TEXT NOT NULL DEFAULT 'off' CHECK(vision_ai_review IN ('off','manual','auto'));

CREATE TABLE IF NOT EXISTS vision_reviews (
  event_id TEXT PRIMARY KEY REFERENCES vision_events(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id),
  verdict TEXT NOT NULL CHECK(verdict IN ('confirmed','doubtful','unclear')),
  reason TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('manual','auto')),
  requested_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_vision_reviews_company ON vision_reviews(company_id,created_at);
