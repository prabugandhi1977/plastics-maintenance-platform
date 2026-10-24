-- Hand-off to MouldCare: an approved draft is sent there as a breakdown ticket. The result is kept on the draft:
-- the MouldCare ticket id, sent / failed / not_configured, the last error, when it was sent, and the attempts so far
-- (failed sends are retried by a background job up to a limit; Retry on the draft always sends again).
ALTER TABLE ticket_drafts ADD COLUMN mouldcare_ticket_id TEXT;
ALTER TABLE ticket_drafts ADD COLUMN mouldcare_status TEXT CHECK(mouldcare_status IN ('sent','failed','not_configured'));
ALTER TABLE ticket_drafts ADD COLUMN mouldcare_error TEXT;
ALTER TABLE ticket_drafts ADD COLUMN mouldcare_sent_at INTEGER;
ALTER TABLE ticket_drafts ADD COLUMN mouldcare_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ticket_drafts ADD COLUMN mouldcare_attempted_at INTEGER;
CREATE INDEX ticket_drafts_by_mouldcare ON ticket_drafts(mouldcare_status);
