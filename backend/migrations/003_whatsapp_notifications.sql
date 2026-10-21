-- WhatsApp notifications: each user opts in separately (off by default; needs a phone number in E.164 form), and the
-- outbox can now also carry ticket messages (assigned to you, your ticket completed), not only alert messages.
ALTER TABLE users ADD COLUMN alert_whatsapp BIGINT NOT NULL DEFAULT 0 CHECK (alert_whatsapp IN (0,1));
ALTER TABLE notification_outbox ADD COLUMN ticket_id TEXT REFERENCES tickets(id) DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX idx_notification_outbox_queue ON notification_outbox(channel, status, created_at);
