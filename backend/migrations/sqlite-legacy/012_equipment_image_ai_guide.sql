-- Equipment picture, and AI-assisted breakdown guidance.
-- equipment.image_attachment_id points at an uploaded photo shown on the asset, its tickets and in the field app.
-- ticket_assistant_messages is the shared troubleshooting conversation on a ticket (kept for the record).
-- ticket_guides holds the step-by-step repair guide shown in the guide and VR views (AI-written, or the standard one).
ALTER TABLE equipment ADD COLUMN image_attachment_id TEXT REFERENCES attachments(id);
CREATE TABLE IF NOT EXISTS ticket_assistant_messages (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_assistant_ticket ON ticket_assistant_messages(ticket_id,created_at);
CREATE TABLE IF NOT EXISTS ticket_guides (ticket_id TEXT PRIMARY KEY REFERENCES tickets(id), guide TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('ai','standard')), created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
